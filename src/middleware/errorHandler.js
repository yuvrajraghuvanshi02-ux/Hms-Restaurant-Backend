const errorHandler = (err, req, res, next) => {
  console.error(`[ERROR] Unhandled error on ${req.method} ${req.originalUrl}`);
  console.error(err?.stack || err);

  if (err?.name === "MulterError" && err?.code === "LIMIT_FILE_SIZE") {
    return res.status(400).json({ message: "File must be less than or equal to 2MB." });
  }

  if (err?.message?.includes("Only PNG, JPG, JPEG, and WEBP files are allowed.")) {
    return res.status(400).json({ message: err.message });
  }

  return res.status(500).json({ message: "Internal server error." });
};

module.exports = errorHandler;
