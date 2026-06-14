// callback-hub/services/CallbackForwardService.js
const axios = require("axios");
const ProviderLaunchMap = require("../models/ProviderLaunchMap");

class CallbackForwardService {
  /**
   * Forward callback to website
   *
   * CRITICAL FIX:
   * 1. MUST return website's EXACT response
   * 2. Timeout increased to 5 seconds (some games need more time)
   * 3. NEVER use fallback balance unless website actually fails
   * 4. Preserve the website's credit_amount exactly
   */
  static async forwardToWebsite(
    callbackUrl,
    callbackData,
    website,
    providerSessionId,
  ) {
    const startTime = Date.now();
    const secret = process.env.INTERNAL_SECRET;

    if (!callbackUrl || callbackUrl === "undefined") {
      console.error(`[Forward] Invalid callback URL for ${website}`);
      return {
        success: false,
        error: "Invalid callback URL",
        response: null,
      };
    }

    try {
      // Increased timeout to 5 seconds (some game providers are slow)
      const response = await axios.post(callbackUrl, callbackData, {
        timeout: 5000, // 5 seconds - matches provider expectations
        headers: {
          "Content-Type": "application/json",
          "X-Callback-Secret": secret,
          "X-Original-Website": website,
          "X-Provider-Session-Id": providerSessionId || "",
          "X-Request-Timestamp": Date.now().toString(),
        },
      });

      const duration = Date.now() - startTime;

      // CRITICAL: Validate website response has credit_amount
      const creditAmount = response.data?.credit_amount;

      if (creditAmount === undefined || creditAmount === null) {
        console.error(
          `[Forward] Website returned no credit_amount:`,
          response.data,
        );
        return {
          success: false,
          error: "Website response missing credit_amount",
          response: null,
        };
      }

      console.log(
        `[Forward] Success in ${duration}ms: credit_amount=${creditAmount}, round=${callbackData.game_round}`,
      );

      // CRITICAL FIX: Return EXACT website response, don't modify
      return {
        success: true,
        response: {
          credit_amount: creditAmount,
          timestamp: response.data?.timestamp || Date.now(),
        },
        duration,
      };
    } catch (error) {
      const duration = Date.now() - startTime;

      // Timeout error
      if (error.code === "ECONNABORTED" || error.code === "ETIMEDOUT") {
        console.error(
          `[Forward] TIMEOUT (${duration}ms) for ${website}: round=${callbackData.game_round}`,
        );

        // CRITICAL FIX: Don't return fallback balance here
        // Return failure so controller can try emergency balance
        return {
          success: false,
          error: `Timeout after ${duration}ms`,
          response: null,
          timeout: true,
        };
      }

      // Website responded with error status
      if (error.response) {
        console.error(
          `[Forward] HTTP ${error.response.status} from ${website}:`,
          error.response.data,
        );

        return {
          success: false,
          error: `HTTP ${error.response.status}`,
          response: null,
          status: error.response.status,
        };
      }

      // Network errors
      console.error(`[Forward] Network error:`, error.message);

      return {
        success: false,
        error: error.message,
        response: null,
      };
    }
  }

  /**
   * Get balance directly from website API
   * This is used for:
   * 1. Duplicate callbacks
   * 2. Emergency fallback when main callback fails
   */
  static async getBalanceFromWebsite(callbackUrl, memberAccount) {
    try {
      const secret = process.env.INTERNAL_SECRET;

      // Extract base URL from callback URL
      const baseUrl = callbackUrl.replace("/internal/provider-callback", "");

      const response = await axios.get(`${baseUrl}/internal/balance`, {
        params: { memberAccount: String(memberAccount) },
        timeout: 3000, // 3 seconds for balance check
        headers: {
          "X-Callback-Secret": secret,
        },
      });

      const balance =
        response.data?.balance ?? response.data?.credit_amount ?? null;

      if (balance === null) {
        console.error(
          `[BalanceFromWebsite] No balance in response:`,
          response.data,
        );
        return 0;
      }

      const numericBalance =
        typeof balance === "number" ? balance : parseFloat(balance);

      console.log(
        `[BalanceFromWebsite] Got balance ${numericBalance} for ${memberAccount}`,
      );

      return isNaN(numericBalance) ? 0 : numericBalance;
    } catch (error) {
      console.error(
        `[BalanceFromWebsite] Error for ${memberAccount}:`,
        error.message,
      );
      return 0;
    }
  }

  /**
   * Get balance by member account (searches across websites)
   */
  static async getBalanceByMember(memberAccount) {
    try {
      // Find most recent session for this member
      const mapping = await ProviderLaunchMap.findOne({
        memberAccount: String(memberAccount),
      }).sort({ launchedAt: -1 });

      if (!mapping) {
        console.log(`[BalanceByMember] No mapping for ${memberAccount}`);
        return 0;
      }

      return await this.getBalanceFromWebsite(
        mapping.callbackUrl,
        memberAccount,
      );
    } catch (error) {
      console.error("[BalanceByMember] Error:", error.message);
      return 0;
    }
  }

  /**
   * Update session balance (called by website on successful callback)
   * This is OPTIONAL - used for debugging only
   */
  static async updateSessionBalance(providerSessionId, balance) {
    try {
      await ProviderLaunchMap.updateOne(
        { providerSessionId: String(providerSessionId) },
        {
          lastKnownBalance: balance,
          lastActivityAt: new Date(),
        },
      );
    } catch (error) {
      // Non-critical
    }
  }
}

module.exports = CallbackForwardService;
