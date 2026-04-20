const cloudinary = require("cloudinary").v2;

const required = ["CLOUDINARY_CLOUD_NAME", "CLOUDINARY_API_KEY", "CLOUDINARY_API_SECRET"];

const cleanEnv = (value) => {
  if (!value) return "";
  const trimmed = String(value).trim();
  return trimmed.replace(/^['"]/, "").replace(/['"]$/, "").trim();
};

const env = {
  CLOUDINARY_CLOUD_NAME: cleanEnv(process.env.CLOUDINARY_CLOUD_NAME),
  CLOUDINARY_API_KEY: cleanEnv(process.env.CLOUDINARY_API_KEY),
  CLOUDINARY_API_SECRET: cleanEnv(process.env.CLOUDINARY_API_SECRET),
};

const missing = required.filter((k) => !env[k]);
if (missing.length > 0) {
  // Avoid printing secrets; just fail fast with names.
  console.warn(`[WARN] Missing Cloudinary env vars: ${missing.join(", ")}`);
}

cloudinary.config({
  cloud_name: env.CLOUDINARY_CLOUD_NAME,
  api_key: env.CLOUDINARY_API_KEY,
  api_secret: env.CLOUDINARY_API_SECRET,
});

module.exports = { cloudinary };

