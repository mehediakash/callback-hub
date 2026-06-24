// callback-hub/models/ProviderLaunchMap.js
const mongoose = require("mongoose");

const providerLaunchMapSchema = new mongoose.Schema(
  {
    memberAccount: { type: String, required: true, index: true },
    gameUid: { type: String, required: true, index: true },
    website: {
      type: String,
      required: true,
    },
    callbackUrl: { type: String, required: true },
    providerSessionId: { type: String, required: true, unique: true },
    userId: { type: String, required: true, index: true },
    gameName: { type: String },
    launchedAt: { type: Date, default: Date.now },
    lastActivityAt: { type: Date, default: Date.now },
    status: {
      type: String,
      enum: ["active", "completed", "expired"],
      default: "active",
    },
    lastProcessedRound: { type: String, default: null },
    sessionNumber: { type: Number, default: 1 },
    lastKnownBalance: { type: Number },
    completedAt: { type: Date },
  },
  { timestamps: true },
);

// Indexes
providerLaunchMapSchema.index({ memberAccount: 1, gameUid: 1, status: 1 });
providerLaunchMapSchema.index({ memberAccount: 1, status: 1 });
providerLaunchMapSchema.index({ providerSessionId: 1, status: 1 });
providerLaunchMapSchema.index({ website: 1, providerSessionId: 1 });
providerLaunchMapSchema.index({ website: 1, userId: 1, status: 1 });
providerLaunchMapSchema.index({ website: 1, userId: 1, gameUid: 1, status: 1 });
providerLaunchMapSchema.index({
  website: 1,
  memberAccount: 1,
  gameUid: 1,
  status: 1,
});
providerLaunchMapSchema.index({ createdAt: 1 }, { expireAfterSeconds: 7200 });

// Resolve callbacks without provider URL/query-string website hints.
providerLaunchMapSchema.statics.findSessionForCallback = async function (
  callbackData,
) {
  const { member_account, game_uid, userId, providerSessionId } = callbackData;

  console.log(
    `[ProviderLaunchMap] Looking for session: member=${member_account}, userId=${userId || null}, game=${game_uid}, providerSessionId=${providerSessionId || null}`,
  );

  if (providerSessionId) {
    const session = await this.findOne({
      providerSessionId: String(providerSessionId),
    });
    if (session) return session;
  }

  if (userId) {
    const userSessions = await this.find({
      userId: String(userId),
      gameUid: String(game_uid),
      status: "active",
    })
      .sort({ launchedAt: -1 })
      .limit(20);
    const userWebsites = new Set(
      userSessions.map((session) => session.website),
    );

    if (userSessions.length && userWebsites.size === 1) return userSessions[0];

    if (userWebsites.size > 1) {
      console.error(
        `[ProviderLaunchMap] Ambiguous userId lookup across websites for userId=${userId}; providerSessionId is required`,
      );
      return null;
    }
  }

  // Strategy 1: Find the MOST RECENT active session (not oldest)
  const session = await this.findOne({
    memberAccount: String(member_account),
    gameUid: String(game_uid),
    status: "active",
  }).sort({ launchedAt: -1 }); // ← Get newest session first

  const memberWebsites = await this.distinct("website", {
    memberAccount: String(member_account),
    gameUid: String(game_uid),
    status: "active",
  });

  if (memberWebsites.length > 1) {
    console.error(
      `[ProviderLaunchMap] Ambiguous memberAccount fallback across websites for member=${member_account}; refusing to route callback`,
    );
    return null;
  }

  if (session) {
    console.log(
      `[ProviderLaunchMap] Found active session #${session.sessionNumber}: ${session.providerSessionId}`,
    );
    return session;
  }

  // Strategy 2: If no active session, find any session from last 5 minutes
  const recentSession = await this.findOne({
    memberAccount: String(member_account),
    gameUid: String(game_uid),
    launchedAt: { $gt: new Date(Date.now() - 5 * 60 * 1000) }, // Last 5 minutes
  }).sort({ launchedAt: -1 });

  const recentWebsites = await this.distinct("website", {
    memberAccount: String(member_account),
    gameUid: String(game_uid),
    launchedAt: { $gt: new Date(Date.now() - 5 * 60 * 1000) },
  });

  if (recentWebsites.length > 1) {
    console.error(
      `[ProviderLaunchMap] Ambiguous recent memberAccount fallback across websites for member=${member_account}; refusing to route callback`,
    );
    return null;
  }

  if (recentSession) {
    console.log(
      `[ProviderLaunchMap] Found recent session (status=${recentSession.status}): ${recentSession.providerSessionId}`,
    );
    // Reactivate it
    recentSession.status = "active";
    recentSession.lastActivityAt = new Date();
    await recentSession.save();
    return recentSession;
  }

  console.log(`[ProviderLaunchMap] No session found`);
  return null;
};

// FIXED: Create session WITHOUT closing previous ones
providerLaunchMapSchema.statics.createSession = async function ({
  memberAccount,
  gameUid,
  website,
  callbackUrl,
  providerSessionId,
  userId,
  gameName,
}) {
  // Count existing sessions
  const sessionCount = await this.countDocuments({
    memberAccount: String(memberAccount),
    gameUid: String(gameUid),
    website,
  });

  const sessionNumber = sessionCount + 1;

  // IMPORTANT FIX: DO NOT close previous sessions
  // Let them expire naturally via TTL
  // Just create the new session as active

  const session = await this.create({
    memberAccount: String(memberAccount),
    gameUid: String(gameUid),
    website,
    callbackUrl,
    providerSessionId: String(providerSessionId),
    userId,
    gameName,
    sessionNumber,
    status: "active",
    launchedAt: new Date(),
    lastActivityAt: new Date(),
  });

  console.log(
    `[ProviderLaunchMap] Created session #${sessionNumber}: ${providerSessionId} (keeping previous sessions active)`,
  );

  // Log all active sessions for this user
  const activeCount = await this.countDocuments({
    memberAccount: String(memberAccount),
    gameUid: String(gameUid),
    website,
    status: "active",
  });

  console.log(
    `[ProviderLaunchMap] User ${memberAccount} now has ${activeCount} active sessions for game ${gameUid}`,
  );

  return session;
};

providerLaunchMapSchema.methods.updateActivity = async function () {
  this.lastActivityAt = new Date();
  await this.save();
};

providerLaunchMapSchema.methods.complete = async function () {
  this.status = "completed";
  this.completedAt = new Date();
  await this.save();
};

module.exports =
  mongoose.models.ProviderLaunchMap ||
  mongoose.model("ProviderLaunchMap", providerLaunchMapSchema);
