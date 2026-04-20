const multer = require("multer");

const MAX_SIZE_BYTES = 2 * 1024 * 1024; // 2MB

const storage = multer.memoryStorage();

const fileFilter = (req, file, cb) => {
  const allowed = ["image/png", "image/jpeg", "image/jpg", "image/webp"];
  if (!allowed.includes(file.mimetype)) {
    return cb(new Error("Only PNG, JPG, JPEG, and WEBP files are allowed."));
  }
  cb(null, true);
};

const uploadImage = multer({
  storage,
  limits: { fileSize: MAX_SIZE_BYTES },
  fileFilter,
}).single("image");

module.exports = { uploadImage };

