/**
 * Minimal IMS Operator
 * - Watches Tenant CRs in ims-system
 * - Reconciles tenant namespace resources: SA, ConfigMap, Deployments, Service, Ingress
 * - Expects provisioning API to create the DB secret in tenant namespace
 */

const k8s = require("@kubernetes/client-node");

const WATCH_NAMESPACE = process.env.WATCH_NAMESPACE || "ims-system";
const CRD_GROUP = "ims.example.com";
const CRD_VERSION = "v1";
const CRD_PLURAL = "tenants";
const FINALIZER = "ims.example.com/finalizer";

// Resource names inside each tenant namespace
const CONFIGMAP_NAME = "ims-config";
const IMS_API_NAME = "ims-api";
const WORKER_API_NAME = "worker-api";
const IMS_API_SVC_NAME = "ims-api";
const INGRESS_NAME = "ims-api-ingress";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function nowIso() {
  return new Date().toISOString();
}

function safeSlug(s) {
  return String(s || "").toLowerCase();
}

// K8s client
const kc = new k8s.KubeConfig();
try {
  kc.loadFromCluster();
} catch {
  kc.loadFromDefault();
}

const coreV1 = kc.makeApiClient(k8s.CoreV1Api);
const appsV1 = kc.makeApiClient(k8s.AppsV1Api);
const networkingV1 = kc.makeApiClient(k8s.NetworkingV1Api);
const customApi = kc.makeApiClient(k8s.CustomObjectsApi);

// ----- Helpers: create-or-patch patterns -----
async function ensureNamespace(ns, labels) {
  try {
    await coreV1.readNamespace(ns);
    // Patch labels (best-effort)
    await coreV1.patchNamespace(
      ns,
      { metadata: { labels } },
      undefined,
      undefined,
      undefined,
      undefined,
      { headers: { "Content-Type": "application/merge-patch+json" } }
    );
    return { created: false };
  } catch (e) {
    if (e?.response?.statusCode !== 404) throw e;
  }
  await coreV1.createNamespace({ metadata: { name: ns, labels } });
  return { created: true };
}

async function ensureServiceAccount(ns, name, labels) {
  try {
    await coreV1.readNamespacedServiceAccount(name, ns);
    await coreV1.patchNamespacedServiceAccount(
      name,
      ns,
      { metadata: { labels } },
      undefined,
      undefined,
      undefined,
      undefined,
      { headers: { "Content-Type": "application/merge-patch+json" } }
    );
    return { created: false };
  } catch (e) {
    if (e?.response?.statusCode !== 404) throw e;
  }
  await coreV1.createNamespacedServiceAccount(ns, {
    apiVersion: "v1",
    kind: "ServiceAccount",
    metadata: { name, namespace: ns, labels },
  });
  return { created: true };
}

async function ensureConfigMap(ns, name, data, labels) {
  try {
    await coreV1.readNamespacedConfigMap(name, ns);
    await coreV1.patchNamespacedConfigMap(
      name,
      ns,
      { data, metadata: { labels } },
      undefined,
      undefined,
      undefined,
      undefined,
      { headers: { "Content-Type": "application/merge-patch+json" } }
    );
    return { created: false };
  } catch (e) {
    if (e?.response?.statusCode !== 404) throw e;
  }
  await coreV1.createNamespacedConfigMap(ns, {
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: { name, namespace: ns, labels },
    data,
  });
  return { created: true };
}

async function secretExists(ns, name) {
  try {
    await coreV1.readNamespacedSecret(name, ns);
    return true;
  } catch (e) {
    if (e?.response?.statusCode === 404) return false;
    throw e;
  }
}

async function ensureDeployment(ns, name, spec, labels) {
  try {
    await appsV1.readNamespacedDeployment(name, ns);
    await appsV1.patchNamespacedDeployment(
      name,
      ns,
      { spec, metadata: { labels } },
      undefined,
      undefined,
      undefined,
      undefined,
      { headers: { "Content-Type": "application/merge-patch+json" } }
    );
    return { created: false };
  } catch (e) {
    if (e?.response?.statusCode !== 404) throw e;
  }

  await appsV1.createNamespacedDeployment(ns, {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name, namespace: ns, labels },
    spec,
  });
  return { created: true };
}

async function ensureService(ns, name, spec, labels) {
  try {
    await coreV1.readNamespacedService(name, ns);
    await coreV1.patchNamespacedService(
      name,
      ns,
      { spec, metadata: { labels } },
      undefined,
      undefined,
      undefined,
      undefined,
      { headers: { "Content-Type": "application/merge-patch+json" } }
    );
    return { created: false };
  } catch (e) {
    if (e?.response?.statusCode !== 404) throw e;
  }

  await coreV1.createNamespacedService(ns, {
    apiVersion: "v1",
    kind: "Service",
    metadata: { name, namespace: ns, labels },
    spec,
  });
  return { created: true };
}

