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
  .connect(process.env.MONGODB_URI)
  .then(() => console.log("MongoDB connected"))
  .catch((err) => console.error("MongoDB connection error:", err));

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Callback Hub running on port ${PORT}`);
});

module.exports = app;
