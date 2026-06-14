// callback-hub/services/CallbackForwardService.js
const axios = require("axios");
const ProviderLaunchMap = require("../models/ProviderLaunchMap");

class CallbackForwardService {
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
      const response = await axios.post(callbackUrl, callbackData, {
        timeout: 5000,
        headers: {
          "Content-Type": "application/json",
          "X-Callback-Secret": secret,
          "X-Original-Website": website,
          "X-Provider-Session-Id": providerSessionId || "",
          "X-Request-Timestamp": Date.now().toString(),
        },
      });

      const duration = Date.now() - startTime;

      // Validate response
      const creditAmount = response.data?.credit_amount;

      if (creditAmount === undefined || creditAmount === null) {
        console.error(`[Forward] Missing credit_amount:`, response.data);
        return {
          success: false,
          error: "Missing credit_amount in response",
          response: null,
        };
      }

      if (typeof creditAmount !== "number" || isNaN(creditAmount)) {
        console.error(`[Forward] Invalid credit_amount: ${creditAmount}`);
        return {
          success: false,
          error: "Invalid credit_amount type",
          response: null,
        };
      }

      console.log(
        `[Forward] Success: balance=${creditAmount}, duration=${duration}ms`,
      );

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

      if (error.code === "ECONNABORTED" || error.code === "ETIMEDOUT") {
        console.error(`[Forward] Timeout after ${duration}ms`);
        return {
          success: false,
          error: `Timeout after ${duration}ms`,
          response: null,
          timeout: true,
        };
      }

      if (error.response) {
        console.error(
          `[Forward] HTTP ${error.response.status}:`,
          error.response.data,
        );
        return {
          success: false,
          error: `HTTP ${error.response.status}`,
          response: null,
        };
      }

      console.error(`[Forward] Network error:`, error.message);
      return {
        success: false,
        error: error.message,
        response: null,
      };
    }
  }

  // FIXED: getBalanceFromWebsite with proper error handling
  static async getBalanceFromWebsite(callbackUrl, memberAccount) {
    try {
      const secret = process.env.INTERNAL_SECRET;
      const baseUrl = callbackUrl.replace("/internal/provider-callback", "");

      console.log(
        `[GetBalance] Requesting from ${baseUrl}/internal/balance for ${memberAccount}`,
      );

      const response = await axios.get(`${baseUrl}/internal/balance`, {
        params: { memberAccount: String(memberAccount) },
        timeout: 3000,
        headers: {
          "X-Callback-Secret": secret,
        },
      });

      // FIXED: Handle different response formats
      let balance = null;

      if (response.data?.balance !== undefined) {
        balance = response.data.balance;
      } else if (response.data?.credit_amount !== undefined) {
        balance = response.data.credit_amount;
      } else {
        console.error(`[GetBalance] Unknown response format:`, response.data);
        return null; // Return null instead of 0 to indicate failure
      }

      const numericBalance =
        typeof balance === "number" ? balance : parseFloat(balance);

      if (isNaN(numericBalance)) {
        console.error(`[GetBalance] NaN balance: ${balance}`);
        return null;
      }

      console.log(
        `[GetBalance] Success: balance=${numericBalance} for ${memberAccount}`,
      );
      return numericBalance;
    } catch (error) {
      console.error(`[GetBalance] Error for ${memberAccount}:`, error.message);

      if (error.response) {
        console.error(`[GetBalance] Response data:`, error.response.data);
      }

      // FIXED: Return null instead of 0 to distinguish error from actual zero balance
      return null;
    }
  }

  // FIXED: getBalanceByMember with null handling
  static async getBalanceByMember(memberAccount) {
    try {
      const mapping = await ProviderLaunchMap.findOne({
        memberAccount: String(memberAccount),
      }).sort({ launchedAt: -1 });

      if (!mapping) {
        console.log(`[BalanceByMember] No mapping for ${memberAccount}`);
        return null;
      }

      const balance = await this.getBalanceFromWebsite(
        mapping.callbackUrl,
        memberAccount,
      );

      // FIXED: Return 0 only if balance is actually 0, not if error
      if (balance === null) {
        return null;
      }

      return balance;
    } catch (error) {
      console.error("[BalanceByMember] Error:", error.message);
      return null;
    }
  }
}

module.exports = CallbackForwardService;
