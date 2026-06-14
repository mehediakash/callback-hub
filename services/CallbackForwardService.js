// callback-hub/services/CallbackForwardService.js
const axios = require("axios");
const ProviderLaunchMap = require("../models/ProviderLaunchMap");

class CallbackForwardService {
  /**
   * Forward callback to website's internal endpoint
   *
   * Timeout strategy:
   * - 3 second timeout for website response
   * - Provider expects response within 3 seconds total
   */
  static async forwardToWebsite(
    callbackUrl,
    callbackData,
    website,
    providerSessionId,
  ) {
    const startTime = Date.now();
    const secret = process.env.INTERNAL_SECRET;

    // Validate callback URL
    if (!callbackUrl || callbackUrl === "undefined") {
      console.error(`[Forward] Invalid callback URL for website: ${website}`);
      return {
        success: false,
        error: "Invalid callback URL",
        response: { credit_amount: -1, timestamp: Date.now() },
        balance: -1,
      };
    }

    try {
      // 3 second timeout total
      const response = await axios.post(callbackUrl, callbackData, {
        timeout: 3000,
        headers: {
          "Content-Type": "application/json",
          "X-Callback-Secret": secret,
          "X-Original-Website": website,
          "X-Provider-Session-Id": providerSessionId || "",
          "X-Request-Timestamp": Date.now().toString(),
        },
      });

      const duration = Date.now() - startTime;

      const creditAmount =
        response.data?.credit_amount ?? response.data?.balance ?? 0;

      if (duration > 2800) {
        console.warn(
          `[Forward] Slow response (${duration}ms) for ${website}, round=${callbackData.game_round}`,
        );
      }

      return {
        success: true,
        response: {
          credit_amount: creditAmount,
          timestamp: response.data?.timestamp || Date.now(),
        },
        balance: creditAmount,
        duration,
        status: response.status,
      };
    } catch (error) {
      const duration = Date.now() - startTime;

      // Handle timeout
      if (error.code === "ECONNABORTED" || error.code === "ETIMEDOUT") {
        console.error(
          `[Forward] Timeout (${duration}ms) for ${website}: ${callbackUrl}`,
        );

        const fallbackBalance = await this.getFallbackBalance(
          providerSessionId,
          callbackData.member_account,
        );

        return {
          success: false,
          error: "Timeout",
          response: {
            credit_amount: fallbackBalance,
            timestamp: Date.now(),
            error: "Processing timeout",
          },
          balance: fallbackBalance,
          timeout: true,
        };
      }

      // Website responded with error
      if (error.response) {
        console.error(
          `[Forward] HTTP ${error.response.status} from ${website}:`,
          error.response.data,
        );

        const fallbackBalance = await this.getFallbackBalance(
          providerSessionId,
          callbackData.member_account,
        );

        return {
          success: false,
          error: `HTTP ${error.response.status}`,
          response: error.response.data || { credit_amount: fallbackBalance },
          balance: fallbackBalance,
          status: error.response.status,
        };
      }

      // Network errors
      console.error(`[Forward] Network error for ${website}:`, error.message);

      const fallbackBalance = await this.getFallbackBalance(
        providerSessionId,
        callbackData.member_account,
      );

      return {
        success: false,
        error: error.message,
        response: { credit_amount: fallbackBalance, timestamp: Date.now() },
        balance: fallbackBalance,
      };
    }
  }

  /**
   * Get fallback balance when website is unreachable
   */
  static async getFallbackBalance(providerSessionId, memberAccount) {
    try {
      // Try to get from session mapping
      if (providerSessionId) {
        const mapping = await ProviderLaunchMap.findOne({ providerSessionId });
        if (mapping && mapping.lastKnownBalance) {
          return mapping.lastKnownBalance;
        }
      }

      // Try direct balance API call
      if (memberAccount) {
        const balance = await this.getBalanceByMember(memberAccount);
        if (balance !== null && balance !== -1) {
          return balance;
        }
      }

      return 0;
    } catch (error) {
      console.error("[Fallback] Error:", error.message);
      return 0;
    }
  }

  /**
   * Get current balance by member account
   */
  static async getBalanceByMember(memberAccount) {
    try {
      const mapping = await ProviderLaunchMap.findOne({
        memberAccount: String(memberAccount),
      }).sort({ launchedAt: -1 });

      if (!mapping) {
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
   * Get balance directly from website API
   */
  static async getBalanceFromWebsite(callbackUrl, memberAccount) {
    try {
      const secret = process.env.INTERNAL_SECRET;

      const baseUrl = callbackUrl.replace("/internal/provider-callback", "");

      const response = await axios.get(`${baseUrl}/internal/balance`, {
        params: { memberAccount: String(memberAccount) },
        timeout: 2000,
        headers: {
          "X-Callback-Secret": secret,
        },
      });

      const balance =
        response.data?.balance ?? response.data?.credit_amount ?? 0;
      return typeof balance === "number" ? balance : parseFloat(balance) || 0;
    } catch (error) {
      console.error(`[BalanceFromWebsite] Error:`, error.message);
      return 0;
    }
  }

  /**
   * Update last known balance for a session
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
      console.error("[UpdateBalance] Error:", error.message);
    }
  }
}

module.exports = CallbackForwardService;
