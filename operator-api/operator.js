/**
 * IMS Operator - Helm-driven runtime reconciler
 * - Watches Tenant CRs in ims-system
 * - Ensures tenant namespace exists
 * - Verifies provisioning API created the DB secret in tenant namespace
 * - Installs/upgrades tenant runtime resources via Helm
 * - Uses operator-api/tenant-app-deploy/values.yaml as the chart default values source
 * - Applies only a small tenant-specific override file generated from the Tenant CR
 * - Handles finalizers/status updates and namespace deletion
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const k8s = require("@kubernetes/client-node");

const WATCH_NAMESPACE = process.env.WATCH_NAMESPACE || "ims-system";
const CRD_GROUP = "ims.example.com";
const CRD_VERSION = "v1";
const CRD_PLURAL = "tenants";
const FINALIZER = "ims.example.com/finalizer";

// tenant-app-deploy is stored under ROOTDIR/operator-api locally and should be copied
// into the operator container at /app/tenant-app-deploy.
const DEFAULT_HELM_CHART_PATH =
  process.env.HELM_CHART_PATH || "/app/tenant-app-deploy";

const HELM_BIN = process.env.HELM_BIN || "/usr/local/bin/helm";

const kc = new k8s.KubeConfig();
try {
  kc.loadFromCluster();
} catch {
  kc.loadFromDefault();
}

const coreV1 = kc.makeApiClient(k8s.CoreV1Api);
const customApi = kc.makeApiClient(k8s.CustomObjectsApi);

const inFlight = new Set();

function nowIso() {
  return new Date().toISOString();
}

function isNotFound(err) {
  return (
    err?.response?.statusCode === 404 ||
    err?.statusCode === 404 ||
    err?.status === 404 ||
    err?.code === 404 ||
    err?.body?.code === 404 ||
    (err?.body?.status === "Failure" && err?.body?.reason === "NotFound") ||
    String(err?.message || "").toLowerCase().includes("not found")
  );
}

function withResourceVersion(body, existing) {
  return {
    ...body,
    metadata: {
      ...(body.metadata || {}),
      resourceVersion: existing?.metadata?.resourceVersion,
    },
  };
}

function sameStatusMeaningfully(currentStatus, nextStatus) {
  return (
    currentStatus?.phase === nextStatus?.phase &&
    currentStatus?.message === nextStatus?.message &&
    currentStatus?.observedGeneration === nextStatus?.observedGeneration
  );
}

async function ensureNamespace(ns, labels) {
  const desired = {
    apiVersion: "v1",
    kind: "Namespace",
    metadata: { name: ns, labels },
  };

  try {
    const existing = await coreV1.readNamespace({ name: ns });

    await coreV1.replaceNamespace({
      name: ns,
      body: withResourceVersion(desired, existing),
    });

    return { created: false };
  } catch (e) {
    if (!isNotFound(e)) {
      throw e;
    }
  }

  await coreV1.createNamespace({ body: desired });
  return { created: true };
}

async function secretExists(ns, name) {
  try {
    await coreV1.readNamespacedSecret({
      name,
      namespace: ns,
    });
    return true;
  } catch (e) {
    if (isNotFound(e)) {
      return false;
    }

    throw e;
  }
}

// JSON Patch is used because your cluster/client combination was parsing patch calls as jsonPatchOp arrays.
async function patchTenantStatus(name, statusPatch) {
  return await customApi.patchNamespacedCustomObjectStatus({
    group: CRD_GROUP,
    version: CRD_VERSION,
    namespace: WATCH_NAMESPACE,
    plural: CRD_PLURAL,
    name,
    body: [
      {
        op: "add",
        path: "/status",
        value: statusPatch,
      },
    ],
  });
}

async function patchTenantStatusIfChanged(tenant, statusPatch) {
  if (sameStatusMeaningfully(tenant.status, statusPatch)) {
    return false;
  }

  await patchTenantStatus(tenant.metadata.name, statusPatch);

  tenant.status = {
    ...(tenant.status || {}),
    ...statusPatch,
  };

  return true;
}

async function patchTenantMetadata(name, finalizers) {
  return await customApi.patchNamespacedCustomObject({
    group: CRD_GROUP,
    version: CRD_VERSION,
    namespace: WATCH_NAMESPACE,
    plural: CRD_PLURAL,
    name,
    body: [
      {
        op: "add",
        path: "/metadata/finalizers",
        value: finalizers,
      },
    ],
  });
}

function labelsForTenant(tenantName) {
  return {
    "ims.example.com/managed": "true",
    "ims.example.com/tenant": tenantName,
    "app.kubernetes.io/part-of": "ims",
  };
}

function assertHelmChart(chartPath) {
  const chartYamlPath = path.join(chartPath, "Chart.yaml");
  const valuesYamlPath = path.join(chartPath, "values.yaml");
  const oldCaseValuesPath = path.join(chartPath, "values.YAML");

  if (!fs.existsSync(chartYamlPath)) {
    throw new Error(`Helm Chart.yaml not found at ${chartYamlPath}`);
  }

  if (!fs.existsSync(valuesYamlPath)) {
    const extraHint = fs.existsSync(oldCaseValuesPath)
      ? ` Found ${oldCaseValuesPath}, but Helm expects values.yaml on Linux/container filesystems.`
      : "";

    throw new Error(
      `Helm values.yaml not found at ${valuesYamlPath}.${extraHint} ` +
        "Rename values.YAML to values.yaml and rebuild/redeploy the operator image."
    );
  }

  return {
    chartYamlPath,
    valuesYamlPath,
  };
}

/**
 * Build only tenant-specific Helm overrides.
 *
 * This intentionally does NOT copy the full spec.helm.values object.
 * Old Tenant CRs may still contain stale fields like ingress.enabled or image tags.
 * Copying those fields would keep overriding operator-api/tenant-app-deploy/values.yaml.
 *
 * The provisioner should send only minimal tenant-specific values, such as:
 *
 * spec:
 *   helm:
 *     values:
 *       tenant:
 *         name: acme
 *         slug: acme
 *       secretRefs:
 *         existingSecretName: ims-db-secret
 *       serviceAccount:
 *         name: tenant-acme-app
 *       config:
 *         DB_NAME: ims_acme
 */
