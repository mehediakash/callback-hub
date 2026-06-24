// callback-hub/app.js
require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const callbackRoutes = require("./routes/callbackRoutes");
const errorHandler = require("./middleware/errorHandler");

const app = express();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: Date.now() });
});

// Routes
app.use("/", callbackRoutes);

// Error handler
app.use(errorHandler);

// Connect to MongoDB
mongoose
  .connect(process.env.MONGODB_URI, {
    // Defaults preserve the MongoDB driver's normal maximum unless configured.
    maxPoolSize: Number(process.env.MONGO_MAX_POOL_SIZE || 100),
    minPoolSize: Number(process.env.MONGO_MIN_POOL_SIZE || 0),
    maxIdleTimeMS: Number(process.env.MONGO_MAX_IDLE_TIME_MS || 60000),
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000,
  })
  .then(() => console.log("MongoDB connected"))
  .catch((err) => console.error("MongoDB connection error:", err));

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Callback Hub running on port ${PORT}`);
});

module.exports = app;
