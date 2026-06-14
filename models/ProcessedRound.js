// callback-hub/models/ProcessedRound.js
const mongoose = require("mongoose");

const processedRoundSchema = new mongoose.Schema(
  {
    // UNIQUE: Use gameRound + providerSessionId as originally designed
    gameRound: {
      type: String,
      required: true,
    },
    providerSessionId: {
      type: String,
      required: true,
    },
    // Additional fields for lookup by member_account + game_uid
    memberAccount: {
      type: String,
      required: true,
      index: true,
    },
    gameUid: {
      type: String,
      required: true,
    },
    mappingId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ProviderLaunchMap",
      required: true,
    },
    website: {
      type: String,
      required: true,
    },
    callbackData: {
      type: mongoose.Schema.Types.Mixed,
    },
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
    retryCount: {
      type: Number,
      default: 0,
    },
    failed: {
      type: Boolean,
      default: false,
    },
    errorMessage: {
      type: String,
    },
  },
  { timestamps: true },
);

// FIXED: Original unique index (gameRound + providerSessionId)
processedRoundSchema.index(
  { gameRound: 1, providerSessionId: 1 },
  { unique: true },
);

// Additional indexes for lookup
processedRoundSchema.index({ memberAccount: 1, gameUid: 1, gameRound: 1 });
processedRoundSchema.index({ mappingId: 1, processedAt: -1 });
processedRoundSchema.index({ processedAt: 1 }, { expireAfterSeconds: 604800 });

// FIXED: Original isDuplicate method (2 parameters)
processedRoundSchema.statics.isDuplicate = async function (
  gameRound,
  providerSessionId,
) {
  if (!gameRound || !providerSessionId) {
    console.log(
      `[DuplicateCheck] Missing params: round=${gameRound}, session=${providerSessionId}`,
    );
    return false;
  }

  const exists = await this.exists({
    gameRound: String(gameRound),
    providerSessionId: String(providerSessionId),
  });

  if (exists) {
    console.log(
      `[DuplicateCheck] DUPLICATE FOUND: round=${gameRound}, session=${providerSessionId}`,
    );
  } else {
    console.log(
      `[DuplicateCheck] NOT duplicate: round=${gameRound}, session=${providerSessionId}`,
    );
  }

  return !!exists;
};

// Additional method for member-based duplicate check (if needed)
processedRoundSchema.statics.isDuplicateByMember = async function (
  memberAccount,
  gameUid,
  gameRound,
) {
  const exists = await this.exists({
    memberAccount: String(memberAccount),
    gameUid: String(gameUid),
    gameRound: String(gameRound),
  });
  return !!exists;
};

// FIXED: markProcessed with correct unique fields
processedRoundSchema.statics.markProcessed = async function ({
  gameRound,
  providerSessionId,
  memberAccount,
  gameUid,
  mappingId,
  website,
  callbackData,
  betAmount,
  winAmount,
}) {
  try {
    const result = await this.create({
      gameRound: String(gameRound),
      providerSessionId: String(providerSessionId),
      memberAccount: String(memberAccount),
      gameUid: String(gameUid),
      mappingId,
      website,
      callbackData,
      betAmount: betAmount || 0,
      winAmount: winAmount || 0,
      processedAt: new Date(),
    });

    console.log(
      `[MarkProcessed] Success: round=${gameRound}, session=${providerSessionId}`,
    );
    return true;
  } catch (error) {
    if (error.code === 11000) {
      console.log(
        `[MarkProcessed] Already exists: round=${gameRound}, session=${providerSessionId}`,
      );
      return false;
    }
    console.error(`[MarkProcessed] Error:`, error.message);
    throw error;
  }
};

module.exports =
  mongoose.models.ProcessedRound ||
  mongoose.model("ProcessedRound", processedRoundSchema);
