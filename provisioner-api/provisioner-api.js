/**
 * Minimal Provisioning API
 * POST /provision-tenant
 * DELETE /deprovision-tenant/:name
 *
 * Important architecture rule:
 * - The provisioner does NOT own tenant-app-deploy/values.yaml.
 * - The Helm chart lives with the operator at operator-api/tenant-app-deploy.
 * - The provisioner only creates tenant-specific Kubernetes objects and a minimal Tenant CR.
 * - Chart defaults such as images, ingress defaults, replica counts, ports, Redis defaults,
 *   PgBouncer defaults, etc. should live in operator-api/tenant-app-deploy/values.yaml.
 *
 * Database provisioning:
 * - Uses DBHOST, DBPORT, DBUSER, and DBPASSWORD as PostgreSQL administrator credentials.
 * - Accepts dbName, dbUser, and dbUserPassword in the provisioning request body.
 * - Accepts dbName and dbUser in the deprovisioning request body.
 * - Creates or updates the tenant login role.
 * - Creates the tenant database when missing with the tenant role as its owner.
 * - Deletes the tenant database and login role during tenant deprovisioning.
 */

const express = require("express");
const k8s = require("@kubernetes/client-node");
const { Client } = require("pg");

const app = express();
app.use(express.json());

// ---- Config ----
const PORT = process.env.PORT || 8080;
const IMS_SYSTEM_NAMESPACE =
  process.env.TENANT_SYSTEM_NAMESPACE || "ims-system";
const TENANT_NS_PREFIX =
  process.env.TENANT_NS_PREFIX || "warehouse-tenant-";
const DB_SECRET_NAME =
  process.env.TENANT_DB_SECRET_NAME || "test-db";
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
  if (!ADMIN_API_KEY) {
    return true;
  }

  const headerKey = req.header("x-api-key");

  if (headerKey !== ADMIN_API_KEY) {
    res.status(401).json({
      error: "Unauthorized",
    });

    return false;
  }

  return true;
}

function createHttpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;

  return error;
}

function slugify(name) {
  const slug = String(name)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(slug)) {
    throw createHttpError(
      400,
      `Invalid tenant name/slug "${name}" -> "${slug}"`,
    );
  }

  return slug;
}

/**
 * Validates a value that will be used as a PostgreSQL identifier.
 *
 * Identifiers cannot be passed as normal PostgreSQL query parameters,
 * so they must be validated and safely quoted before use.
 */
function validatePostgresIdentifier(value, fieldName) {
  if (typeof value !== "string" || !value.trim()) {
    throw createHttpError(
      400,
      `${fieldName} is required and must be a non-empty string`,
    );
  }

  const identifier = value.trim();

  // PostgreSQL identifiers are limited to 63 bytes by default.
  if (Buffer.byteLength(identifier, "utf8") > 63) {
    throw createHttpError(
      400,
      `${fieldName} must be 63 bytes or fewer`,
    );
  }

  if (/\0|[\u0001-\u001f\u007f]/.test(identifier)) {
    throw createHttpError(
      400,
      `${fieldName} contains unsupported control characters`,
    );
  }

  return identifier;
}

function validateDatabasePassword(value) {
  if (typeof value !== "string" || value.length === 0) {
    throw createHttpError(
      400,
      "dbUserPassword is required and must be a non-empty string",
    );
  }

  return value;
}

/**
 * Prevents a tenant provisioning or deprovisioning request from modifying
 * important PostgreSQL databases or the administrator account used by the
 * provisioner.
 */
function validateTenantDatabaseTargets(dbName, dbUser) {
  const normalizedDatabase = dbName.toLowerCase();
  const normalizedUser = dbUser.toLowerCase();
  const adminUser = String(process.env.DBUSER || "").toLowerCase();

  const reservedDatabases = [
    "postgres",
    "template0",
    "template1",
  ];

  if (reservedDatabases.includes(normalizedDatabase)) {
    throw createHttpError(
      400,
      `dbName "${dbName}" is reserved and cannot be used for a tenant`,
    );
  }

  if (normalizedUser.startsWith("pg_")) {
    throw createHttpError(
      400,
      `dbUser "${dbUser}" uses PostgreSQL's reserved pg_ prefix`,
    );
  }

  if (adminUser && normalizedUser === adminUser) {
    throw createHttpError(
      400,
      "dbUser cannot be the PostgreSQL administrator account",
    );
  }
}

