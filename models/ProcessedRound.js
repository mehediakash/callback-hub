// callback-hub/models/ProcessedRound.js
const mongoose = require("mongoose");

/**
 * ProcessedRound - Prevents duplicate callback processing
 *
 * Since provider doesn't send session_id, we use:
 * (member_account + game_uid + game_round) as unique key
 *
 * This ensures we never process the same round twice
 * even if user has multiple sessions of same game.
 */
const processedRoundSchema = new mongoose.Schema(
  {
    // UNIQUE COMPOUND KEY: All fields provider sends + what we need
    memberAccount: {
      type: String,
      required: true,
    },

    gameUid: {
      type: String,
      required: true,
    },

    gameRound: {
      type: String,
      required: true,
    },

    // Reference to the launch mapping
    mappingId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ProviderLaunchMap",
      required: true,
    },

    // Website that processed this callback
    website: {
      type: String,
      required: true,
    },

    // Provider session ID (for debugging)
    providerSessionId: {
      type: String,
      required: false,
    },

    // Callback data snapshot
    callbackData: {
      type: mongoose.Schema.Types.Mixed,
      required: false,
    },

    // Processing metadata
    betAmount: {
      type: Number,
      default: 0,
    },

    winAmount: {
      type: Number,
      default: 0,
    },

    processedAt: {
      type: Date,
      default: Date.now,
    },

    // Retry tracking
    retryCount: {
      type: Number,
      default: 0,
    },

    // If processing failed
    failed: {
      type: Boolean,
      default: false,
    },

    errorMessage: {
      type: String,
      required: false,
    },
  },
  {
    timestamps: true,
  },
);

// UNIQUE INDEX - This prevents duplicate processing
// A specific round for a specific user+game can only be processed once
processedRoundSchema.index(
  { memberAccount: 1, gameUid: 1, gameRound: 1 },
  { unique: true },
);

// Indexes for query performance
processedRoundSchema.index({ mappingId: 1, processedAt: -1 });
processedRoundSchema.index({ memberAccount: 1, processedAt: -1 });
processedRoundSchema.index({ website: 1, processedAt: -1 });

// TTL index - Delete after 7 days (long enough for debugging)
processedRoundSchema.index({ processedAt: 1 }, { expireAfterSeconds: 604800 });

/**
 * Check if a round has already been processed
 */
processedRoundSchema.statics.isDuplicate = async function (
  memberAccount,
  gameUid,
  gameRound,
) {
  if (!memberAccount || !gameUid || !gameRound) {
    return false;
  }

  const exists = await this.exists({
    memberAccount: String(memberAccount),
    gameUid: String(gameUid),
    gameRound: String(gameRound),
  });

  return !!exists;
};

/**
 * Mark a round as processed
 */
processedRoundSchema.statics.markProcessed = async function ({
  memberAccount,
  gameUid,
  gameRound,
  mappingId,
  website,
  providerSessionId,
  callbackData,
  betAmount,
  winAmount,
}) {
  try {
    await this.create({
      memberAccount: String(memberAccount),
      gameUid: String(gameUid),
      gameRound: String(gameRound),
      mappingId,
      website,
      providerSessionId,
      callbackData,
      betAmount: betAmount || 0,
      winAmount: winAmount || 0,
      processedAt: new Date(),
    });
    return true;
  } catch (error) {
    // Duplicate key error (E11000) means already processed
    if (error.code === 11000) {
      return false;
    }
    throw error;
  }
};

/**
 * Mark a round as failed (for retry logic)
 */
processedRoundSchema.statics.markFailed = async function ({
  memberAccount,
  gameUid,
  gameRound,
  errorMessage,
}) {
  await this.updateOne(
    {
      memberAccount: String(memberAccount),
      gameUid: String(gameUid),
      gameRound: String(gameRound),
    },
    {
      $set: { failed: true, errorMessage },
      $inc: { retryCount: 1 },
    },
    { upsert: true },
  );
};

module.exports =
  mongoose.models.ProcessedRound ||
  mongoose.model("ProcessedRound", processedRoundSchema);
