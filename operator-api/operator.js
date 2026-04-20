/**
 * IMS Operator - Helm-driven runtime reconciler
 * - Watches Tenant CRs in ims-system
 * - Ensures tenant namespace exists
 * - Verifies provisioning API created the DB secret in tenant namespace
 * - Installs/upgrades tenant runtime resources via Helm
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
const DEFAULT_HELM_CHART_PATH = process.env.HELM_CHART_PATH || "tenant-app-deploy/charts";

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
    if (!isNotFound(e)) throw e;
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
    if (isNotFound(e)) return false;
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

function buildHelmValues(tenant) {
  const name = tenant.metadata.name;
  const spec = tenant.spec || {};
  const slug = spec.slug || name;

  const helmValues = { ...(spec.helm?.values || {}) };

  helmValues.tenant = {
    ...(helmValues.tenant || {}),
    name,
    slug,
  };

  helmValues.secretRefs = {
    ...(helmValues.secretRefs || {}),
    existingSecretName:
      helmValues.secretRefs?.existingSecretName || spec.secretRefs?.dbSecretName,
  };

  return helmValues;
}

function getHelmConfig(tenant) {
  const name = tenant.metadata.name;
  const spec = tenant.spec || {};

  return {
    releaseName: spec.helm?.releaseName || `tenant-${name}`,
    chartPath: spec.helm?.chartPath || DEFAULT_HELM_CHART_PATH,
    values: buildHelmValues(tenant),
  };
}

function runCommand(cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
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

  if (value === null) return "null\n";
  if (typeof value === "string") return `${JSON.stringify(value)}\n`;
  if (typeof value === "number" || typeof value === "boolean") return `${String(value)}\n`;

  if (Array.isArray(value)) {
    if (value.length === 0) return "[]\n";
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
  if (entries.length === 0) return "{}\n";

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

async function helmUpgradeInstall({ releaseName, namespace, chartPath, values }) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tenant-values-"));
  const valuesPath = path.join(tmpDir, `${releaseName}.values.yaml`);

  try {
    fs.writeFileSync(valuesPath, yamlString(values), "utf8");

    return await runCommand("helm", [
      "upgrade",
      "--install",
      releaseName,
      chartPath,
      "--namespace",
      namespace,
      "--create-namespace",
      "-f",
      valuesPath,
    ]);
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }
}

async function helmUninstall(releaseName, namespace) {
  try {
    return await runCommand("helm", [
      "uninstall",
      releaseName,
      "--namespace",
      namespace,
    ]);
  } catch (e) {
    const combined = `${e?.stdout || ""}\n${e?.stderr || ""}\n${e?.message || ""}`;
    if (combined.toLowerCase().includes("release: not found")) return;
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

  const { releaseName, chartPath, values } = getHelmConfig(tenant);

  if (
    !deletionTimestamp &&
    finalizers.includes(FINALIZER) &&
    observedGeneration === currentGeneration
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
      if (!isNotFound(e)) throw e;
    }

    const newFinalizers = (tenant.metadata.finalizers || []).filter((f) => f !== FINALIZER);
    await patchTenantMetadata(name, newFinalizers);
    tenant.metadata.finalizers = newFinalizers;
    return;
  }

  await patchTenantStatusIfChanged(tenant, {
    phase: "Reconciling",
    message: "Ensuring namespace, secret, and Helm release",
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
    values,
  });

  await patchTenantStatusIfChanged(tenant, {
    phase: "Ready",
    message: "Tenant reconciled via Helm",
    observedGeneration: currentGeneration,
    lastReconcileTime: nowIso(),
  });
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
      if (!name) return;

      if (!["ADDED", "MODIFIED", "DELETED"].includes(type)) {
        return;
      }

      if (inFlight.has(name)) {
        return;
      }

      inFlight.add(name);
      try {
        await reconcileTenant(tenant);
      } catch (err) {
        console.error(`Reconcile error for tenant "${name}":`, err?.body || err);

        try {
          await patchTenantStatusIfChanged(tenant, {
            phase: "Error",
            message: String(err?.message || err),
            observedGeneration: tenant.metadata.generation,
            lastReconcileTime: nowIso(),
          });
        } catch {}
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

startWatch().catch((e) => {
  console.error("Fatal operator error:", e);
  process.exit(1);
});