async function ensureIngress(ns, name, spec, annotations, labels) {
  try {
    await networkingV1.readNamespacedIngress(name, ns);
    await networkingV1.patchNamespacedIngress(
      name,
      ns,
      { spec, metadata: { annotations, labels } },
      undefined,
      undefined,
      undefined,
      undefined,
      { headers: { "Content-Type": "application/merge-patch+json" } }
    );
    return { created: false };
  } catch (e) {
    if (e?.response?.statusCode !== 404) throw e;
  }

  await networkingV1.createNamespacedIngress(ns, {
    apiVersion: "networking.k8s.io/v1",
    kind: "Ingress",
    metadata: { name, namespace: ns, annotations, labels },
    spec,
  });
  return { created: true };
}

// ----- Tenant Status helpers -----
async function patchTenantStatus(name, statusPatch) {
  // Namespaced CR in ims-system
  // PATCH /status subresource
  return customApi.patchNamespacedCustomObjectStatus(
    CRD_GROUP,
    CRD_VERSION,
    WATCH_NAMESPACE,
    CRD_PLURAL,
    name,
    { status: statusPatch },
    undefined,
    undefined,
    undefined,
    { headers: { "Content-Type": "application/merge-patch+json" } }
  );
}

async function patchTenantMetadata(name, metadataPatch) {
  return customApi.patchNamespacedCustomObject(
    CRD_GROUP,
    CRD_VERSION,
    WATCH_NAMESPACE,
    CRD_PLURAL,
    name,
    { metadata: metadataPatch },
    undefined,
    undefined,
    undefined,
    { headers: { "Content-Type": "application/merge-patch+json" } }
  );
}

// ----- Reconcile logic -----
function labelsForTenant(tenantName) {
  return {
    "ims.example.com/managed": "true",
    "ims.example.com/tenant": tenantName,
    "app.kubernetes.io/part-of": "ims",
  };
}

function makeDeploymentSpec({
  appName,
  tenantName,
  replicas,
  image,
  containerPort,
  serviceAccountName,
  configMapName,
  secretName,
  resources,
  readinessPath = "/readyz",
  livenessPath = "/healthz",
}) {
  const selector = { app: appName, "ims.example.com/tenant": tenantName };
  return {
    replicas,
    selector: { matchLabels: selector },
    template: {
      metadata: { labels: selector },
      spec: {
        serviceAccountName,
        containers: [
          {
            name: appName,
            image,
            imagePullPolicy: "IfNotPresent",
            ports: [{ name: "http", containerPort }],
            envFrom: [
              { configMapRef: { name: configMapName } },
              { secretRef: { name: secretName } },
            ],
            resources: resources || undefined,
            readinessProbe: {
              httpGet: { path: readinessPath, port: "http" },
              initialDelaySeconds: 10,
              periodSeconds: 5,
            },
            livenessProbe: {
              httpGet: { path: livenessPath, port: "http" },
              initialDelaySeconds: 20,
              periodSeconds: 10,
            },
          },
        ],
      },
    },
  };
}

function makeServiceSpec({ tenantName, appName, port }) {
  return {
    type: "ClusterIP",
    selector: { app: appName, "ims.example.com/tenant": tenantName },
    ports: [{ name: "http", port, targetPort: "http", protocol: "TCP" }],
  };
}

function makeIngressSpec({ className, slug, serviceName, servicePort }) {
  const pathPrefix = `/${slug}`;
  // regex path: /acme(/|$)(.*)  rewrite: /$2
  return {
    ingressClassName: className || "nginx",
    rules: [
      {
        http: {
          paths: [
            {
              path: `${pathPrefix}(/|$)(.*)`,
              pathType: "ImplementationSpecific",
              backend: {
                service: {
                  name: serviceName,
                  port: { number: servicePort },
                },
              },
            },
          ],
        },
      },
    ],
  };
}