function getDatabaseAdminConfig() {
  const requiredEnvKeys = [
    "DBHOST",
    "DBPORT",
    "DBUSER",
    "DBPASSWORD",
  ];

  const missingEnvKeys = requiredEnvKeys.filter(
    (key) => !process.env[key],
  );

  if (missingEnvKeys.length > 0) {
    throw createHttpError(
      500,
      `Missing required PostgreSQL environment variables: ${missingEnvKeys.join(
        ", ",
      )}`,
    );
  }

  const port = Number(process.env.DBPORT);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw createHttpError(
      500,
      "DBPORT must be an integer between 1 and 65535",
    );
  }

  return {
    host: process.env.DBHOST,
    port,
    user: process.env.DBUSER,
    password: process.env.DBPASSWORD,

    // Connect to an existing administrative database before creating
    // or deleting a separate tenant database.
    database: "postgres",

    connectionTimeoutMillis: 10_000,
    application_name: "ims-provisioner-api",
  };
}

/**
 * Uses PostgreSQL's format() function to safely quote dynamic identifiers and
 * string values before executing DDL statements.
 *
 * Normal query parameters cannot be used for role names or database names.
 */
async function buildFormattedSql(
  client,
  formatString,
  values,
) {
  const placeholders = values
    .map((_, index) => `$${index + 2}::text`)
    .join(", ");

  const query = placeholders
    ? `SELECT format($1::text, ${placeholders}) AS sql`
    : "SELECT format($1::text) AS sql";

  const result = await client.query(
    query,
    [formatString, ...values],
  );

  return result.rows[0].sql;
}

/**
 * Creates the PostgreSQL database and login role for a tenant.
 *
 * This function is idempotent:
 *
 * - If the role is missing, it is created.
 * - If the role already exists, its password is updated.
 * - If the database is missing, it is created with the tenant role as owner.
 * - If the database exists and is already owned by the tenant role, it is kept.
 * - If the database exists but is owned by another role, provisioning fails.
 *
 * PostgreSQL databases and roles are removed by removeTenantDatabase()
 * during deprovisioning.
 */
async function initializeTenantDatabase({
  dbName,
  dbUser,
  dbUserPassword,
}) {
  const client = new Client(
    getDatabaseAdminConfig(),
  );

  const provisionerAdminUser =
    process.env.DBUSER;

  if (!provisionerAdminUser) {
    throw createHttpError(
      500,
      "DBUSER is required to initialize a tenant database",
    );
  }

  let advisoryLockAcquired = false;

  const result = {
    database: dbName,
    user: dbUser,
    roleCreated: false,
    databaseCreated: false,
  };

  const advisoryLockKey =
    `ims-provisioner:${dbName}:${dbUser}`;

  try {
    await client.connect();

    /**
     * Prevent simultaneous requests from creating, modifying,
     * or deleting the same tenant role and database.
     */
    await client.query(
      "SELECT pg_advisory_lock(hashtext($1))",
      [advisoryLockKey],
    );

    advisoryLockAcquired = true;

    // Check whether the tenant role already exists.
    const roleLookup = await client.query(
      `
        SELECT EXISTS (
          SELECT 1
          FROM pg_roles
          WHERE rolname = $1
        ) AS exists
      `,
      [dbUser],
    );

    const roleExists =
      roleLookup.rows[0]?.exists === true;

    // Check whether the tenant database already exists and get its owner.
    const databaseLookup = await client.query(
      `
        SELECT owner.rolname AS owner
        FROM pg_database AS tenant_database
        JOIN pg_roles AS owner
          ON owner.oid = tenant_database.datdba
        WHERE tenant_database.datname = $1
      `,
      [dbName],
    );

    const databaseExists =
      databaseLookup.rowCount > 0;

    /**
     * Do not silently transfer an existing database from another owner.
     */
    if (databaseExists) {
      const currentOwner =
        databaseLookup.rows[0].owner;

      if (currentOwner !== dbUser) {
        throw createHttpError(
          409,
          `Database "${dbName}" already exists and is owned by role "${currentOwner}"`,
        );
      }
    }

    /**
     * Create the tenant login role or update its password.
     */
    if (roleExists) {
      const alterRoleSql =
        await buildFormattedSql(
          client,
          "ALTER ROLE %I WITH LOGIN PASSWORD %L",
          [dbUser, dbUserPassword],
        );

      await client.query(alterRoleSql);
    } else {
      const createRoleSql =
        await buildFormattedSql(
          client,
          "CREATE ROLE %I WITH LOGIN PASSWORD %L",
          [dbUser, dbUserPassword],
        );

      await client.query(createRoleSql);

      result.roleCreated = true;
    }

    /**
     * Allow the provisioner administrator to SET ROLE to the
     * tenant role.
     *
     * PostgreSQL requires this when creating a database owned
     * by a role other than the currently connected role.
     *
     * Generated SQL:
     * GRANT "tenant-role" TO "provisioner-role" WITH SET TRUE
     *
     * Repeating GRANT is safe when the membership already exists.
     */
    const grantTenantRoleSql =
      await buildFormattedSql(
        client,
        "GRANT %I TO %I WITH SET TRUE",
        [dbUser, provisionerAdminUser],
      );

    await client.query(grantTenantRoleSql);

    /**
     * Create the tenant database if it does not already exist.
     *
     * CREATE DATABASE cannot run inside a transaction, so this
     * function intentionally does not use BEGIN/COMMIT.
     */
    if (!databaseExists) {
      const createDatabaseSql =
        await buildFormattedSql(
          client,
          "CREATE DATABASE %I OWNER %I",
          [dbName, dbUser],
        );

      await client.query(createDatabaseSql);

      result.databaseCreated = true;
    }

    console.log(
      "Tenant PostgreSQL resources initialized:",
      {
        database: dbName,
        user: dbUser,
        provisionerAdminUser,
        roleCreated:
          result.roleCreated,
        databaseCreated:
          result.databaseCreated,
      },
    );

    return result;
  } catch (error) {
    console.error(
      "Tenant PostgreSQL initialization failed:",
      {
        database: dbName,
        user: dbUser,
        provisionerAdminUser,
        code: error?.code,
        message: error?.message,
        detail: error?.detail,
        hint: error?.hint,
      },
    );

    throw error;
  } finally {
    if (advisoryLockAcquired) {
      try {
        await client.query(
          "SELECT pg_advisory_unlock(hashtext($1))",
          [advisoryLockKey],
        );
      } catch (unlockError) {
        console.error(
          "Failed to release PostgreSQL advisory lock:",
          unlockError,
        );
      }
    }

    try {
      await client.end();
    } catch (closeError) {
      console.error(
        "Failed to close PostgreSQL administrator connection:",
        closeError,
      );
    }
  }
}

