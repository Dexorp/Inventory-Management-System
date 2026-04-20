/**
 * Minimal Provisioning API
 * POST /provision-tenant
 *
 * Body:
 * {
 *   "name": "acme",
 *   "dbPassword": "supersecret",
 *   "dbName": "ims_acme",
 *   "images": {
 *     "imsApi": "joforrester/ims-api:latest",
 *     "workerApi": "joforrester/worker-api:latest"
 *   }
 * }
 */

const express = require("express");
const k8s = require("@kubernetes/client-node");

const app = express();
app.use(express.json());

// ---- Config ----
const PORT = process.env.PORT || 8080;
const IMS_SYSTEM_NAMESPACE = process.env.TENANT_SYSTEM_NAMESPACE || "ims-system";
const TENANT_NS_PREFIX = process.env.TENANT_NS_PREFIX || "warehouse-tenant-";
const DB_SECRET_NAME = process.env.TENANT_DB_SECRET_NAME || "ims-db-secret";
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || ""; // optional simple auth

// CRD details
const CRD_GROUP = "ims.example.com";
const CRD_VERSION = "v1";
const CRD_PLURAL = "tenants"; // plural name in CRD

// ---- K8s client ----
const kc = new k8s.KubeConfig();
// Use in-cluster config when running in K8s, otherwise fall back to default kubeconfig
try {
  kc.loadFromCluster();
} catch {
  kc.loadFromDefault();
}

const coreV1 = kc.makeApiClient(k8s.CoreV1Api);
const customApi = kc.makeApiClient(k8s.CustomObjectsApi);

// ---- Helpers ----
function requireAdmin(req, res) {
  if (!ADMIN_API_KEY) return true; // allow if not set (dev)
  const headerKey = req.header("x-api-key");
  if (headerKey !== ADMIN_API_KEY) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}

function slugify(name) {
  // strict RFC1123-ish: lowercase, digits, dash
  const s = String(name).trim().toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-");
  if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(s)) {
    throw new Error(`Invalid tenant name/slug "${name}" -> "${s}"`);
  }
  return s;
}

async function ensureNamespace(nsName, labels = {}) {
  try {
    await coreV1.readNamespace(nsName);
    return { created: false };
  } catch (e) {
    if (e?.response?.statusCode !== 404) throw e;
  }

  await coreV1.createNamespace({
    metadata: { name: nsName, labels },
  });

  return { created: true };
}

async function upsertSecret(namespace, name, stringData) {
  // Create if missing, otherwise patch
  try {
    await coreV1.readNamespacedSecret(name, namespace);
    // Patch to update values
    await coreV1.patchNamespacedSecret(
      name,
      namespace,
      { stringData, type: "Opaque" },
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

  await coreV1.createNamespacedSecret(namespace, {
    apiVersion: "v1",
    kind: "Secret",
    metadata: { name },
    type: "Opaque",
    stringData,
  });

  return { created: true };
}

async function createTenantCR(tenantName, tenantSpec) {
  // Namespaced CR in ims-system
  return customApi.createNamespacedCustomObject(
    CRD_GROUP,
    CRD_VERSION,
    IMS_SYSTEM_NAMESPACE,
    CRD_PLURAL,
    {
      apiVersion: `${CRD_GROUP}/${CRD_VERSION}`,
      kind: "Tenant",
      metadata: {
        name: tenantName,
        namespace: IMS_SYSTEM_NAMESPACE,
      },
      spec: tenantSpec,
    }
  );
}

// ---- Endpoint ----
app.post("/provision-tenant", async (req, res) => {
  if (!requireAdmin(req, res)) return;

  try {
    const name = slugify(req.body?.name);
    const tenantNamespace = `${TENANT_NS_PREFIX}${name}`;

    const dbPassword = req.body?.dbPassword;
    const dbName = req.body?.dbName || `ims_${name}`;
    if (!dbPassword) {
      return res.status(400).json({ error: "dbPassword is required" });
    }

    const imsApiImage = req.body?.images?.imsApi || "joforrester/ims-api:latest";
    const workerApiImage = req.body?.images?.workerApi || "joforrester/worker-api:latest";

    // 1) Namespace
    const nsResult = await ensureNamespace(tenantNamespace, {
      "ims.example.com/tenant": name,
      "ims.example.com/managed": "true",
    });

    // 2) Secret in tenant namespace
    const secretResult = await upsertSecret(tenantNamespace, DB_SECRET_NAME, {
      DB_PASSWORD: String(dbPassword),
    });

    // 3) Tenant CR in ims-system (operator reconciles the rest)
    const tenantCRSpec = {
      namespace: tenantNamespace,
      slug: name,
      ingress: {
        enabled: true,
        className: "nginx",
        pathPrefix: `/${name}`,
        rewrite: { enabled: true },
      },
      imsApi: {
        image: imsApiImage,
        replicas: 2,
        serviceAccountName: `tenant-${name}-app`,
        containerPort: 3000,
      },
      workerApi: {
        image: workerApiImage,
        replicas: 1,
        serviceAccountName: `tenant-${name}-app`,
        containerPort: 3001,
      },
      env: {
        NODE_ENV: "production",
        DB_HOST: process.env.DB_HOST || "10.0.0.12",
        DB_PORT: process.env.DB_PORT || "5432",
        DB_USER: process.env.DB_USER || "ims-user",
        DB_NAME: dbName,
        REDIS_HOST: process.env.REDIS_HOST || "redis-master.ims.svc.cluster.local",
        REDIS_PORT: process.env.REDIS_PORT || "6379",
        KAFKA_BROKERS: process.env.KAFKA_BROKERS || "YOUR_EXTERNAL_KAFKA:9092",
      },
      secretRefs: {
        dbSecretName: DB_SECRET_NAME,
      },
    };

    const crResp = await createTenantCR(name, tenantCRSpec);

    res.status(201).json({
      tenant: name,
      tenantNamespace,
      namespaceCreated: nsResult.created,
      secretCreated: secretResult.created,
      tenantCR: {
        name,
        namespace: IMS_SYSTEM_NAMESPACE,
      },
      crStatus: crResp?.response?.statusCode || 201,
    });
  } catch (err) {
    const status = err?.response?.statusCode || 500;
    const body = err?.response?.body;
    res.status(status).json({
      error: String(err?.message || err),
      details: body || null,
    });
  }
});

app.get("/healthz", (_req, res) => res.status(200).json({ ok: true }));
app.get("/readyz", (_req, res) => res.status(200).json({ ready: true }));

app.listen(PORT, () => {
  console.log(`Provisioner listening on port ${PORT}`);
});