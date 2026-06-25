// callback-hub/controllers/CallbackController.js
const ProviderLaunchMap = require("../models/ProviderLaunchMap");
const ProcessedRound = require("../models/ProcessedRound");
const CallbackForwardService = require("../services/CallbackForwardService");
const CallbackCacheService = require("../services/CallbackCacheService");
const mongoose = require("mongoose");

const DEBUG = process.env.DEBUG_CALLBACKS === "true";
const debugLog = (...args) => {
  if (DEBUG) console.log(...args);
};

class CallbackController {
  static async handleProviderCallback(req, res) {
    const startTime = Date.now();
    const callbackData = req.body;

    const { member_account, game_uid, game_round, bet_amount, win_amount } =
      callbackData;
    const callbackSessionId =
      callbackData.session_id ||
      callbackData.sessionId ||
      callbackData.providerSessionId ||
      callbackData.provider_session_id ||
      null;
    const callbackUserIdCandidate =
      callbackData.userId || callbackData.user_id || member_account || null;
    const callbackUserId = mongoose.Types.ObjectId.isValid(
      String(callbackUserIdCandidate),
    )
      ? String(callbackUserIdCandidate)
      : null;

    debugLog(`[CallbackHub] Received:`, {
      member: member_account,
      game: game_uid,
      round: game_round,
      bet: bet_amount,
      win: win_amount,
      website: "resolved from ProviderLaunchMap",
      userId: callbackUserId,
      memberAccount: member_account,
      providerSessionId: callbackSessionId,
      gameUid: game_uid,
      hasSessionId: !!callbackSessionId,
      hasUserId: !!callbackUserId,
      timestamp: new Date().toISOString(),
    });

    if (!member_account || !game_round || !game_uid) {
      console.error("[CallbackHub] Missing required fields");
      return res.status(200).json({
        credit_amount: -1,
        error: "Missing required fields",
        timestamp: Date.now(),
      });
    }

    try {
      const balanceForMapping = async (selectedMapping) => {
        let websiteBalance = null;

        if (selectedMapping?.callbackUrl) {
          websiteBalance = await CallbackForwardService.getBalanceFromWebsite(
            selectedMapping.callbackUrl,
            selectedMapping.memberAccount,
            selectedMapping.userId,
          );
        }

        if (websiteBalance !== null && websiteBalance >= 0) {
          return websiteBalance;
        }

        if (
          selectedMapping?.lastKnownBalance !== undefined &&
          selectedMapping.lastKnownBalance >= 0
        ) {
          return selectedMapping.lastKnownBalance;
        }

        const fallbackBalance = await CallbackForwardService.getBalanceByMember(
          member_account,
          null,
          callbackUserId,
        );

        return fallbackBalance !== null && fallbackBalance >= 0
          ? fallbackBalance
          : 0;
      };

      // Website routing is derived only from the map selected by its provider
      // session ID, then MongoDB user ID, then the scoped legacy fallback.
      const redisSessionStartedAt = Date.now();
      let mapping = callbackSessionId
        ? await CallbackCacheService.getMappingByProvider(callbackSessionId)
        : null;
      const redisSessionHit = !!mapping;
      const redisSessionMs = Date.now() - redisSessionStartedAt;

      if (!mapping) {
        const mongoSessionStartedAt = Date.now();
        mapping = await ProviderLaunchMap.findSessionForCallback({
          member_account,
          game_uid,
          userId: callbackUserId,
          providerSessionId: callbackSessionId,
        });
        const mongoSessionMs = Date.now() - mongoSessionStartedAt;
        debugLog("[CallbackHub] Mongo session lookup timing:", {
          mongoSessionMs,
        });

        if (mapping) {
          CallbackCacheService.cacheMapping(mapping).catch((error) =>
            console.warn(
              "[CallbackHub] Redis mapping cache failed:",
              error.message,
            ),
          );
        }
      }

      debugLog("[CallbackHub] Redis session lookup timing:", {
        redisSessionMs,
        hit: redisSessionHit,
      });

      if (!mapping) {
        console.error(
          `[CallbackHub] NO SESSION FOUND for member=${member_account}, game=${game_uid}`,
        );

        // Log all sessions for debugging
        const allSessions = await ProviderLaunchMap.find({
          memberAccount: String(member_account),
        })
          .sort({ launchedAt: -1 })
          .limit(10)
          .lean();

        console.error(
          `[CallbackHub] Recent sessions for user:`,
          allSessions.map((s) => ({
            sessionId: s.providerSessionId,
            website: s.website,
            userId: s.userId,
            gameUid: s.gameUid,
            status: s.status,
            launchedAt: s.launchedAt,
          })),
        );

        const finalBalance = await balanceForMapping(null);

        debugLog(
          `[CallbackHub] No session response: credit_amount=${finalBalance}`,
        );

        return res.status(200).json({
          credit_amount: finalBalance,
          timestamp: Date.now(),
          warning: "Session not found",
        });
      }

      debugLog(`[CallbackHub] Using session:`, {
        sessionId: mapping.providerSessionId,
        website: mapping.website,
        userId: mapping.userId,
        member: mapping.memberAccount,
        game: mapping.gameUid,
        sessionNumber: mapping.sessionNumber,
        status: mapping.status,
        launchedAt: mapping.launchedAt,
      });

      ProviderLaunchMap.updateOne(
        { _id: mapping._id },
        { $set: { lastActivityAt: new Date() } },
      ).catch((error) =>
        console.error("[CallbackHub] Activity update failed:", error.message),
      );

      // STEP 2: Duplicate check
      const redisDuplicateStartedAt = Date.now();
      let isDuplicate = await CallbackCacheService.isDuplicateRound(
        mapping.website,
        mapping.providerSessionId,
        game_round,
      );
      const redisDuplicateMs = Date.now() - redisDuplicateStartedAt;

      if (!isDuplicate) {
        const mongoDuplicateStartedAt = Date.now();
        isDuplicate = await ProcessedRound.isDuplicate(
          game_round,
          mapping.providerSessionId,
          mapping.website,
        );
        const mongoDuplicateMs = Date.now() - mongoDuplicateStartedAt;
        debugLog("[CallbackHub] Mongo duplicate timing:", {
          mongoDuplicateMs,
        });

        if (isDuplicate) {
          CallbackCacheService.markProcessedRound({
            website: mapping.website,
            providerSessionId: mapping.providerSessionId,
            gameRound: game_round,
          }).catch((error) =>
            console.warn(
              "[CallbackHub] Redis duplicate cache failed:",
              error.message,
            ),
          );
        }
      }

      debugLog(`[CallbackHub] Duplicate check:`, {
        gameRound: game_round,
        providerSessionId: mapping.providerSessionId,
        isDuplicate,
        redisDuplicateMs,
      });

      if (isDuplicate) {
        const finalBalance = await balanceForMapping(mapping);

        debugLog(
          `[CallbackHub] Duplicate response: credit_amount=${finalBalance}`,
        );

        return res.status(200).json({
          credit_amount: finalBalance,
          timestamp: Date.now(),
          duplicate: true,
        });
      }

      // STEP 3: Forward to website
      const forwardResult = await CallbackForwardService.forwardToWebsite(
        mapping.callbackUrl,
        callbackData,
        mapping.website,
        mapping.providerSessionId,
        mapping.userId,
      );

      debugLog(`[CallbackHub] Forward result:`, {
        success: forwardResult.success,
        hasResponse: !!forwardResult.response,
        creditAmount: forwardResult.response?.credit_amount,
        error: forwardResult.error,
        duration: forwardResult.duration,
      });

      // STEP 4: Mark as processed if successful
      if (
        forwardResult.success &&
        forwardResult.response &&
        forwardResult.response.credit_amount !== undefined &&
        forwardResult.response.credit_amount >= 0
      ) {
        await ProcessedRound.markProcessed({
          gameRound: game_round,
          providerSessionId: mapping.providerSessionId,
          memberAccount: mapping.memberAccount,
          userId: mapping.userId,
          gameUid: game_uid,
          mappingId: mapping._id,
          website: mapping.website,
          callbackData: callbackData,
          betAmount: bet_amount || 0,
          winAmount: win_amount || 0,
        });

        await ProviderLaunchMap.updateOne(
          { _id: mapping._id },
          {
            $set: {
              lastProcessedRound: game_round,
              lastKnownBalance: forwardResult.response.credit_amount,
              lastActivityAt: new Date(),
            },
          },
        );

        CallbackCacheService.markProcessedRound({
          website: mapping.website,
          providerSessionId: mapping.providerSessionId,
          gameRound: game_round,
          creditAmount: forwardResult.response.credit_amount,
        }).catch((error) =>
          console.warn(
            "[CallbackHub] Redis processed round cache failed:",
            error.message,
          ),
        );
        CallbackCacheService.updateMapping(mapping, {
          lastProcessedRound: game_round,
          lastKnownBalance: forwardResult.response.credit_amount,
        }).catch((error) =>
          console.warn(
            "[CallbackHub] Redis mapping update failed:",
            error.message,
          ),
        );

        const duration = Date.now() - startTime;

        debugLog(`[CallbackHub] SUCCESS - Returning to provider:`, {
          credit_amount: forwardResult.response.credit_amount,
          round: game_round,
          duration_ms: duration,
        });

        return res.status(200).json(forwardResult.response);
      }

      // STEP 5: Forward failed - try emergency balance
      console.error(`[CallbackHub] Forward failed:`, {
        error: forwardResult.error,
        creditAmount: forwardResult.response?.credit_amount,
        round: game_round,
      });

      const finalBalance = await balanceForMapping(mapping);

      debugLog(`[CallbackHub] Emergency balance: ${finalBalance}`);

      return res.status(200).json({
        credit_amount: finalBalance,
        timestamp: Date.now(),
        error: forwardResult.error,
      });
    } catch (error) {
      console.error("[CallbackHub] Fatal error:", error);
      console.error("[CallbackHub] Error stack:", error.stack);

      let lastResortBalance = 0;
      try {
        const fallback = await CallbackForwardService.getBalanceByMember(
          member_account,
          null,
          callbackUserId,
        );
        lastResortBalance = fallback !== null && fallback >= 0 ? fallback : 0;
      } catch (e) {
        console.error("[CallbackHub] Last resort failed:", e);
      }

      debugLog(
        `[CallbackHub] Fatal error response: credit_amount=${lastResortBalance}`,
      );

      return res.status(200).json({
        credit_amount: lastResortBalance,
        timestamp: Date.now(),
        error: "Internal error",
      });
    }
  }

