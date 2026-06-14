// callback-hub/controllers/CallbackController.js
const ProviderLaunchMap = require("../models/ProviderLaunchMap");
const ProcessedRound = require("../models/ProcessedRound");
const CallbackForwardService = require("../services/CallbackForwardService");

class CallbackController {
  /**
   * Handle incoming callback from provider
   *
   * CRITICAL FIX: NEVER modify the website's response.
   * The website's handleGameCallback() returns the correct balance.
   * Forward it EXACTLY as received.
   */
  static async handleProviderCallback(req, res) {
    const startTime = Date.now();
    const callbackData = req.body;

    const { member_account, game_uid, game_round, bet_amount, win_amount } =
      callbackData;

    console.log(
      `[Callback] Received: round=${game_round}, member=${member_account}, game=${game_uid}`,
    );

    // Early validation
    if (!member_account || !game_round || !game_uid) {
      console.error("[Callback] Missing required fields");
      return res.status(200).json({
        credit_amount: -1,
        error: "Missing required fields",
        timestamp: Date.now(),
      });
    }

    try {
      // STEP 1: Find active session
      const mapping =
        await ProviderLaunchMap.findSessionForCallback(callbackData);

      if (!mapping) {
        console.warn(
          `[Callback] No active session: member=${member_account}, game=${game_uid}`,
        );

        // Get balance from any means possible
        const fallbackBalance =
          await CallbackForwardService.getBalanceByMember(member_account);

        // Return fallback balance (not ideal but better than 0)
        return res.status(200).json({
          credit_amount: fallbackBalance >= 0 ? fallbackBalance : 0,
          timestamp: Date.now(),
          warning: "Session not found",
        });
      }

      // Update activity
      await mapping.updateActivity();

      // STEP 2: Duplicate prevention
      const isDuplicate = await ProcessedRound.isDuplicate(
        member_account,
        game_uid,
        game_round,
      );

      if (isDuplicate) {
        console.log(`[Callback] Duplicate prevented: round=${game_round}`);

        // CRITICAL FIX: Get ACTUAL balance from website for duplicate
        const currentBalance =
          await CallbackForwardService.getBalanceFromWebsite(
            mapping.callbackUrl,
            member_account,
          );

        return res.status(200).json({
          credit_amount: currentBalance,
          timestamp: Date.now(),
          duplicate: true,
        });
      }

      // STEP 3: Forward to website - THIS MUST RETURN WEBSITE'S EXACT RESPONSE
      const forwardResult = await CallbackForwardService.forwardToWebsite(
        mapping.callbackUrl,
        callbackData,
        mapping.website,
        mapping.providerSessionId,
      );

      // STEP 4: Mark as processed ONLY if website succeeded
      if (forwardResult.success && forwardResult.response) {
        await ProcessedRound.markProcessed({
          memberAccount: member_account,
          gameUid: game_uid,
          gameRound: game_round,
          mappingId: mapping._id,
          website: mapping.website,
          providerSessionId: mapping.providerSessionId,
          callbackData: callbackData,
          betAmount: bet_amount || 0,
          winAmount: win_amount || 0,
        });

        mapping.lastProcessedRound = game_round;
        await mapping.save();

        const duration = Date.now() - startTime;
        console.log(
          `[Callback] Success in ${duration}ms: round=${game_round}, balance=${forwardResult.response?.credit_amount}`,
        );

        // CRITICAL FIX: Return WEBSITE'S EXACT RESPONSE, not modified
        return res.status(200).json(forwardResult.response);
      }

      // STEP 5: Website failed - but we still need to respond to provider
      console.error(
        `[Callback] Website failed for round=${game_round}:`,
        forwardResult.error,
      );

      // CRITICAL FIX: Try to get current balance one more time
      const emergencyBalance =
        await CallbackForwardService.getBalanceFromWebsite(
          mapping.callbackUrl,
          member_account,
        );

      return res.status(200).json({
        credit_amount: emergencyBalance >= 0 ? emergencyBalance : 0,
        timestamp: Date.now(),
        error: forwardResult.error,
      });
    } catch (error) {
      console.error("[Callback] Fatal error:", error);

      // Last resort: try to get balance directly from database
      let emergencyBalance = 0;
      try {
        emergencyBalance =
          await CallbackForwardService.getBalanceByMember(member_account);
      } catch (e) {
        console.error("[Callback] Emergency balance failed:", e);
      }

      return res.status(200).json({
        credit_amount: emergencyBalance,
        timestamp: Date.now(),
        error: "Internal error",
      });
    }
  }

  /**
   * Register a new game launch session
   */
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
        return res.status(400).json({
          error: "Missing required fields",
        });
      }

      // Get callback URL
      let finalCallbackUrl = callbackUrl;
      if (!finalCallbackUrl) {
        const websiteCallbackUrls = {
          ck369: process.env.CK369_CALLBACK_URL,
          tenbet: process.env.TENBET_CALLBACK_URL,
          goldbet: process.env.GOLDBET_CALLBACK_URL,
        };
        finalCallbackUrl = websiteCallbackUrls[website];
      }

      // Create session (closes previous active ones)
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
        `[Register] Session #${mapping.sessionNumber}: ${providerSessionId}`,
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

  /**
   * Close session
   */
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
    res.json({
      status: "ok",
      timestamp: Date.now(),
      uptime: process.uptime(),
    });
  }
}

module.exports = CallbackController;
