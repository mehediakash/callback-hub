// callback-hub/models/ProviderLaunchMap.js
const mongoose = require("mongoose");

/**
 * ProviderLaunchMap - Maps active game sessions
 *
 * Since provider doesn't return session_id in callbacks,
 * we use (memberAccount + gameUid) as the lookup key.
 *
 * For multiple sessions of same game by same user:
 * We track the most recent active session and use sequential
 * processing with round-based duplicate prevention.
 */
const providerLaunchMapSchema = new mongoose.Schema(
  {
    // COMPOSITE KEY for lookup (what we receive in callback)
    memberAccount: {
      type: String,
      required: true,
      index: true,
    },

    gameUid: {
      type: String,
      required: true,
      index: true,
    },

    // Website identification
    website: {
      type: String,
      required: true,
      enum: ["ck369", "tenbet", "goldbet"],
      index: true,
    },

    // Internal callback URL for this website
    callbackUrl: {
      type: String,
      required: true,
    },

    // Store the provider session ID from launch even though we don't get it back
    // This is useful for debugging and session management
    providerSessionId: {
      type: String,
      required: true,
      unique: true,
    },

    // User's internal MongoDB ID
    userId: {
      type: String,
      required: false,
    },

    // Game metadata
    gameName: {
      type: String,
      required: false,
    },

    // Session timing
    launchedAt: {
      type: Date,
      default: Date.now,
    },

    lastActivityAt: {
      type: Date,
      default: Date.now,
    },

    // Status tracking
    status: {
      type: String,
      enum: ["active", "completed", "expired"],
      default: "active",
    },

    // Track the last processed game round (for ordering)
    lastProcessedRound: {
      type: String,
      default: null,
    },

    // Session order for same user+game (1, 2, 3...)
    sessionNumber: {
      type: Number,
      default: 1,
    },

    // Additional metadata
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  {
    timestamps: true,
  },
);

// COMPOUND INDEX for lookup (this is what we use to find the session)
// Since provider sends member_account + game_uid in callback
providerLaunchMapSchema.index({ memberAccount: 1, gameUid: 1, status: 1 });

// Index for finding most recent session
providerLaunchMapSchema.index({
  memberAccount: 1,
  gameUid: 1,
  sessionNumber: -1,
});

// TTL index - Auto-delete after 2 hours
providerLaunchMapSchema.index({ createdAt: 1 }, { expireAfterSeconds: 7200 });

/**
 * Find the active session for a callback
 * Strategy: Get the most recent active session for this user+game
 *
 * Why this works:
 * - Provider sends callbacks in chronological order per game session
 * - If user has multiple sessions of same game, they play sequentially
 * - The most recent session is the active one
 */
providerLaunchMapSchema.statics.findSessionForCallback = async function (
  callbackData,
) {
  const { member_account, game_uid } = callbackData;

  if (!member_account || !game_uid) {
    return null;
  }

  // Find the most recent ACTIVE session for this user+game
  const session = await this.findOne({
    memberAccount: String(member_account),
    gameUid: String(game_uid),
    status: "active",
  }).sort({ sessionNumber: -1, launchedAt: -1 });

  return session;
};

/**
 * Create a new session with proper session numbering
 */
providerLaunchMapSchema.statics.createSession = async function ({
  memberAccount,
  gameUid,
  website,
  callbackUrl,
  providerSessionId,
  userId,
  gameName,
}) {
  // Count existing sessions for this user+game (including completed)
  const sessionCount = await this.countDocuments({
    memberAccount: String(memberAccount),
    gameUid: String(gameUid),
  });

  // New session number = count + 1
  const sessionNumber = sessionCount + 1;

  // Close any "active" sessions for this user+game
  // A user can only have ONE active session per game at a time
  // because provider processes sequentially
  await this.updateMany(
    {
      memberAccount: String(memberAccount),
      gameUid: String(gameUid),
      status: "active",
    },
    {
      status: "completed",
      completedAt: new Date(),
    },
  );

  // Create new session
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

  return session;
};

/**
 * Update session activity
 */
providerLaunchMapSchema.methods.updateActivity = async function () {
  this.lastActivityAt = new Date();
  await this.save();
};

/**
 * Mark session as completed
 */
providerLaunchMapSchema.methods.complete = async function () {
  this.status = "completed";
  this.completedAt = new Date();
  await this.save();
};

module.exports =
  mongoose.models.ProviderLaunchMap ||
  mongoose.model("ProviderLaunchMap", providerLaunchMapSchema);