async function reconcileTenant(tenant) {
  const name = tenant.metadata.name;
  const spec = tenant.spec;
  const deletionTimestamp = tenant.metadata.deletionTimestamp;

  const tenantNs = spec.namespace;
  const slug = safeSlug(spec.slug);
  const labels = labelsForTenant(name);

  // Ensure finalizer
  const finalizers = tenant.metadata.finalizers || [];
  if (!finalizers.includes(FINALIZER) && !deletionTimestamp) {
    await patchTenantMetadata(name, { finalizers: [...finalizers, FINALIZER] });
  }

  // Handle deletion
  if (deletionTimestamp) {
    await patchTenantStatus(name, {
      phase: "Deleting",
      message: "Deleting tenant namespace",
      observedGeneration: tenant.metadata.generation,
      lastReconcileTime: nowIso(),
    });

    // Simplest: delete tenant namespace (garbage collects everything inside)
    try {
      await coreV1.deleteNamespace(tenantNs);
    } catch (e) {
      // ignore 404
      if (e?.response?.statusCode !== 404) throw e;
    }

    // Remove finalizer so Tenant CR can be deleted
    const newFinalizers = (tenant.metadata.finalizers || []).filter((f) => f !== FINALIZER);
    await patchTenantMetadata(name, { finalizers: newFinalizers });
    return;
  }

  await patchTenantStatus(name, {
    phase: "Reconciling",
    message: "Reconciling tenant resources",
    observedGeneration: tenant.metadata.generation,
    lastReconcileTime: nowIso(),
  });

  // 1) Namespace
  await ensureNamespace(tenantNs, labels);

  // 2) ServiceAccount
  const saName = spec.imsApi.serviceAccountName;
  await ensureServiceAccount(tenantNs, saName, labels);

  // 3) ConfigMap
  await ensureConfigMap(tenantNs, CONFIGMAP_NAME, spec.env || {}, labels);

  // 4) Secret must exist (created by provisioning API)
  const dbSecretName = spec.secretRefs.dbSecretName;
  const hasSecret = await secretExists(tenantNs, dbSecretName);
  if (!hasSecret) {
    await patchTenantStatus(name, {
      phase: "Error",
      message: `Missing secret "${dbSecretName}" in namespace "${tenantNs}"`,
      observedGeneration: tenant.metadata.generation,
      lastReconcileTime: nowIso(),
    });
    return;
  }

  // 5) ims-api Deployment + Service
  await ensureDeployment(
    tenantNs,
    IMS_API_NAME,
    makeDeploymentSpec({
      appName: IMS_API_NAME,
      tenantName: name,
      replicas: spec.imsApi.replicas,
      image: spec.imsApi.image,
      containerPort: spec.imsApi.containerPort,
      serviceAccountName: saName,
      configMapName: CONFIGMAP_NAME,
      secretName: dbSecretName,
      resources: spec.imsApi.resources,
    }),
    labels
  );

  await ensureService(
    tenantNs,
    IMS_API_SVC_NAME,
    makeServiceSpec({
      tenantName: name,
      appName: IMS_API_NAME,
      port: spec.imsApi.containerPort, // service port same as container for simplicity
    }),
    labels
  );

  // 6) Ingress (optional)
  if (spec.ingress?.enabled) {
    const className = spec.ingress.className || "nginx";
    const annotations = {
      "nginx.ingress.kubernetes.io/use-regex": "true",
      "nginx.ingress.kubernetes.io/rewrite-target": "/$2",
    };

    await ensureIngress(
      tenantNs,
      INGRESS_NAME,
      makeIngressSpec({
        className,
        slug,
        serviceName: IMS_API_SVC_NAME,
        servicePort: spec.imsApi.containerPort,
      }),
      annotations,
      labels
    );
  }

  // 7) worker-api Deployment (Service optional)
  await ensureDeployment(
    tenantNs,
    WORKER_API_NAME,
    makeDeploymentSpec({
      appName: WORKER_API_NAME,
      tenantName: name,
      replicas: spec.workerApi.replicas,
      image: spec.workerApi.image,
      containerPort: spec.workerApi.containerPort,
      serviceAccountName: saName,
      configMapName: CONFIGMAP_NAME,
      secretName: dbSecretName,
      resources: spec.workerApi.resources,
    }),
    labels
  );

  // Mark Ready (simple heuristic: resources exist)
  await patchTenantStatus(name, {
    phase: "Ready",
    message: "Tenant reconciled",
    observedGeneration: tenant.metadata.generation,
    lastReconcileTime: nowIso(),
  });
}

// ----- Watch loop -----
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

      try {
        // Reconcile on ADDED/MODIFIED/DELETED
        if (["ADDED", "MODIFIED", "DELETED"].includes(type)) {
          await reconcileTenant(tenant);
        }
      } catch (err) {
        console.error(`Reconcile error for tenant "${name}":`, err?.body || err);
        // best-effort status update
        try {
          await patchTenantStatus(name, {
            phase: "Error",
            message: String(err?.message || err),
            observedGeneration: tenant.metadata.generation,
            lastReconcileTime: nowIso(),
          });
        } catch {}
      }
    },
    (err) => {
      console.error("Watch ended:", err);
      // restart watch on failure
      setTimeout(() => startWatch().catch(console.error), 2000);
    }
  );
}

startWatch().catch((e) => {
  console.error("Fatal operator error:", e);
  process.exit(1);
});