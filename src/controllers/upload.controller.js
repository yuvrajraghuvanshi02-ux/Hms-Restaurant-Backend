const streamifier = require("streamifier");
const { cloudinary } = require("../config/cloudinary");
const { logError } = require("../utils/logError");

const uploadImageToCloudinary = async (req, res) => {
  try {
    const cfg = cloudinary.config() || {};
    if (!cfg.cloud_name || cfg.cloud_name === "disabled") {
      return res.status(500).json({
        message:
          "Cloudinary is not configured. Please set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET and restart the backend.",
      });
    }

    if (!req.file) {
      return res.status(400).json({ message: "Image file is required." });
    }

    const folder = String(req.body?.folder || req.query?.folder || "restaurant-saas").trim();

    const uploadResult = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          folder,
          resource_type: "image",
          overwrite: false,
        },
        (error, result) => {
          if (error) return reject(error);
          resolve(result);
        }
      );

      streamifier.createReadStream(req.file.buffer).pipe(stream);
    });

    return res.status(200).json({
      message: "Image uploaded.",
      data: {
        url: uploadResult.secure_url,
        public_id: uploadResult.public_id,
        bytes: uploadResult.bytes,
        format: uploadResult.format,
        width: uploadResult.width,
        height: uploadResult.height,
      },
    });
  } catch (error) {
    logError("POST /api/uploads/image", error);
    return res.status(500).json({ message: "Failed to upload image." });
  }
};

module.exports = { uploadImageToCloudinary };

