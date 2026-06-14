// callback-hub/models/ProviderLaunchMap.js
const mongoose = require("mongoose");

const providerLaunchMapSchema = new mongoose.Schema(
  {
    memberAccount: { type: String, required: true, index: true },
    gameUid: { type: String, required: true, index: true },
    website: {
      type: String,
      required: true,
      enum: ["ck369", "tenbet", "goldbet"],
    },
    callbackUrl: { type: String, required: true },
    providerSessionId: { type: String, required: true, unique: true },
    userId: { type: String },
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
providerLaunchMapSchema.index({
  memberAccount: 1,
  gameUid: 1,
  sessionNumber: -1,
});
providerLaunchMapSchema.index({ createdAt: 1 }, { expireAfterSeconds: 7200 });

providerLaunchMapSchema.statics.findSessionForCallback = async function (
  callbackData,
) {
  const { member_account, game_uid } = callbackData;

  console.log(
    `[ProviderLaunchMap] Looking for session: member=${member_account}, game=${game_uid}`,
  );

  const session = await this.findOne({
    memberAccount: String(member_account),
    gameUid: String(game_uid),
    status: "active",
  }).sort({ sessionNumber: -1, launchedAt: -1 });

  if (session) {
    console.log(
      `[ProviderLaunchMap] Found session #${session.sessionNumber}: ${session.providerSessionId}`,
    );
  } else {
    console.log(`[ProviderLaunchMap] No active session found`);
  }

  return session;
};

providerLaunchMapSchema.statics.createSession = async function ({
  memberAccount,
  gameUid,
  website,
  callbackUrl,
  providerSessionId,
  userId,
  gameName,
}) {
  const sessionCount = await this.countDocuments({
    memberAccount: String(memberAccount),
    gameUid: String(gameUid),
  });

  const sessionNumber = sessionCount + 1;

  const closedCount = await this.updateMany(
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

  if (closedCount.modifiedCount > 0) {
    console.log(
      `[ProviderLaunchMap] Closed ${closedCount.modifiedCount} previous sessions`,
    );
  }

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
    `[ProviderLaunchMap] Created session #${sessionNumber}: ${providerSessionId}`,
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
