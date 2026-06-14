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

    // LOG #1: Incoming callback
    console.log(`[Callback Received]`, {
      member: member_account,
      game: game_uid,
      round: game_round,
      bet: bet_amount,
      win: win_amount,
      timestamp: new Date().toISOString(),
    });

    if (!member_account || !game_round || !game_uid) {
      console.error("[Callback] Missing required fields");
      return res.status(200).json({
        credit_amount: -1,
        error: "Missing required fields",
        timestamp: Date.now(),
      });
    }

    try {
      // STEP 1: Find session
      const mapping =
        await ProviderLaunchMap.findSessionForCallback(callbackData);

      if (!mapping) {
        console.warn(
          `[Callback] No session: member=${member_account}, game=${game_uid}`,
        );

        // Try to get balance
        const fallbackBalance =
          await CallbackForwardService.getBalanceByMember(member_account);

        // LOG #2: No session found
        console.log(`[No Session Response]`, {
          credit_amount: fallbackBalance,
        });

        return res.status(200).json({
          credit_amount: fallbackBalance >= 0 ? fallbackBalance : 0,
          timestamp: Date.now(),
        });
      }

      // LOG #3: Session found
      console.log(`[Session Found]`, {
        sessionId: mapping.providerSessionId,
        website: mapping.website,
        member: mapping.memberAccount,
        game: mapping.gameUid,
        sessionNumber: mapping.sessionNumber,
      });

      await mapping.updateActivity();

      // STEP 2: FIXED - Duplicate check with correct parameters
      const isDuplicate = await ProcessedRound.isDuplicate(
        game_round, // FIXED: First param is gameRound
        mapping.providerSessionId, // FIXED: Second param is providerSessionId
      );

      // LOG #4: Duplicate check result
      console.log(`[Duplicate Check]`, {
        gameRound: game_round,
        providerSessionId: mapping.providerSessionId,
        isDuplicate,
      });

      if (isDuplicate) {
        // FIXED: Get actual balance from website, not fallback
        const currentBalance =
          await CallbackForwardService.getBalanceFromWebsite(
            mapping.callbackUrl,
            member_account,
          );

        // LOG #5: Duplicate response
        console.log(`[Duplicate Response]`, {
          credit_amount: currentBalance,
          round: game_round,
        });

        return res.status(200).json({
          credit_amount: currentBalance,
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

      // LOG #6: Forward result
      console.log(`[Forward Result]`, {
        success: forwardResult.success,
        hasResponse: !!forwardResult.response,
        creditAmount: forwardResult.response?.credit_amount,
        error: forwardResult.error,
        duration: forwardResult.duration,
      });

      // STEP 4: Mark as processed ONLY if we have a valid response
      if (
        forwardResult.success &&
        forwardResult.response &&
        forwardResult.response.credit_amount !== undefined
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
        await mapping.save();

        const duration = Date.now() - startTime;

        // LOG #7: Success response to provider
        console.log(`[Provider Response - SUCCESS]`, {
          credit_amount: forwardResult.response.credit_amount,
          round: game_round,
          duration_ms: duration,
        });

        // FIXED: Return website's exact response
        return res.status(200).json(forwardResult.response);
      }

      // STEP 5: Forward failed - try emergency balance
      console.error(`[Forward Failed]`, {
        error: forwardResult.error,
        round: game_round,
      });

      // FIXED: Try to get balance from website directly
      let emergencyBalance = await CallbackForwardService.getBalanceFromWebsite(
        mapping.callbackUrl,
        member_account,
      );

      // LOG #8: Emergency balance
      console.log(`[Emergency Balance]`, {
        credit_amount: emergencyBalance,
        round: game_round,
      });

      return res.status(200).json({
        credit_amount: emergencyBalance,
        timestamp: Date.now(),
        error: forwardResult.error,
      });
    } catch (error) {
      console.error("[Callback] Fatal error:", error);

      // Last resort: try to get balance from any website
      let lastResortBalance = 0;
      try {
        lastResortBalance =
          await CallbackForwardService.getBalanceByMember(member_account);
      } catch (e) {
        console.error("[Last Resort] Failed:", e);
      }

      // LOG #9: Fatal error response
      console.log(`[Provider Response - FATAL]`, {
        credit_amount: lastResortBalance,
        error: error.message,
      });

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

      const mapping = await ProviderLaunchMap.createSession({
        memberAccount: String(memberAccount),
        gameUid: String(gameUid),
        website,
        callbackUrl: finalCallbackUrl,
        providerSessionId: String(providerSessionId),
        userId: userId || null,
        gameName: gameName || null,
      });

      console.log(
        `[Register] Session #${mapping.sessionNumber}: ${providerSessionId} for ${memberAccount}`,
      );

      res.json({
        success: true,
        mappingId: mapping._id,
        sessionNumber: mapping.sessionNumber,
      });
    } catch (error) {
      console.error("[Register] Error:", error);
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
        await mapping.complete();
        console.log(`[CloseSession] Closed: ${providerSessionId}`);
      }

      res.json({ success: true });
    } catch (error) {
      console.error("[CloseSession] Error:", error);
      res.status(500).json({ error: error.message });
    }
  }

  static async healthCheck(req, res) {
    res.json({ status: "ok", timestamp: Date.now(), uptime: process.uptime() });
  }
}

module.exports = CallbackController;