/**
 * Removes a tenant PostgreSQL database and login role.
 *
 * This function is idempotent:
 *
 * - If the database is missing, it is treated as already removed.
 * - If the role is missing, it is treated as already removed.
 * - If the database exists, it must be owned by the expected tenant role.
 * - Active database connections are terminated with DROP DATABASE ... FORCE.
 * - The database is dropped before the role so ownership dependencies are removed.
 *
 * The function intentionally does not use dbUserPassword. The provisioner
 * authenticates with DBUSER and DBPASSWORD from its environment.
 */
async function removeTenantDatabase({
  dbName,
  dbUser,
}) {
  const client = new Client(
    getDatabaseAdminConfig(),
  );

  const provisionerAdminUser =
    process.env.DBUSER;

  if (!provisionerAdminUser) {
    throw createHttpError(
      500,
      "DBUSER is required to remove a tenant database",
    );
  }

  let advisoryLockAcquired = false;

  const result = {
    database: dbName,
    user: dbUser,
    databaseExisted: false,
    roleExisted: false,
    databaseDropped: false,
    roleDropped: false,
  };

  const advisoryLockKey =
    `ims-provisioner:${dbName}:${dbUser}`;

  try {
    await client.connect();

    /**
     * Use the same lock key as provisioning so a tenant cannot be
     * provisioned and deprovisioned at the same time.
     */
    await client.query(
      "SELECT pg_advisory_lock(hashtext($1))",
      [advisoryLockKey],
    );

    advisoryLockAcquired = true;

    const databaseLookup =
      await client.query(
        `
          SELECT owner.rolname AS owner
          FROM pg_database AS tenant_database
          JOIN pg_roles AS owner
            ON owner.oid = tenant_database.datdba
          WHERE tenant_database.datname = $1
        `,
        [dbName],
      );

    const databaseExists =
      databaseLookup.rowCount > 0;

    result.databaseExisted =
      databaseExists;

    if (databaseExists) {
      const currentOwner =
        databaseLookup.rows[0].owner;

      /**
       * Do not delete a database that is not owned by the expected
       * tenant role. This prevents a malformed request from deleting
       * another tenant's database.
       */
      if (currentOwner !== dbUser) {
        throw createHttpError(
          409,
          `Database "${dbName}" is owned by role "${currentOwner}", not "${dbUser}"`,
        );
      }

      /**
       * The provisioner was granted SET permission on the tenant role when
       * the role was created. Switch to the tenant role so DROP DATABASE
       * executes as the database owner.
       */
      const setTenantRoleSql =
        await buildFormattedSql(
          client,
          "SET ROLE %I",
          [dbUser],
        );

      await client.query(setTenantRoleSql);

      try {
        /**
         * PostgreSQL 16 supports FORCE, which attempts to terminate active
         * sessions before dropping the database. This command cannot run
         * inside a transaction, so this function does not use BEGIN/COMMIT.
         */
        const dropDatabaseSql =
          await buildFormattedSql(
            client,
            "DROP DATABASE IF EXISTS %I WITH (FORCE)",
            [dbName],
          );

        await client.query(
          dropDatabaseSql,
        );

        result.databaseDropped = true;
      } finally {
        /**
         * Return to the provisioner administrator before dropping the
         * tenant role itself.
         */
        await client.query(
          "RESET ROLE",
        );
      }
    }

    const roleLookup = await client.query(
      `
        SELECT EXISTS (
          SELECT 1
          FROM pg_roles
          WHERE rolname = $1
        ) AS exists
      `,
      [dbUser],
    );

    const roleExists =
      roleLookup.rows[0]?.exists === true;

    result.roleExisted = roleExists;

    if (roleExists) {
      /**
       * DROP ROLE automatically removes role memberships involving the
       * deleted role. It will fail safely if the role still owns objects
       * or retains privileges elsewhere in the PostgreSQL cluster.
       */
      const dropRoleSql =
        await buildFormattedSql(
          client,
          "DROP ROLE IF EXISTS %I",
          [dbUser],
        );

      await client.query(dropRoleSql);

      result.roleDropped = true;
    }

    console.log(
      "Tenant PostgreSQL resources removed:",
      {
        database: dbName,
        user: dbUser,
        provisionerAdminUser,
        databaseExisted:
          result.databaseExisted,
        roleExisted:
          result.roleExisted,
        databaseDropped:
          result.databaseDropped,
        roleDropped:
          result.roleDropped,
      },
    );

    return result;
  } catch (error) {
    console.error(
      "Tenant PostgreSQL removal failed:",
      {
        database: dbName,
        user: dbUser,
        provisionerAdminUser,
        code: error?.code,
        message: error?.message,
        detail: error?.detail,
        hint: error?.hint,
      },
    );

    /**
     * PostgreSQL error 2BP01 means dependent objects still exist.
     *
     * Do not automatically use DROP OWNED or CASCADE here because the
     * tenant role could own unexpected objects outside its tenant database.
     */
    if (error?.code === "2BP01") {
      throw createHttpError(
        409,
        `Role "${dbUser}" still owns objects or has privileges elsewhere in the PostgreSQL cluster: ${error.message}`,
      );
    }

    throw error;
  } finally {
    if (advisoryLockAcquired) {
      try {
        await client.query(
          "SELECT pg_advisory_unlock(hashtext($1))",
          [advisoryLockKey],
        );
      } catch (unlockError) {
        console.error(
          "Failed to release PostgreSQL advisory lock:",
          unlockError,
        );
      }
    }

    try {
      await client.end();
    } catch (closeError) {
      console.error(
        "Failed to close PostgreSQL administrator connection:",
        closeError,
      );
    }
  }
}

