const { createClient } = require("redis");

const REDIS_DISABLED = process.env.REDIS_DISABLED === "true";
const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";

let client = null;
let connectPromise = null;
let lastErrorLogAt = 0;

const warnOnce = (message, error) => {
  const now = Date.now();
  if (now - lastErrorLogAt < 30000) return;
  lastErrorLogAt = now;
  console.warn("[Redis]", message, error?.message || error || "");
};

const createRedisClient = () => {
  const redis = createClient({
    url: REDIS_URL,
    socket: {
      reconnectStrategy: (retries) => Math.min(retries * 50, 1000),
    },
  });

  redis.on("error", (error) => warnOnce("Client error", error));
  return redis;
};

const getRedisClient = async () => {
  if (REDIS_DISABLED) return null;

  try {
    if (!client) client = createRedisClient();
    if (client.isOpen) return client;

    if (!connectPromise) {
      connectPromise = client.connect().catch((error) => {
        warnOnce("Connection failed", error);
        return null;
      });
    }

    const connected = await connectPromise;
    connectPromise = null;
    return connected || null;
  } catch (error) {
    connectPromise = null;
    warnOnce("Unavailable", error);
    return null;
  }
};

const getJson = async (key) => {
  const redis = await getRedisClient();
  if (!redis) return null;

  try {
    const value = await redis.get(key);
    return value ? JSON.parse(value) : null;
  } catch (error) {
    warnOnce(`GET failed for ${key}`, error);
    return null;
  }
};

const setJson = async (key, value, ttlSeconds) => {
  const redis = await getRedisClient();
  if (!redis) return false;

  try {
    const payload = JSON.stringify(value);
    if (ttlSeconds) {
      await redis.set(key, payload, { EX: ttlSeconds });
    } else {
      await redis.set(key, payload);
    }
    return true;
  } catch (error) {
    warnOnce(`SET failed for ${key}`, error);
    return false;
  }
};

const del = async (...keys) => {
  const redis = await getRedisClient();
  if (!redis || keys.length === 0) return false;

  try {
    await redis.del(keys);
    return true;
  } catch (error) {
    warnOnce("DEL failed", error);
    return false;
  }
};

module.exports = {
  getRedisClient,
  getJson,
  setJson,
  del,
};
