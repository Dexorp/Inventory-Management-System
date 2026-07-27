'use strict';

/**
 * This is the database module for the tenant namespace.
 *
 * Context:
 * - Containerized Node.js file.
 * - Imported directly by general-api.js.
 * - Not an Express app.
 * - Gets PostgreSQL connections through a PgBouncer deployment/service
 *   running in the same Kubernetes namespace.
 * - All configuration and secrets are provided through environment variables.
 */

const { Client } = require('pg');

/**
 * Logs an action to the console with a timestamp.
 *
 * @param {string} message
 */
function log(message) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${message}`);
}

/**
 * Returns a connected PostgreSQL client from PgBouncer.
 *
 * Important:
 * The caller is responsible for closing the connection after use:
 *
 * const client = await getConnection();
 * try {
 *   const result = await client.query('SELECT 1');
 * } finally {
 *   await client.end();
 * }
 *
 * @returns {Promise<Client>}
 */
async function getConnection() {
  const config = {
    host: process.env.PGBOUNCER_HOST || 'pgbouncer',
    port: Number(process.env.PGBOUNCER_PORT || 6432),
    database: process.env.POSTGRES_DB,
    user: process.env.POSTGRES_USER,
    password: process.env.POSTGRES_PASSWORD,

    connectionTimeoutMillis: Number(
      process.env.DB_CONNECTION_TIMEOUT_MS || 5000
    ),

    ssl:
      process.env.POSTGRES_SSL === 'true'
        ? {
            rejectUnauthorized:
              process.env.POSTGRES_SSL_REJECT_UNAUTHORIZED !== 'false',
          }
        : false,
  };

  validateConnectionConfig(config);

  log(
    `Requesting database connection from PgBouncer at ${config.host}:${config.port}`
  );

  const client = new Client(config);

  await client.connect();

  log('Database connection acquired from PgBouncer');

  return client;
}

/**
 * Checks the health of the database module.
 *
 * This only verifies that the module itself is loaded.
 * It does not test the database connection.
 *
 * @returns {{ message: string }}
 */
function health() {
  console.log('Checking database module health');
  return { message: 'OK' };
}

/**
 * Gets a connection and tests it by executing a simple query.
 *
 * Left empty for now per the spec.
 *
 * @returns {Promise<{ message: string }>}
 */
async function test() {
  // Leave empty for now.
  return { message: 'Test function not implemented yet' };
}

/**
 * Optional helper for executing a SQL query.
 *
 * This is not required by the original db-api module spec,
 * but it is useful for general-api.js so it does not need to manually
 * open and close connections every time.
 *
 * @param {string} query
 * @param {Array} params
 * @returns {Promise<import('pg').QueryResult>}
 */
async function executeSQLQuery(query, params = []) {
  if (!query || typeof query !== 'string') {
    throw new Error('query is required and must be a string');
  }

  const client = await getConnection();

  try {
    return await client.query(query, params);
  } finally {
    await client.end();
    log('Database connection closed');
  }
}

/**
 * Validates required database connection configuration.
 *
 * @param {object} config
 */
function validateConnectionConfig(config) {
  const missing = [];

  if (!config.host) missing.push('PGBOUNCER_HOST');
  if (!config.port) missing.push('PGBOUNCER_PORT');
  if (!config.database) missing.push('POSTGRES_DB');
  if (!config.user) missing.push('POSTGRES_USER');
  if (!config.password) missing.push('POSTGRES_PASSWORD');

  if (missing.length > 0) {
    throw new Error(
      `Missing required database environment variables: ${missing.join(', ')}`
    );
  }
}

module.exports = {
  log,
  getConnection,
  health,
  test,
  executeSQLQuery,
};