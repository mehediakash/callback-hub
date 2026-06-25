const redis = require("./redisClient");

const SESSION_TTL_SECONDS = Number(
  process.env.REDIS_HUB_SESSION_TTL_SECONDS || 2 * 60 * 60,
);
const DUPLICATE_ROUND_TTL_SECONDS = Number(
  process.env.REDIS_HUB_DUPLICATE_ROUND_TTL_SECONDS || 7 * 24 * 60 * 60,
);

const keyPart = (value) => encodeURIComponent(String(value ?? ""));

const toId = (value) => {
  if (!value) return value;
  if (value._id) return String(value._id);
  return String(value);
};

const mappingPayload = (mapping) => ({
  _id: toId(mapping._id),
  memberAccount: String(mapping.memberAccount),
  gameUid: String(mapping.gameUid),
  website: String(mapping.website),
  callbackUrl: mapping.callbackUrl,
  providerSessionId: String(mapping.providerSessionId),
  userId: String(mapping.userId),
  gameName: mapping.gameName || null,
  sessionNumber: mapping.sessionNumber || 1,
  status: mapping.status || "active",
  lastProcessedRound: mapping.lastProcessedRound || null,
  lastKnownBalance:
    mapping.lastKnownBalance === undefined
      ? undefined
      : mapping.lastKnownBalance,
  launchedAt: mapping.launchedAt
    ? new Date(mapping.launchedAt).getTime()
    : Date.now(),
  lastActivityAt: mapping.lastActivityAt
    ? new Date(mapping.lastActivityAt).getTime()
    : Date.now(),
});

class CallbackCacheService {
  static providerSessionKey(providerSessionId) {
    return `hub:session:provider:${keyPart(providerSessionId)}`;
  }

  static roundKey(website, providerSessionId, gameRound) {
    return `hub:round:${keyPart(website)}:${keyPart(providerSessionId)}:${keyPart(gameRound)}`;
  }

  static async getMappingByProvider(providerSessionId) {
    if (!providerSessionId) return null;
    return redis.getJson(this.providerSessionKey(providerSessionId));
  }

  static async cacheMapping(mapping) {
    if (!mapping?.providerSessionId) return false;
    return redis.setJson(
      this.providerSessionKey(mapping.providerSessionId),
      mappingPayload(mapping),
      SESSION_TTL_SECONDS,
    );
  }

  static async updateMapping(mapping, updates) {
    if (!mapping?.providerSessionId) return false;
    return redis.setJson(
      this.providerSessionKey(mapping.providerSessionId),
      {
        ...mappingPayload(mapping),
        ...updates,
        lastActivityAt: Date.now(),
      },
      SESSION_TTL_SECONDS,
    );
  }

  static async removeMapping(mappingOrProviderSessionId) {
    const providerSessionId =
      typeof mappingOrProviderSessionId === "object"
        ? mappingOrProviderSessionId.providerSessionId
        : mappingOrProviderSessionId;
    if (!providerSessionId) return false;
    return redis.del(this.providerSessionKey(providerSessionId));
  }

  static async getProcessedRound(website, providerSessionId, gameRound) {
    if (!website || !providerSessionId || !gameRound) return null;
    return redis.getJson(this.roundKey(website, providerSessionId, gameRound));
  }

  static async isDuplicateRound(website, providerSessionId, gameRound) {
    const cached = await this.getProcessedRound(
      website,
      providerSessionId,
      gameRound,
    );
    return Boolean(cached?.processed);
  }

  static async markProcessedRound({
    website,
    providerSessionId,
    gameRound,
    creditAmount,
  }) {
    if (!website || !providerSessionId || !gameRound) return false;
    return redis.setJson(
      this.roundKey(website, providerSessionId, gameRound),
      {
        processed: true,
        creditAmount:
          creditAmount === undefined || creditAmount === null
            ? null
            : Number(creditAmount),
        processedAt: Date.now(),
      },
      DUPLICATE_ROUND_TTL_SECONDS,
    );
  }
}

module.exports = CallbackCacheService;