function isNotFound(err) {
  return (
    err?.response?.statusCode === 404 ||
    err?.statusCode === 404 ||
    err?.status === 404 ||
    err?.code === 404 ||
    err?.body?.code === 404 ||
    (
      err?.body?.status === "Failure" &&
      err?.body?.reason === "NotFound"
    ) ||
    String(err?.message || "")
      .toLowerCase()
      .includes("not found")
  );
}

async function ensureNamespace(
  nsName,
  labels = {},
) {
  console.log(
    "Ensuring Namespace:",
    nsName,
    "labels:",
    labels,
  );

  try {
    await coreV1.readNamespace({
      name: nsName,
    });

    return {
      created: false,
    };
  } catch (error) {
    if (!isNotFound(error)) {
      throw error;
    }
  }

  await coreV1.createNamespace({
    body: {
      apiVersion: "v1",
      kind: "Namespace",
      metadata: {
        name: nsName,
        labels,
      },
    },
  });

  return {
    created: true,
  };
}

async function upsertSecret(
  namespace,
  name,
  stringData,
) {
  console.log(
    "Ensuring Secret:",
    {
      name,
      namespace,
    },
  );

  try {
    const existing =
      await coreV1.readNamespacedSecret({
        name,
        namespace,
      });

    await coreV1.replaceNamespacedSecret({
      name,
      namespace,
      body: {
        apiVersion: "v1",
        kind: "Secret",
        metadata: {
          name,
          namespace,
          resourceVersion:
            existing.metadata
              ?.resourceVersion,
        },
        type: "Opaque",
        stringData,
      },
    });

    return {
      created: false,
    };
  } catch (error) {
    if (!isNotFound(error)) {
      throw error;
    }
  }

  await coreV1.createNamespacedSecret({
    namespace,
    body: {
      apiVersion: "v1",
      kind: "Secret",
      metadata: {
        name,
        namespace,
      },
      type: "Opaque",
      stringData,
    },
  });

  return {
    created: true,
  };
}