  static async registerLaunch(req, res) {
    try {
      const {
        memberAccount,
        website,
        gameUid,
        providerSessionId,
        userId,
        gameName,
        callbackUrl,
      } = req.body;

      debugLog(`[CallbackHub] Register launch:`, {
        memberAccount,
        userId,
        website,
        gameUid,
        providerSessionId,
        gameName,
      });

      if (
        !memberAccount ||
        !website ||
        !gameUid ||
        !providerSessionId ||
        !userId
      ) {
        return res.status(400).json({ error: "Missing required fields" });
      }

      if (!mongoose.Types.ObjectId.isValid(String(userId))) {
        return res.status(400).json({ error: "Invalid userId" });
      }

      let finalCallbackUrl = callbackUrl;
      if (!finalCallbackUrl) {
        const websiteCallbackUrls = {
          ck369: process.env.CK369_CALLBACK_URL,
          tenbet: process.env.TENBET_CALLBACK_URL,
          goldbet: process.env.GOLDBET_CALLBACK_URL,
        };
        finalCallbackUrl = websiteCallbackUrls[website];
      }

      if (!finalCallbackUrl) {
        console.error(`[CallbackHub] Missing callback URL for website`, {
          website,
          providerSessionId,
        });
        return res.status(400).json({ error: "Missing callback URL" });
      }

      // FIXED: Don't close previous sessions - just create new one
      const sessionCount = await ProviderLaunchMap.countDocuments({
        memberAccount: String(memberAccount),
        gameUid: String(gameUid),
        website,
      });

      const sessionNumber = sessionCount + 1;

      const mapping = await ProviderLaunchMap.create({
        memberAccount: String(memberAccount),
        gameUid: String(gameUid),
        website,
        callbackUrl: finalCallbackUrl,
        providerSessionId: String(providerSessionId),
        userId: String(userId),
        gameName: gameName || null,
        sessionNumber,
        status: "active",
        launchedAt: new Date(),
        lastActivityAt: new Date(),
      });

      debugLog(
        `[CallbackHub] Session registered: #${mapping.sessionNumber} - ${providerSessionId}`,
      );

      CallbackCacheService.cacheMapping(mapping).catch((error) =>
        console.warn(
          "[CallbackHub] Redis launch mapping cache failed:",
          error.message,
        ),
      );

      res.json({
        success: true,
        mappingId: mapping._id,
        sessionNumber: mapping.sessionNumber,
      });
    } catch (error) {
      console.error("[CallbackHub] Register error:", error);
      res.status(500).json({ error: error.message });
    }
  }

