// callback-hub/routes/callbackRoutes.js
const express = require("express");
const router = express.Router();
const CallbackController = require("../controllers/CallbackController");

// Provider callback endpoint (main entry point)
router.post("/provider/callback", CallbackController.handleProviderCallback);

// Website registration endpoints
router.post("/internal/register", CallbackController.registerLaunch);
router.post("/internal/close-session", CallbackController.closeSession);

// Health and debugging endpoints
router.get("/health", CallbackController.healthCheck);
// router.get("/debug/session", CallbackController.getSession);
// router.get("/debug/rounds", CallbackController.getProcessedRounds);

module.exports = router;