async function createTenantCR(
  tenantName,
  tenantSpec,
) {
  console.log(
    "Creating Tenant CR in",
    IMS_SYSTEM_NAMESPACE,
    "with name:",
    tenantName,
  );

  const response =
    await customApi.createNamespacedCustomObject({
      group: CRD_GROUP,
      version: CRD_VERSION,
      namespace:
        IMS_SYSTEM_NAMESPACE,
      plural: CRD_PLURAL,
      body: {
        apiVersion:
          `${CRD_GROUP}/${CRD_VERSION}`,
        kind: "Tenant",
        metadata: {
          name: tenantName,
          namespace:
            IMS_SYSTEM_NAMESPACE,
        },
        spec: tenantSpec,
      },
    });

  console.log(
    "Tenant CR creation response:",
    response?.response?.statusCode,
  );

  return response;
}

async function deleteTenantCR(
  tenantName,
) {
  console.log(
    "Requesting deletion of Tenant CR",
    tenantName,
    "in",
    IMS_SYSTEM_NAMESPACE,
  );

  return customApi.deleteNamespacedCustomObject({
    group: CRD_GROUP,
    version: CRD_VERSION,
    namespace:
      IMS_SYSTEM_NAMESPACE,
    plural: CRD_PLURAL,
    name: tenantName,
    body: {
      propagationPolicy: "Foreground",
    },
  });
}

function buildTenantSpec({
  name,
  tenantNamespace,
  dbName,
}) {
  return {
    namespace: tenantNamespace,
    slug: name,

    secretRefs: {
      dbSecretName:
        DB_SECRET_NAME,
    },

    helm: {
      releaseName:
        `tenant-${name}`,

      /**
       * This path is interpreted by the operator pod,
       * not the provisioner pod.
       */
      chartPath:
        "/app/tenant-app-deploy",

      /**
       * Keep these values minimal.
       *
       * Default images, ports, replica counts, ingress defaults,
       * Redis defaults and PgBouncer defaults should remain in:
       *
       * operator-api/tenant-app-deploy/values.yaml
       */
      values: {
        tenant: {
          name,
          slug: name,
        },

        secretRefs: {
          existingSecretName:
            DB_SECRET_NAME,
        },

        serviceAccount: {
          name:
            `tenant-${name}-app`,
        },

        config: {
          DB_NAME: dbName,
        },
      },
    },
  };
}

