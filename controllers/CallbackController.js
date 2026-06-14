const mongoose = require("mongoose");
// callback-hub/controllers/CallbackController.js
const ProviderLaunchMap = require("../models/ProviderLaunchMap");
const ProcessedRound = require("../models/ProcessedRound");
const CallbackForwardService = require("../services/CallbackForwardService");

class CallbackController {
  /**
   * Handle incoming callback from provider (SoftAPI/JILI)
   *
   * Since provider doesn't send session_id, we use:
   * member_account + game_uid to find the active session
   */
  static async handleProviderCallback(req, res) {
    const startTime = Date.now();
    const callbackData = req.body;

    const { member_account, game_uid, game_round, bet_amount, win_amount } =
      callbackData;

    console.log(
      `[Callback] Received: round=${game_round}, member=${member_account}, game=${game_uid}`,
    );

    try {
      // VALIDATION: Ensure required fields exist
      if (!member_account || !game_round || !game_uid) {
        console.error("[Callback] Missing required fields:", {
          member_account,
          game_round,
          game_uid,
        });
        return res.status(200).json({
          credit_amount: -1,
          error: "Missing required fields",
          timestamp: Date.now(),
        });
      }

      // STEP 1: Find the active session for this user + game
      const mapping =
        await ProviderLaunchMap.findSessionForCallback(callbackData);

      if (!mapping) {
        console.warn(
          `[Callback] No active session found: member=${member_account}, game=${game_uid}, round=${game_round}`,
        );

        // Try to get current balance by looking up user across websites
        const fallbackBalance =
          await CallbackForwardService.getBalanceByMember(member_account);

        // Return 200 with current balance (provider can still function)
        return res.status(200).json({
          credit_amount: fallbackBalance,
          timestamp: Date.now(),
          warning: "Session not found, using fallback balance",
        });
      }

      // Update last activity timestamp
      await mapping.updateActivity();

      // STEP 2: Duplicate callback prevention
      // Using member_account + game_uid + game_round as unique key
      const isDuplicate = await ProcessedRound.isDuplicate(
        member_account,
        game_uid,
        game_round,
      );

      if (isDuplicate) {
        console.log(
          `[Callback] Duplicate prevented: round=${game_round}, member=${member_account}, game=${game_uid}`,
        );

        // Get current balance for duplicate response
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

      // STEP 3: Forward to website with timeout management
      const forwardResult = await CallbackForwardService.forwardToWebsite(
        mapping.callbackUrl,
        callbackData,
        mapping.website,
        mapping.providerSessionId, // Pass for debugging, but not used for lookup
      );

      // STEP 4: Mark round as processed (only if website succeeded)
      if (forwardResult.success) {
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

        // Update last processed round in mapping
        mapping.lastProcessedRound = game_round;
        await mapping.save();
      } else {
        // Website failed - mark as failed but don't block
        await ProcessedRound.markFailed({
          memberAccount: member_account,
          gameUid: game_uid,
          gameRound: game_round,
          errorMessage: forwardResult.error,
        });

        console.error(
          `[Callback] Forward failed for round=${game_round}:`,
          forwardResult.error,
        );
      }

      const duration = Date.now() - startTime;
      console.log(
        `[Callback] Processed in ${duration}ms: round=${game_round}, success=${forwardResult.success}`,
      );

      // Always return 200 to provider
      return res.status(200).json(
        forwardResult.response || {
          credit_amount: forwardResult.balance || 0,
          timestamp: Date.now(),
        },
      );
    } catch (error) {
      console.error("[Callback] Fatal error:", error);

      // CRITICAL: Always return 200 to provider on fatal errors
      return res.status(200).json({
        credit_amount: -1,
        error: "Internal processing error",
        timestamp: Date.now(),
      });
    }
  }

  /**
   * Register a new game launch session
   * Called by website backend before redirecting player to game
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

      // Validation
      if (!memberAccount || !website || !gameUid || !providerSessionId) {
        return res.status(400).json({
          error:
            "Missing required fields: memberAccount, website, gameUid, providerSessionId",
        });
      }

      // Get callback URL from config if not provided
      let finalCallbackUrl = callbackUrl;
      if (!finalCallbackUrl) {
        const websiteCallbackUrls = {
          ck369: process.env.CK369_CALLBACK_URL,
          tenbet: process.env.TENBET_CALLBACK_URL,
          goldbet: process.env.GOLDBET_CALLBACK_URL,
        };
        finalCallbackUrl = websiteCallbackUrls[website];
      }

      // Create new session (this automatically closes previous active sessions for this user+game)
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
        `[Register] New session #${mapping.sessionNumber}: website=${website}, member=${memberAccount}, game=${gameUid}, session=${providerSessionId}`,
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
   * Close a game session (called when game ends normally)
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
        console.log(`[CloseSession] Completed session: ${providerSessionId}`);
      }

      res.json({ success: true });
    } catch (error) {
      console.error("[CloseSession] Error:", error);
      res.status(500).json({ error: error.message });
    }
  }

  /**
   * Health check endpoint
   */
  static async healthCheck(req, res) {
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

  /**
   * Get session info (debugging)
   */
  static async getSession(req, res) {
    try {
      const { memberAccount, gameUid, providerSessionId } = req.query;

      let query = {};
      if (providerSessionId) {
        query = { providerSessionId: String(providerSessionId) };
      } else if (memberAccount && gameUid) {
        query = {
          memberAccount: String(memberAccount),
          gameUid: String(gameUid),
        };
      } else if (memberAccount) {
        query = { memberAccount: String(memberAccount) };
      } else {
        return res.status(400).json({
          error: "Provide memberAccount, gameUid, or providerSessionId",
        });
      }

      const mappings = await ProviderLaunchMap.find(query)
        .sort({ launchedAt: -1 })
        .limit(10);

      res.json({ mappings, count: mappings.length });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }

  /**
   * Get processed rounds (debugging)
   */
  static async getProcessedRounds(req, res) {
    try {
      const { memberAccount, gameUid, limit = 50 } = req.query;

      let query = {};
      if (memberAccount) query.memberAccount = String(memberAccount);
      if (gameUid) query.gameUid = String(gameUid);

      const rounds = await ProcessedRound.find(query)
        .sort({ processedAt: -1 })
        .limit(parseInt(limit));

      res.json({ rounds, count: rounds.length });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }
}

module.exports = CallbackController;