function buildHelmValues(tenant) {
  const name = tenant.metadata.name;
  const spec = tenant.spec || {};
  const slug = spec.slug || name;
  const requestedValues = spec.helm?.values || {};

  const helmValues = {
    tenant: {
      name,
      slug,
    },
  };

  const existingSecretName =
    spec.secretRefs?.dbSecretName ||
    requestedValues.secretRefs?.existingSecretName;

  if (existingSecretName) {
    helmValues.secretRefs = {
      existingSecretName,
    };
  }

  const serviceAccountName =
    requestedValues.serviceAccount?.name || `tenant-${slug}-app`;

  helmValues.serviceAccount = {
    name: serviceAccountName,
  };

  /**
   * Tenant DB name mapping.
   *
   * The chart templates may read different value paths:
   * - config.DB_NAME
   * - connectionPooler.config.DB_NAME
   * - imsApi.env.POSTGRES_DB
   *
   * Helm does not automatically copy config.DB_NAME into those nested paths.
   * This operator maps one provisioner value into all required chart paths.
   */
  const tenantDbName = requestedValues.config?.DB_NAME;

  if (tenantDbName) {
    helmValues.config = {
      DB_NAME: tenantDbName,
    };

    helmValues.connectionPooler = {
      config: {
        DB_NAME: tenantDbName,
      },
    };

    helmValues.imsApi = {
      env: {
        POSTGRES_DB: tenantDbName,
      },
    };
  }

  return helmValues;
}

function getHelmConfig(tenant) {
  const name = tenant.metadata.name;
  const spec = tenant.spec || {};
  const chartPath = spec.helm?.chartPath || DEFAULT_HELM_CHART_PATH;
  const { valuesYamlPath } = assertHelmChart(chartPath);

  return {
    releaseName: spec.helm?.releaseName || `tenant-${name}`,
    chartPath,
    baseValuesPath: valuesYamlPath,
    values: buildHelmValues(tenant),
  };
}

function runCommand(cmd, args, options = {}) {
  console.log("runCommand debug", {
    cmd,
    args,
    cwd: options.cwd || process.cwd(),
    pathEnv: (options.env || process.env).PATH,
  });

  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...(options.env || {}) },
      ...options,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });

    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });

    child.on("error", reject);

    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr, code });
      } else {
        const err = new Error(
          `${cmd} exited with code ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`
        );
        err.code = code;
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
      }
    });
  });
}

function yamlString(value, indent = 0) {
  const sp = " ".repeat(indent);

  if (value === null) {
    return "null\n";
  }

  if (typeof value === "string") {
    return `${JSON.stringify(value)}\n`;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return `${String(value)}\n`;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return "[]\n";
    }

    return value
      .map((item) => {
        if (item !== null && typeof item === "object" && !Array.isArray(item)) {
          const inner = yamlString(item, indent + 2);
          return `${sp}- ${inner.replace(/^/gm, "  ").trimStart()}\n`;
        }

        return `${sp}- ${yamlString(item, 0).trimEnd()}\n`;
      })
      .join("");
  }

  const entries = Object.entries(value);
  if (entries.length === 0) {
    return "{}\n";
  }

  return entries
    .map(([k, v]) => {
      if (v !== null && typeof v === "object") {
        const inner = yamlString(v, indent + 2);
        return `${sp}${k}:\n${inner}`;
      }

      return `${sp}${k}: ${yamlString(v, 0)}`;
    })
    .join("");
}

