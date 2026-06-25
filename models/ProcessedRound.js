// callback-hub/models/ProcessedRound.js
const mongoose = require("mongoose");

const DEBUG = process.env.DEBUG_CALLBACKS === "true";
const debugLog = (...args) => {
  if (DEBUG) console.log(...args);
};

const processedRoundSchema = new mongoose.Schema(
  {
    gameRound: { type: String, required: true },
    providerSessionId: { type: String, required: true },
    memberAccount: { type: String, required: true, index: true },
    userId: { type: String, index: true },
    gameUid: { type: String, required: true },
    mappingId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ProviderLaunchMap",
      required: true,
    },
    website: { type: String, required: true },
    callbackData: { type: mongoose.Schema.Types.Mixed },
    betAmount: { type: Number, default: 0 },
    winAmount: { type: Number, default: 0 },
    processedAt: { type: Date, default: Date.now },
    retryCount: { type: Number, default: 0 },
    failed: { type: Boolean, default: false },
    errorMessage: { type: String },
  },
  { timestamps: true },
);

// Unique index on gameRound + providerSessionId
processedRoundSchema.index(
  { gameRound: 1, providerSessionId: 1 },
  { unique: true },
);

// Additional indexes
processedRoundSchema.index({ memberAccount: 1, gameUid: 1, gameRound: 1 });
processedRoundSchema.index({
  website: 1,
  memberAccount: 1,
  gameUid: 1,
  gameRound: 1,
});
processedRoundSchema.index({ website: 1, userId: 1, gameRound: 1 });
processedRoundSchema.index({ mappingId: 1, processedAt: -1 });
processedRoundSchema.index({ processedAt: 1 }, { expireAfterSeconds: 604800 });

processedRoundSchema.statics.isDuplicate = async function (
  gameRound,
  providerSessionId,
  website = null,
) {
  if (!gameRound || !providerSessionId) {
    debugLog(
      `[ProcessedRound] Missing params: round=${gameRound}, session=${providerSessionId}`,
    );
    return false;
  }

  const query = {
    gameRound: String(gameRound),
    providerSessionId: String(providerSessionId),
  };

  if (website) {
    query.website = String(website);
  }

  const exists = await this.exists(query);

  if (exists) {
    debugLog(
      `[ProcessedRound] DUPLICATE: round=${gameRound}, session=${providerSessionId}`,
    );
  }

  return !!exists;
};

processedRoundSchema.statics.markProcessed = async function ({
  gameRound,
  providerSessionId,
  memberAccount,
  userId,
  gameUid,
  mappingId,
  website,
  callbackData,
  betAmount,
  winAmount,
}) {
  try {
    const processedAt = new Date();
    await this.collection.insertOne({
      _id: new mongoose.Types.ObjectId(),
      gameRound: String(gameRound),
      providerSessionId: String(providerSessionId),
      memberAccount: String(memberAccount),
      userId: userId ? String(userId) : undefined,
      gameUid: String(gameUid),
      mappingId,
      website,
      callbackData,
      betAmount: betAmount || 0,
      winAmount: winAmount || 0,
      retryCount: 0,
      failed: false,
      processedAt,
      createdAt: processedAt,
      updatedAt: processedAt,
    });

    debugLog(
      `[ProcessedRound] Marked processed: round=${gameRound}, session=${providerSessionId}`,
    );
    return true;
  } catch (error) {
    if (error.code === 11000) {
      debugLog(
        `[ProcessedRound] Already exists: round=${gameRound}, session=${providerSessionId}`,
      );
      return false;
    }
    console.error(`[ProcessedRound] Error:`, error.message);
    throw error;
  }
};

module.exports =
  mongoose.models.ProcessedRound ||
  mongoose.model("ProcessedRound", processedRoundSchema);
