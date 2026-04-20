/**
 * Minimal Provisioning API
 * POST /provision-tenant
 * DELETE /deprovision-tenant/:name
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
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || "";

// CRD details
const CRD_GROUP = "ims.example.com";
const CRD_VERSION = "v1";
const CRD_PLURAL = "tenants";

// ---- K8s client ----
const kc = new k8s.KubeConfig();
try {
  kc.loadFromCluster();
} catch {
  kc.loadFromDefault();
}

const coreV1 = kc.makeApiClient(k8s.CoreV1Api);
const customApi = kc.makeApiClient(k8s.CustomObjectsApi);

// ---- Helpers ----
function requireAdmin(req, res) {
  if (!ADMIN_API_KEY) return true;
  const headerKey = req.header("x-api-key");
  if (headerKey !== ADMIN_API_KEY) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}

function slugify(name) {
  const s = String(name)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-");

  if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(s)) {
    throw new Error(`Invalid tenant name/slug "${name}" -> "${s}"`);
  }
  return s;
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

async function ensureNamespace(nsName, labels = {}) {
  console.log("Trying to ensure Namespace:", nsName, "labels:", labels);

  try {
    await coreV1.readNamespace({ name: nsName });
    return { created: false };
  } catch (e) {
    await coreV1.createNamespace({
      body: {
        metadata: { name: nsName, labels },
      },
    });
    return { created: true };
  }
}

async function upsertSecret(namespace, name, stringData) {
  console.log("Verifying secret params", { name, namespace });

  try {
    await coreV1.readNamespacedSecret({ name, namespace });

    await coreV1.patchNamespacedSecret(
      {
        name,
        namespace,
        body: {
          stringData,
          type: "Opaque",
        },
      },
      undefined,
      {
        headers: { "Content-Type": "application/merge-patch+json" },
      }
    );
  } catch (e) {
    console.log("Secret not found, creating new one");

    await coreV1.createNamespacedSecret({
      namespace,
      body: {
        apiVersion: "v1",
        kind: "Secret",
        metadata: { name },
        type: "Opaque",
        stringData,
      },
    });
  }

  return { created: true };
}

async function createTenantCR(tenantName, tenantSpec) {
  console.log("Creating Tenant CR in", IMS_SYSTEM_NAMESPACE, "with name:", tenantName);

  const x = await customApi.createNamespacedCustomObject({
    group: CRD_GROUP,
    version: CRD_VERSION,
    namespace: IMS_SYSTEM_NAMESPACE,
    plural: CRD_PLURAL,
    body: {
      apiVersion: `${CRD_GROUP}/${CRD_VERSION}`,
      kind: "Tenant",
      metadata: {
        name: tenantName,
        namespace: IMS_SYSTEM_NAMESPACE,
      },
      spec: tenantSpec,
    },
  });

  console.log("Tenant CR creation response:", x?.response?.statusCode);
  return x;
}

async function deleteTenantCR(tenantName) {
  console.log("Requesting deletion of Tenant CR", tenantName, "in", IMS_SYSTEM_NAMESPACE);

  return await customApi.deleteNamespacedCustomObject({
    group: CRD_GROUP,
    version: CRD_VERSION,
    namespace: IMS_SYSTEM_NAMESPACE,
    plural: CRD_PLURAL,
    name: tenantName,
    body: {
      propagationPolicy: "Foreground",
    },
  });
}

// ---- Endpoint ----
app.post("/provision-tenant", async (req, res) => {
  if (!requireAdmin(req, res)) return;

  try {
    const rawName = req.body?.name;
    if (!rawName || typeof rawName !== "string") {
      return res.status(400).json({ error: "name is required" });
    }

    const name = slugify(rawName);
    const tenantNamespace = `${TENANT_NS_PREFIX}${name}`;

    const dbPassword = req.body?.dbPassword;
    const dbName = req.body?.dbName || `ims_${name}`;
    if (!dbPassword) {
      return res.status(400).json({ error: "dbPassword is required" });
    }

    const imsApiImage = req.body?.images?.imsApi || "joforrester/ims-api:latest";
    const workerApiImage = req.body?.images?.workerApi || "joforrester/worker-api:latest";

    const nsResult = await ensureNamespace(tenantNamespace, {
      "ims.example.com/tenant": name,
      "ims.example.com/managed": "true",
    });

    const secretResult = await upsertSecret(tenantNamespace, DB_SECRET_NAME, {
      DB_PASSWORD: String(dbPassword),
    });

    const tenantCRSpec = {
      namespace: tenantNamespace,
      slug: name,
      secretRefs: {
        dbSecretName: DB_SECRET_NAME,
      },
      helm: {
        releaseName: `tenant-${name}`,
        chartPath: process.env.HELM_CHART_PATH || "/tenant-app-deploy/charts/Chart.yaml",
        values: {
          tenant: {
            name,
            slug: name,
          },
          serviceAccount: {
            create: true,
            name: `tenant-${name}-app`,
          },
          ingress: {
            enabled: true,
            className: "nginx",
            path: `/${name}(/|$)(.*)`,
            pathType: "ImplementationSpecific",
            annotations: {
              "nginx.ingress.kubernetes.io/use-regex": "true",
              "nginx.ingress.kubernetes.io/rewrite-target": "/$2",
            },
          },
          config: {
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
            existingSecretName: DB_SECRET_NAME,
          },
          imsApi: {
            enabled: true,
            replicaCount: 2,
            image: {
              repository: imsApiImage.split(":")[0],
              tag: imsApiImage.includes(":") ? imsApiImage.split(":").slice(1).join(":") : "latest",
              pullPolicy: "Always",
            },
            service: {
              port: 3000,
            },
            containerPort: 3000,
          },
          workerApi: {
            enabled: true,
            replicaCount: 1,
            image: {
              repository: workerApiImage.split(":")[0],
              tag: workerApiImage.includes(":") ? workerApiImage.split(":").slice(1).join(":") : "latest",
              pullPolicy: "Always",
            },
            containerPort: 3001,
          },
        },
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

app.delete("/deprovision-tenant/:name", async (req, res) => {
  if (!requireAdmin(req, res)) return;

  try {
    const name = slugify(req.params?.name);
    const tenantNamespace = `${TENANT_NS_PREFIX}${name}`;

    const deleteResp = await deleteTenantCR(name);

    return res.status(202).json({
      tenant: name,
      tenantNamespace,
      tenantCR: {
        name,
        namespace: IMS_SYSTEM_NAMESPACE,
      },
      message: "Tenant deletion requested. Operator cleanup should begin via finalizer.",
      deleteStatus: deleteResp?.response?.statusCode || 202,
    });
  } catch (err) {
    if (isNotFound(err)) {
      return res.status(404).json({
        error: `Tenant "${req.params?.name}" not found`,
      });
    }

    const status = err?.response?.statusCode || 500;
    const body = err?.response?.body;
    return res.status(status).json({
      error: String(err?.message || err),
      details: body || null,
    });
  }
});

app.get("/healthz", (_req, res) => res.status(200).json({ ok: true }));
app.get("/readyz", (_req, res) => res.status(200).json({ ready: true, version: "1.0.0" }));

app.listen(PORT, () => {
  console.log(`Provisioner listening on port ${PORT}`);
});