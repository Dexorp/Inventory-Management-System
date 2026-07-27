'use strict';

/**
 * This is the tenant auth module for the tenant namespace.
 *
 * Context:
 * - Containerized Node.js file.
 * - Imported directly by general-api.js.
 * - Not an Express app.
 * - Handles session authentication and authorization for the tenant namespace.
 * - Handles session data through a Redis deployment/service in the same namespace.
 * - All needed variables and secrets are provided through environment variables.
 */

const { createClient } = require('redis');

let redisClient = null;
let redisConnecting = null;

/**
 * Logs an action to the console with a timestamp.
 *
 * @param {string} message
 */
function logmessage(message) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${message}`);
}

/**
 * Builds the Redis connection URL.
 *
 * In Kubernetes, REDIS_HOST should usually be the Redis Service name.
 * Example:
 * REDIS_HOST=tenant-acme-redis
 * REDIS_PORT=6379
 *
 * @returns {string}
 */
function getRedisUrl() {
  const host = process.env.REDIS_HOST || 'redis';
  const port = Number(process.env.REDIS_PORT || 6379);

  if (process.env.REDIS_PASSWORD) {
    return `redis://:${encodeURIComponent(process.env.REDIS_PASSWORD)}@${host}:${port}`;
  }

  return `redis://${host}:${port}`;
}

/**
 * Returns a connected Redis client.
 *
 * This module reuses a single Redis client for the lifetime of the Node process.
 * That is usually the correct approach because Redis clients maintain their own
 * TCP connection and reconnect behavior.
 *
 * @returns {Promise<import('redis').RedisClientType>}
 */
async function getRedisClient() {
  if (redisClient && redisClient.isOpen) {
    return redisClient;
  }

  if (redisConnecting) {
    return redisConnecting;
  }

  redisConnecting = (async () => {
    const client = createClient({
      url: process.env.REDIS_URL || getRedisUrl(),
      socket: {
        reconnectStrategy: retries => {
          const delay = Math.min(retries * 50, 1000);
          logmessage(`Redis reconnect attempt ${retries}, retrying in ${delay}ms`);
          return delay;
        },
      },
    });

    client.on('error', error => {
      logmessage(`Redis error: ${error.message}`);
    });

    client.on('connect', () => {
      logmessage('Redis client connected');
    });

    client.on('ready', () => {
      logmessage('Redis client ready');
    });

    client.on('end', () => {
      logmessage('Redis client disconnected');
    });

    await client.connect();

    redisClient = client;
    redisConnecting = null;

    return redisClient;
  })();

  return redisConnecting;
}

/**
 * Authenticates the request and returns a session token if successful.
 *
 * Left intentionally minimal for now per the spec.
 *
 * Expected future behavior:
 * - Read credentials/session token from req.
 * - Validate the token or credentials.
 * - Return a session token if authentication succeeds.
 *
 * @param {object} req
 * @returns {Promise<string|null>}
 */
async function authenticate(req) {
  // Leave empty for now.
  return null;
}

/**
 * Authorizes the request based on the session token.
 *
 * Left intentionally minimal for now per the spec.
 *
 * Expected future behavior:
 * - Read session token from req.
 * - Look up session data in Redis.
 * - Check whether the user has permission for the requested action.
 * - Return true if authorized, false otherwise.
 *
 * @param {object} req
 * @returns {Promise<boolean>}
 */
async function authorize(req) {
  // Leave empty for now.
  return false;
}

/**
 * Checks the health of the module.
 *
 * This verifies that the module itself is loaded.
 * It does not require Redis to be reachable.
 *
 * @returns {{ message: string }}
 */
function health() {
  return { message: 'OK' };
}

/**
 * Gets all session data from Redis.
 *
 * This assumes session keys use a prefix.
 * Default prefix:
 * session:
 *
 * You can override it with:
 * SESSION_KEY_PREFIX=yourPrefix:
 *
 * @returns {Promise<object>}
 */
async function test() {
  const client = await getRedisClient();
  const prefix = process.env.SESSION_KEY_PREFIX || 'session:';

  const keys = await client.keys(`${prefix}*`);
  const sessions = {};

  for (const key of keys) {
    const value = await client.get(key);

    try {
      sessions[key] = JSON.parse(value);
    } catch (_error) {
      sessions[key] = value;
    }
  }

  return {
    message: 'OK',
    sessionCount: keys.length,
    sessions,
  };
}

/**
 * Optional helper for storing session data in Redis.
 *
 * Not required by the uploaded spec, but useful for general-api.js later.
 *
 * @param {string} sessionToken
 * @param {object} sessionData
 * @param {number} ttlSeconds
 * @returns {Promise<void>}
 */
async function saveSession(sessionToken, sessionData, ttlSeconds = 3600) {
  if (!sessionToken) {
    throw new Error('sessionToken is required');
  }

  const client = await getRedisClient();
  const prefix = process.env.SESSION_KEY_PREFIX || 'session:';
  const key = `${prefix}${sessionToken}`;

  await client.set(key, JSON.stringify(sessionData || {}), {
    EX: ttlSeconds,
  });

  logmessage(`Session saved: ${key}`);
}

/**
 * Optional helper for loading one session from Redis.
 *
 * @param {string} sessionToken
 * @returns {Promise<object|null>}
 */
async function getSession(sessionToken) {
  if (!sessionToken) {
    return null;
  }

  const client = await getRedisClient();
  const prefix = process.env.SESSION_KEY_PREFIX || 'session:';
  const key = `${prefix}${sessionToken}`;

  const value = await client.get(key);

  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch (_error) {
    return { raw: value };
  }
}

/**
 * Optional helper for deleting a session from Redis.
 *
 * @param {string} sessionToken
 * @returns {Promise<number>}
 */
async function deleteSession(sessionToken) {
  if (!sessionToken) {
    return 0;
  }

  const client = await getRedisClient();
  const prefix = process.env.SESSION_KEY_PREFIX || 'session:';
  const key = `${prefix}${sessionToken}`;

  const deletedCount = await client.del(key);

  logmessage(`Session deleted: ${key}`);

  return deletedCount;
}

/**
 * Gracefully closes the Redis connection.
 *
 * Useful for tests or container shutdown hooks.
 *
 * @returns {Promise<void>}
 */
async function closeRedisConnection() {
  if (redisClient && redisClient.isOpen) {
    await redisClient.quit();
    redisClient = null;
    redisConnecting = null;
    logmessage('Redis connection closed');
  }
}

module.exports = {
  authenticate,
  authorize,
  logmessage,
  health,
  test,

  // Helpful internal/exported utilities.
  getRedisClient,
  saveSession,
  getSession,
  deleteSession,
  closeRedisConnection,
};