async function helmUpgradeInstall({
  releaseName,
  namespace,
  chartPath,
  baseValuesPath,
  values,
}) {
  assertHelmChart(chartPath);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tenant-values-"));
  const valuesPath = path.join(tmpDir, `${releaseName}.values.yaml`);

  try {
    fs.writeFileSync(valuesPath, yamlString(values), "utf8");

    console.log("Helm chart path:", chartPath);
    console.log("Helm base values path:", baseValuesPath);
    console.log("Helm tenant override values path:", valuesPath);
    console.log(
      "Helm tenant override values:\n" + fs.readFileSync(valuesPath, "utf8")
    );

    return await runCommand(
      HELM_BIN,
      [
        "upgrade",
        "--install",
        releaseName,
        chartPath,
        "--namespace",
        namespace,
        "--create-namespace",
        "--reset-values",
        "-f",
        baseValuesPath,
        "-f",
        valuesPath,
      ],
      {
        env: { ...process.env },
      }
    );
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }
}

async function helmUninstall(releaseName, namespace) {
  try {
    return await runCommand(HELM_BIN, [
      "uninstall",
      releaseName,
      "--namespace",
      namespace,
    ]);
  } catch (e) {
    const combined = `${e?.stdout || ""}\n${e?.stderr || ""}\n${
      e?.message || ""
    }`;

    if (combined.toLowerCase().includes("release: not found")) {
      return;
    }

    throw e;
  }
}

async function reconcileTenant(tenant) {
  const name = tenant.metadata.name;
  const spec = tenant.spec || {};
  const deletionTimestamp = tenant.metadata.deletionTimestamp;
  const tenantNs = spec.namespace;
  const labels = labelsForTenant(name);
  const finalizers = tenant.metadata.finalizers || [];
  const observedGeneration = tenant.status?.observedGeneration;
  const currentGeneration = tenant.metadata.generation;

  if (!tenantNs) {
    throw new Error(`Tenant "${name}" is missing spec.namespace`);
  }

  const dbSecretName = spec.secretRefs?.dbSecretName;
  if (!dbSecretName) {
    throw new Error(`Tenant "${name}" is missing spec.secretRefs.dbSecretName`);
  }

  const { releaseName, chartPath, baseValuesPath, values } =
    getHelmConfig(tenant);

  /**
   * Do not skip tenants in Error state. This lets a fixed operator/chart retry existing CRs.
   * We only skip if this exact generation is already Ready.
   */
  if (
    !deletionTimestamp &&
    finalizers.includes(FINALIZER) &&
    observedGeneration === currentGeneration &&
    tenant.status?.phase === "Ready"
  ) {
    return;
  }

  if (!finalizers.includes(FINALIZER) && !deletionTimestamp) {
    await patchTenantMetadata(name, [...finalizers, FINALIZER]);
    tenant.metadata.finalizers = [...finalizers, FINALIZER];
  }

  if (deletionTimestamp) {
    await patchTenantStatusIfChanged(tenant, {
      phase: "Deleting",
      message: "Uninstalling Helm release and deleting tenant namespace",
      observedGeneration: currentGeneration,
      lastReconcileTime: nowIso(),
    });

    await helmUninstall(releaseName, tenantNs);

    try {
      await coreV1.deleteNamespace({ name: tenantNs });
    } catch (e) {
      if (!isNotFound(e)) {
        throw e;
      }
    }

    const newFinalizers = (tenant.metadata.finalizers || []).filter(
      (f) => f !== FINALIZER
    );

    await patchTenantMetadata(name, newFinalizers);
    tenant.metadata.finalizers = newFinalizers;
    return;
  }

  await patchTenantStatusIfChanged(tenant, {
    phase: "Reconciling",
    message: "Ensuring namespace, secret, and Helm release using chart values.yaml",
    observedGeneration: currentGeneration,
    lastReconcileTime: nowIso(),
  });

  await ensureNamespace(tenantNs, labels);

  const hasSecret = await secretExists(tenantNs, dbSecretName);
  if (!hasSecret) {
    await patchTenantStatusIfChanged(tenant, {
      phase: "Error",
      message: `Missing secret "${dbSecretName}" in namespace "${tenantNs}"`,
      observedGeneration: currentGeneration,
      lastReconcileTime: nowIso(),
    });
    return;
  }

  await helmUpgradeInstall({
    releaseName,
    namespace: tenantNs,
    chartPath,
    baseValuesPath,
    values,
  });

  console.log("Helm upgrade/install successful");

  await patchTenantStatusIfChanged(tenant, {
    phase: "Ready",
    message: "Tenant reconciled via Helm using chart values.yaml",
    observedGeneration: currentGeneration,
    lastReconcileTime: nowIso(),
  });

  console.log("Tenant status updated to Ready");
}

