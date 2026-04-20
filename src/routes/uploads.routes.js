const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { attachTenantDb } = require("../middleware/tenant");
const { requireTenantAdmin } = require("../middleware/requireTenantAdmin");
const { uploadImage } = require("../middleware/uploadImage");
const { uploadImageToCloudinary } = require("../controllers/upload.controller");

const router = express.Router();

router.use(requireAuth, attachTenantDb, requireTenantAdmin);

router.post("/image", uploadImage, uploadImageToCloudinary);

module.exports = router;

