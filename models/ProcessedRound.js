// callback-hub/models/ProcessedRound.js
const mongoose = require("mongoose");

const processedRoundSchema = new mongoose.Schema(
  {
    memberAccount: { type: String, required: true },
    gameUid: { type: String, required: true },
    gameRound: { type: String, required: true },
    mappingId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ProviderLaunchMap",
      required: true,
    },
    website: { type: String, required: true },
    providerSessionId: { type: String },
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

// UNIQUE INDEX - Prevents duplicates
processedRoundSchema.index(
  { memberAccount: 1, gameUid: 1, gameRound: 1 },
  { unique: true },
);

// Additional indexes
processedRoundSchema.index({ mappingId: 1, processedAt: -1 });
processedRoundSchema.index({ memberAccount: 1, processedAt: -1 });
processedRoundSchema.index({ processedAt: 1 }, { expireAfterSeconds: 604800 });

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

  if (exists) {
    console.log(`[DuplicateCheck] Round ${gameRound} already processed`);
  }

  return !!exists;
};

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

    console.log(`[MarkProcessed] Round ${gameRound} marked as processed`);
    return true;
  } catch (error) {
    if (error.code === 11000) {
      console.log(
        `[MarkProcessed] Round ${gameRound} already exists (duplicate)`,
      );
      return false;
    }
    throw error;
  }
};

module.exports =
  mongoose.models.ProcessedRound ||
  mongoose.model("ProcessedRound", processedRoundSchema);