async function listExistingTenants() {
  const result = await customApi.listNamespacedCustomObject({
    group: CRD_GROUP,
    version: CRD_VERSION,
    namespace: WATCH_NAMESPACE,
    plural: CRD_PLURAL,
  });

  const tenants = result?.body?.items || result?.items || [];

  console.log(
    `Found ${tenants.length} existing Tenant CR(s) in namespace "${WATCH_NAMESPACE}"`
  );

  return tenants;
}

async function reconcileExistingTenants() {
  const tenants = await listExistingTenants();

  for (const tenant of tenants) {
    const name = tenant?.metadata?.name;
    if (!name) {
      continue;
    }

    if (inFlight.has(name)) {
      continue;
    }

    inFlight.add(name);

    try {
      console.log(`Reconciling existing Tenant "${name}" on operator startup`);
      await reconcileTenant(tenant);
    } catch (err) {
      if (isNotFound(err)) {
        console.log(
          `Tenant "${name}" no longer exists during startup reconcile; ignoring.`
        );
      } else {
        console.error(
          `Startup reconcile error for tenant "${name}":`,
          err?.body || err
        );

        try {
          await patchTenantStatusIfChanged(tenant, {
            phase: "Error",
            message: String(err?.message || err),
            observedGeneration: tenant.metadata.generation,
            lastReconcileTime: nowIso(),
          });
        } catch (statusErr) {
          if (isNotFound(statusErr)) {
            console.log(
              `Tenant "${name}" disappeared before startup status update; ignoring.`
            );
          } else {
            console.error(
              `Failed to patch startup error status for tenant "${name}":`,
              statusErr?.body || statusErr
            );
          }
        }
      }
    } finally {
      inFlight.delete(name);
    }
  }
}

async function startWatch() {
  const watch = new k8s.Watch(kc);

  console.log(`Watching Tenants in namespace "${WATCH_NAMESPACE}"...`);

  await watch.watch(
    `/apis/${CRD_GROUP}/${CRD_VERSION}/namespaces/${WATCH_NAMESPACE}/${CRD_PLURAL}`,
    {},
    async (type, obj) => {
      const tenant = obj;
      const name = tenant?.metadata?.name;
      if (!name) {
        return;
      }

      /**
       * Finalizer cleanup is handled during MODIFIED events where deletionTimestamp is set.
       * By the time the final DELETED event arrives, the object no longer exists, so status
       * patches can fail with "Tenant not found".
       */
      if (type === "DELETED") {
        console.log(
          `Tenant "${name}" was deleted; ignoring final DELETED watch event.`
        );
        return;
      }

      if (!["ADDED", "MODIFIED"].includes(type)) {
        return;
      }

      if (inFlight.has(name)) {
        return;
      }

      inFlight.add(name);

      try {
        await reconcileTenant(tenant);
      } catch (err) {
        if (isNotFound(err)) {
          console.log(
            `Tenant "${name}" no longer exists; skipping reconcile/status update.`
          );
        } else {
          console.error(`Reconcile error for tenant "${name}":`, err?.body || err);

          try {
            await patchTenantStatusIfChanged(tenant, {
              phase: "Error",
              message: String(err?.message || err),
              observedGeneration: tenant.metadata.generation,
              lastReconcileTime: nowIso(),
            });
          } catch (statusErr) {
            if (isNotFound(statusErr)) {
              console.log(
                `Tenant "${name}" disappeared before status update; ignoring.`
              );
            } else {
              console.error(
                `Failed to patch error status for tenant "${name}":`,
                statusErr?.body || statusErr
              );
            }
          }
        }
      } finally {
        inFlight.delete(name);
      }
    },
    (err) => {
      console.error("Watch ended:", err);
      setTimeout(() => startWatch().catch(console.error), 2000);
    }
  );
}

async function main() {
  console.log("Starting IMS operator...");

  await reconcileExistingTenants();

  await startWatch();
}

main().catch((e) => {
  console.error("Fatal operator error:", e);
  process.exit(1);
});