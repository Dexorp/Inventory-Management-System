'use strict';

/**
 * General Tenant API
 *
 * Containerized Node.js service that exposes tenant-level API routes.
 *
 * This file is still the public HTTP API for the tenant, so it uses Express.
 * The tenant-auth-api and db-api files are treated as imported modules,
 * not separate Express apps or HTTP services.
 *
 * Expected local modules:
 * - ./sidecar-apis/tenant-auth-api.js
 * - ./sidecar-apis/db-api.js
 */

const express = require('express');

const authModule = require('./sidecar-apis/tenant-auth-api');
const dbModule = require('./sidecar-apis/db-api');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const AUTH_DISABLED = process.env.AUTH_DISABLED === 'true';

app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || '1mb' }));

async function authenticateAndAuthorizeRequest(req, res, next) {
  if (AUTH_DISABLED) {
    return next();
  }

  try {
    const session = await authModule.authenticate(req);

    if (!session) {
      return res.status(401).json({
        error: 'Unauthenticated request',
      });
    }

    req.session = session;

    const authorized = await authModule.authorize(req);

    if (!authorized) {
      return res.status(403).json({
        error: 'Unauthorized request',
      });
    }

    return next();
  } catch (error) {
    return res.status(error.status || 500).json({
      error: error.message || 'Authentication or authorization failed',
    });
  }
}

function health() {
  return { message: 'OK' };
}

async function test() {
  console.log('Running general-api test() function...');
  const results = {
    generalApi: health(),
    authModule: null,
    dbModule: dbModule.getConnection(),
  };

  if (typeof authModule.health === 'function') {
    results.authModule = {
      health: authModule.health(),
    };
  }

  if (typeof authModule.test === 'function') {
    results.authModule = {
      ...(results.authModule || {}),
      test: await authModule.test(),
    };
  }

  if (typeof dbModule.health === 'function') {
    results.dbModule = {
      health: dbModule.health(),
    };
  }

  if (typeof dbModule.test === 'function') {
    results.dbModule = {
      ...(results.dbModule || {}),
      test: await dbModule.test(),
    };
  }

  return {
    message: 'OK',
    results,
  };
}

async function executeSQLQuery(query, params = []) {
  if (!query || typeof query !== 'string') {
    const error = new Error('query is required and must be a string');
    error.status = 400;
    throw error;
  }

  if (typeof dbModule.executeSQLQuery === 'function') {
    const result = await dbModule.executeSQLQuery(query, params);
    return normalizeQueryResult(result);
  }

  if (typeof dbModule.getConnection !== 'function') {
    throw new Error('db-api module must export executeSQLQuery() or getConnection()');
  }

  const client = await dbModule.getConnection();

  try {
    const result = await client.query(query, params);
    return normalizeQueryResult(result);
  } finally {
    await client.end();

    if (typeof dbModule.log === 'function') {
      dbModule.log('Database connection closed by general-api');
    }
  }
}

async function updateDatabase(reqBody = {}) {
  const { query, params = [] } = reqBody;
  return executeSQLQuery(query, params);
}

async function completeTask(reqBody = {}) {
  return {
    message: 'completeTask is not implemented yet',
    received: reqBody,
  };
}

async function createWorkorder(reqBody = {}) {
  return {
    message: 'createWorkorder is not implemented yet',
    received: reqBody,
  };
}

async function getInventory(reqBody = {}) {
  const query = process.env.INVENTORY_QUERY || 'SELECT * FROM inventory;';
  const params = Array.isArray(reqBody.params) ? reqBody.params : [];

  return executeSQLQuery(query, params);
}

function normalizeQueryResult(result) {
  return {
    rows: result.rows || [],
    rowCount: result.rowCount || 0,
    command: result.command,
  };
}

function asyncHandler(handler) {
  return async (req, res, next) => {
    try {
      await handler(req, res, next);
    } catch (error) {
      next(error);
    }
  };
}

app.get('/health', (_req, res) => {
  res.status(200).json(health());
});

app.get('/test', authenticateAndAuthorizeRequest, asyncHandler(async (_req, res) => {
  res.status(200).json(await test());
}));

app.get('/getInventory', authenticateAndAuthorizeRequest, asyncHandler(async (req, res) => {
  res.status(200).json(await getInventory(req.query));
}));

app.patch('/updateDatabase', authenticateAndAuthorizeRequest, asyncHandler(async (req, res) => {
  res.status(200).json(await updateDatabase(req.body));
}));

app.post('/completeTask', authenticateAndAuthorizeRequest, asyncHandler(async (req, res) => {
  res.status(200).json(await completeTask(req.body));
}));

app.post('/createWorkorder', authenticateAndAuthorizeRequest, asyncHandler(async (req, res) => {
  res.status(201).json(await createWorkorder(req.body));
}));

app.use((req, res) => {
  res.status(404).json({
    error: `Route not found: ${req.method} ${req.path}`,
  });
});

app.use((error, _req, res, _next) => {
  const status = Number(error.status || error.statusCode || 500);

  res.status(status).json({
    error: error.message || 'Internal server error',
    details: error.data,
  });
});

if (require.main === module) {
  app.listen(PORT, '0.0.0.0', () => {
    
    console.log(`general-api listening on port ${PORT}`);
  });
}

module.exports = {
  app,
  health,
  test,
  executeSQLQuery,
  updateDatabase,
  completeTask,
  createWorkorder,
  getInventory,
  authenticateAndAuthorizeRequest,
};