  static async closeSession(req, res) {
    try {
      const { providerSessionId } = req.body;

      if (!providerSessionId) {
        return res.status(400).json({ error: "providerSessionId required" });
      }

      const mapping = await ProviderLaunchMap.findOne({
        providerSessionId: String(providerSessionId),
      });

      if (mapping && mapping.status === "active") {
        mapping.status = "completed";
        mapping.completedAt = new Date();
        await mapping.save();
        CallbackCacheService.removeMapping(mapping).catch((error) =>
          console.warn(
            "[CallbackHub] Redis mapping removal failed:",
            error.message,
          ),
        );
        debugLog(`[CallbackHub] Session closed: ${providerSessionId}`);
      }

      res.json({ success: true });
    } catch (error) {
      console.error("[CallbackHub] Close session error:", error);
      res.status(500).json({ error: error.message });
    }
  }

  static async healthCheck(req, res) {
    const mongoose = require("mongoose");
    const dbState = mongoose.connection.readyState;
    const dbStatus = {
      0: "disconnected",
      1: "connected",
      2: "connecting",
      3: "disconnecting",
    }[dbState];

    res.json({
      status: "ok",
      db: dbStatus,
      timestamp: Date.now(),
      uptime: process.uptime(),
    });
  }
}

module.exports = CallbackController;
