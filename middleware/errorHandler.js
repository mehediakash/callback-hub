// callback-hub/middleware/errorHandler.js
module.exports = (err, req, res, next) => {
  console.error("Error:", err.stack);

  if (err instanceof mongoose.Error.ValidationError) {
    return res.status(400).json({ error: err.message });
  }

  if (err instanceof mongoose.Error.CastError) {
    return res.status(400).json({ error: "Invalid ID format" });
  }

  res.status(500).json({ error: "Internal server error" });
};