// ---- Endpoints ----
app.post(
  "/provision-tenant",
  async (req, res) => {
    if (!requireAdmin(req, res)) {
      return;
    }

    try {
      const rawName =
        req.body?.name;

      if (
        !rawName ||
        typeof rawName !== "string"
      ) {
        return res.status(400).json({
          error:
            "name is required",
        });
      }

      const name =
        slugify(rawName);

      const tenantNamespace =
        `${TENANT_NS_PREFIX}${name}`;

      const dbName =
        validatePostgresIdentifier(
          req.body?.dbName ||
            `ims_${name}`,
          "dbName",
        );

      const dbUser =
        validatePostgresIdentifier(
          req.body?.dbUser,
          "dbUser",
        );

      const dbUserPassword =
        validateDatabasePassword(
          req.body?.dbUserPassword,
        );

      validateTenantDatabaseTargets(
        dbName,
        dbUser,
      );

      /**
       * Create the PostgreSQL role and database before creating the
       * tenant Kubernetes resources.
       */
      const databaseResult =
        await initializeTenantDatabase({
          dbName,
          dbUser,
          dbUserPassword,
        });

      const nsResult =
        await ensureNamespace(
          tenantNamespace,
          {
            "ims.example.com/tenant":
              name,
            "ims.example.com/managed":
              "true",
          },
        );

      /**
       * This is the application-level tenant database account.
       *
       * Do not put the provisioner's PostgreSQL administrator credentials
       * in the tenant namespace.
       */
      const secretResult =
        await upsertSecret(
          tenantNamespace,
          DB_SECRET_NAME,
          {
            DB_NAME: dbName,
            DB_USER: dbUser,
            DB_PASSWORD:
              dbUserPassword,
          },
        );

      const tenantCRSpec =
        buildTenantSpec({
          name,
          tenantNamespace,
          dbName,
        });

      const crResponse =
        await createTenantCR(
          name,
          tenantCRSpec,
        );

      return res.status(201).json({
        tenant: name,
        tenantNamespace,

        database: {
          name:
            databaseResult.database,
          user:
            databaseResult.user,
          databaseCreated:
            databaseResult
              .databaseCreated,
          roleCreated:
            databaseResult
              .roleCreated,
        },

        namespaceCreated:
          nsResult.created,

        secretCreated:
          secretResult.created,

        tenantCR: {
          name,
          namespace:
            IMS_SYSTEM_NAMESPACE,
        },

        crStatus:
          crResponse?.response
            ?.statusCode || 201,
      });
    } catch (error) {
      const status =
        error?.response
          ?.statusCode ||
        error?.statusCode ||
        500;

      const details =
        error?.response?.body ||
        null;

      return res.status(status).json({
        error: String(
          error?.message || error,
        ),
        details,
      });
    }
  },
);

app.delete(
  "/deprovision-tenant/:name",
  async (req, res) => {
    if (!requireAdmin(req, res)) {
      return;
    }

    try {
      const name =
        slugify(req.params?.name);

      const tenantNamespace =
        `${TENANT_NS_PREFIX}${name}`;

      const dbName =
        validatePostgresIdentifier(
          req.body?.dbName ||
            `ims_${name}`,
          "dbName",
        );

      const dbUser =
        validatePostgresIdentifier(
          req.body?.dbUser,
          "dbUser",
        );

      validateTenantDatabaseTargets(
        dbName,
        dbUser,
      );

      /**
       * Remove PostgreSQL resources first. The helper is idempotent, so a
       * partially completed deprovision request can be safely retried.
       *
       * dbUserPassword may still be present if the caller reuses the POST
       * request body, but deletion does not need or use the tenant password.
       */
      const databaseResult =
        await removeTenantDatabase({
          dbName,
          dbUser,
        });

      const deleteResponse =
        await deleteTenantCR(name);

      return res.status(202).json({
        tenant: name,
        tenantNamespace,

        database: {
          name:
            databaseResult.database,
          user:
            databaseResult.user,
          databaseExisted:
            databaseResult
              .databaseExisted,
          roleExisted:
            databaseResult
              .roleExisted,
          databaseDropped:
            databaseResult
              .databaseDropped,
          roleDropped:
            databaseResult
              .roleDropped,
        },

        tenantCR: {
          name,
          namespace:
            IMS_SYSTEM_NAMESPACE,
        },

        message:
          "Tenant database and role removed. Tenant CR deletion requested; operator cleanup should continue through its finalizer.",

        deleteStatus:
          deleteResponse?.response
            ?.statusCode || 202,
      });
    } catch (error) {
      if (isNotFound(error)) {
        return res.status(404).json({
          error:
            `Tenant "${req.params?.name}" not found`,
        });
      }

      const status =
        error?.response
          ?.statusCode ||
        error?.statusCode ||
        500;

      const details =
        error?.response?.body ||
        null;

      return res.status(status).json({
        error: String(
          error?.message || error,
        ),
        details,
      });
    }
  },
);

app.get(
  "/healthz",
  (_req, res) => {
    return res.status(200).json({
      ok: true,
    });
  },
);

app.get(
  "/readyz",
  (_req, res) => {
    return res.status(200).json({
      ready: true,
      version: "1.3.0",
    });
  },
);

app.listen(PORT, () => {
  console.log(
    `Provisioner listening on port ${PORT}`,
  );
});