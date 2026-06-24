// callback-hub/controllers/CallbackController.js
const ProviderLaunchMap = require("../models/ProviderLaunchMap");
const ProcessedRound = require("../models/ProcessedRound");
const CallbackForwardService = require("../services/CallbackForwardService");

class CallbackController {
  static async handleProviderCallback(req, res) {
    const startTime = Date.now();
    const callbackData = req.body;

    const { member_account, game_uid, game_round, bet_amount, win_amount } =
      callbackData;
    const websiteHint = req.query.website ? String(req.query.website) : null;
    const callbackSessionId =
      callbackData.session_id ||
      callbackData.sessionId ||
      callbackData.providerSessionId ||
      callbackData.provider_session_id ||
      null;

    console.log(`[CallbackHub] ========== PROVIDER CALLBACK ==========`);
    console.log(`[CallbackHub] Received:`, {
      member: member_account,
      game: game_uid,
      round: game_round,
      bet: bet_amount,
      win: win_amount,
      website: websiteHint,
      hasSessionId: !!callbackSessionId,
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
            member_account,
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
          websiteHint,
        );

        return fallbackBalance !== null && fallbackBalance >= 0
          ? fallbackBalance
          : 0;
      };

      // STEP 1: Find session - prefer an exact provider session when present.
      let mapping = null;

      if (callbackSessionId) {
        mapping = await ProviderLaunchMap.findOne({
          providerSessionId: String(callbackSessionId),
          ...(websiteHint ? { website: websiteHint } : {}),
        }).sort({ launchedAt: -1 });
      }

      // Try to find the most recent active session for this user+game.
      if (!mapping) {
        mapping = await ProviderLaunchMap.findOne({
          memberAccount: String(member_account),
          gameUid: String(game_uid),
          status: "active",
          ...(websiteHint ? { website: websiteHint } : {}),
        }).sort({ launchedAt: -1 }); // Get most recent
      }

      // If no active session, try to find ANY session from last 10 minutes
      if (!mapping) {
        console.log(
          `[CallbackHub] No active session, looking for recent session...`,
        );

        mapping = await ProviderLaunchMap.findOne({
          memberAccount: String(member_account),
          gameUid: String(game_uid),
          launchedAt: { $gt: new Date(Date.now() - 10 * 60 * 1000) },
          ...(websiteHint ? { website: websiteHint } : {}),
        }).sort({ launchedAt: -1 });

        if (mapping) {
          console.log(
            `[CallbackHub] Found recent session with status=${mapping.status}, reactivating...`,
          );
          mapping.status = "active";
          mapping.lastActivityAt = new Date();
          await mapping.save();
        }
      }

      if (!mapping) {
        console.error(
          `[CallbackHub] NO SESSION FOUND for member=${member_account}, game=${game_uid}`,
        );

        // Log all sessions for debugging
        const allSessions = await ProviderLaunchMap.find({
          memberAccount: String(member_account),
        })
          .sort({ launchedAt: -1 })
          .limit(10);

        console.error(
          `[CallbackHub] Recent sessions for user:`,
          allSessions.map((s) => ({
            sessionId: s.providerSessionId,
            gameUid: s.gameUid,
            status: s.status,
            launchedAt: s.launchedAt,
          })),
        );

        const finalBalance = await balanceForMapping(null);

        console.log(
          `[CallbackHub] No session response: credit_amount=${finalBalance}`,
        );

        return res.status(200).json({
          credit_amount: finalBalance,
          timestamp: Date.now(),
          warning: "Session not found",
        });
      }

      console.log(`[CallbackHub] Using session:`, {
        sessionId: mapping.providerSessionId,
        website: mapping.website,
        member: mapping.memberAccount,
        game: mapping.gameUid,
        sessionNumber: mapping.sessionNumber,
        status: mapping.status,
        launchedAt: mapping.launchedAt,
      });

      await mapping.updateActivity();

      // STEP 2: Duplicate check
      const isDuplicate = await ProcessedRound.isDuplicate(
        game_round,
        mapping.providerSessionId,
      );

      console.log(`[CallbackHub] Duplicate check:`, {
        gameRound: game_round,
        providerSessionId: mapping.providerSessionId,
        isDuplicate,
      });

      if (isDuplicate) {
        const finalBalance = await balanceForMapping(mapping);

        console.log(
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
      );

      console.log(`[CallbackHub] Forward result:`, {
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
          memberAccount: member_account,
          gameUid: game_uid,
          mappingId: mapping._id,
          website: mapping.website,
          callbackData: callbackData,
          betAmount: bet_amount || 0,
          winAmount: win_amount || 0,
        });

        mapping.lastProcessedRound = game_round;
        mapping.lastKnownBalance = forwardResult.response.credit_amount;
        await mapping.save();

        const duration = Date.now() - startTime;

        console.log(`[CallbackHub] SUCCESS - Returning to provider:`, {
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

      console.log(`[CallbackHub] Emergency balance: ${finalBalance}`);

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
          websiteHint,
        );
        lastResortBalance = fallback !== null && fallback >= 0 ? fallback : 0;
      } catch (e) {
        console.error("[CallbackHub] Last resort failed:", e);
      }

      console.log(
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

      console.log(`[CallbackHub] Register launch:`, {
        memberAccount,
        website,
        gameUid,
        providerSessionId,
        gameName,
      });

      if (!memberAccount || !website || !gameUid || !providerSessionId) {
        return res.status(400).json({ error: "Missing required fields" });
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
      });

      const sessionNumber = sessionCount + 1;

      const mapping = await ProviderLaunchMap.create({
        memberAccount: String(memberAccount),
        gameUid: String(gameUid),
        website,
        callbackUrl: finalCallbackUrl,
        providerSessionId: String(providerSessionId),
        userId: userId || null,
        gameName: gameName || null,
        sessionNumber,
        status: "active",
        launchedAt: new Date(),
        lastActivityAt: new Date(),
      });

      console.log(
        `[CallbackHub] Session registered: #${mapping.sessionNumber} - ${providerSessionId}`,
      );
      console.log(
        `[CallbackHub] User ${memberAccount} now has ${await ProviderLaunchMap.countDocuments({ memberAccount: String(memberAccount), status: "active" })} active sessions`,
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
        console.log(`[CallbackHub] Session closed: ${providerSessionId}`);
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
