// callback-hub/services/CallbackForwardService.js
const axios = require("./httpClient");
const ProviderLaunchMap = require("../models/ProviderLaunchMap");

const DEBUG = process.env.DEBUG_CALLBACKS === "true";
const debugLog = (...args) => {
  if (DEBUG) console.log(...args);
};

class CallbackForwardService {
  static async forwardToWebsite(
    callbackUrl,
    callbackData,
    website,
    providerSessionId,
    userId,
  ) {
    const startTime = Date.now();
    const secret = process.env.INTERNAL_SECRET;

    debugLog(`[ForwardService] Forwarding to ${website}: ${callbackUrl}`);

    if (!callbackUrl || callbackUrl === "undefined") {
      console.error(`[ForwardService] Invalid callback URL for ${website}`);
      return {
        success: false,
        error: "Invalid callback URL",
        response: null,
      };
    }

    try {
      let forwardedData = callbackData;
      if (
        !callbackData.providerSessionId ||
        !callbackData.provider_session_id
      ) {
        forwardedData = {
          ...callbackData,
          providerSessionId:
            callbackData.providerSessionId || providerSessionId,
          provider_session_id:
            callbackData.provider_session_id || providerSessionId,
        };
      }

      const response = await axios.post(callbackUrl, forwardedData, {
        timeout: 5000,
        headers: {
          "Content-Type": "application/json",
          "X-Callback-Secret": secret,
          "X-Original-Website": website,
          "X-Provider-Session-Id": providerSessionId || "",
          "X-User-Id": userId || "",
          "X-Request-Timestamp": Date.now().toString(),
        },
      });

      const duration = Date.now() - startTime;

      debugLog(`[ForwardService] Response received in ${duration}ms:`, {
        status: response.status,
        credit_amount: response.data?.credit_amount,
        hasTimestamp: !!response.data?.timestamp,
      });

      // Validate response
      const creditAmount = response.data?.credit_amount;

      if (creditAmount === undefined || creditAmount === null) {
        console.error(
          `[ForwardService] Missing credit_amount in response:`,
          response.data,
        );
        return {
          success: false,
          error: "Missing credit_amount in response",
          response: null,
        };
      }

      const numericCreditAmount =
        typeof creditAmount === "number"
          ? creditAmount
          : parseFloat(creditAmount);

      if (isNaN(numericCreditAmount)) {
        console.error(
          `[ForwardService] Invalid credit_amount: ${creditAmount}`,
        );
        return {
          success: false,
          error: "Invalid credit_amount type",
          response: null,
        };
      }

      return {
        success: true,
        response: {
          credit_amount: numericCreditAmount,
          timestamp: response.data?.timestamp || Date.now(),
        },
        duration,
      };
    } catch (error) {
      const duration = Date.now() - startTime;

      if (error.code === "ECONNABORTED" || error.code === "ETIMEDOUT") {
        console.error(`[ForwardService] Timeout after ${duration}ms`);
        return {
          success: false,
          error: `Timeout after ${duration}ms`,
          response: null,
          timeout: true,
        };
      }

      if (error.response) {
        console.error(
          `[ForwardService] HTTP ${error.response.status}:`,
          error.response.data,
        );
        return {
          success: false,
          error: `HTTP ${error.response.status}`,
          response: null,
        };
      }

      console.error(`[ForwardService] Network error:`, error.message);
      return {
        success: false,
        error: error.message,
        response: null,
      };
    }
  }

  static async getBalanceFromWebsite(
    callbackUrl,
    memberAccount,
    userId = null,
  ) {
    try {
      const secret = process.env.INTERNAL_SECRET;
      const baseUrl = callbackUrl.replace("/internal/provider-callback", "");

      debugLog(
        `[GetBalance] Requesting from ${baseUrl}/internal/balance for ${memberAccount}`,
      );

      const response = await axios.get(`${baseUrl}/internal/balance`, {
        params: {
          memberAccount: String(memberAccount),
          ...(userId ? { userId: String(userId) } : {}),
        },
        timeout: 3000,
        headers: {
          "X-Callback-Secret": secret,
        },
      });

      let balance = null;

      if (response.data?.balance !== undefined) {
        balance = response.data.balance;
      } else if (response.data?.credit_amount !== undefined) {
        balance = response.data.credit_amount;
      } else {
        console.error(`[GetBalance] Unknown response format:`, response.data);
        return null;
      }

      const numericBalance =
        typeof balance === "number" ? balance : parseFloat(balance);

      if (isNaN(numericBalance)) {
        console.error(`[GetBalance] NaN balance: ${balance}`);
        return null;
      }

      debugLog(
        `[GetBalance] Success: balance=${numericBalance} for ${memberAccount}`,
      );
      return numericBalance;
    } catch (error) {
      console.error(`[GetBalance] Error for ${memberAccount}:`, error.message);

      if (error.response) {
        console.error(`[GetBalance] Response data:`, error.response.data);
      }

      return null;
    }
  }

  static async getBalanceByMember(
    memberAccount,
    website = null,
    userId = null,
  ) {
    try {
      const query = userId
        ? { userId: String(userId) }
        : { memberAccount: String(memberAccount) };

      if (website) {
        query.website = String(website);
      }

      const mappings = await ProviderLaunchMap.find(query)
        .select("website callbackUrl memberAccount userId launchedAt")
        .sort({ launchedAt: -1 })
        .limit(20)
        .lean();
      const websites = new Set(mappings.map((mapping) => mapping.website));

      if (!website && websites.size > 1) {
        console.error(
          `[BalanceByMember] Ambiguous balance lookup across websites for ${userId || memberAccount}`,
        );
        return null;
      }

      const mapping = mappings[0];

      if (!mapping) {
        debugLog(`[BalanceByMember] No mapping for ${memberAccount}`);
        return null;
      }

      const balance = await this.getBalanceFromWebsite(
        mapping.callbackUrl,
        mapping.memberAccount,
        mapping.userId,
      );
      return balance;
    } catch (error) {
      console.error("[BalanceByMember] Error:", error.message);
      return null;
    }
  }
}

module.exports = CallbackForwardService;
