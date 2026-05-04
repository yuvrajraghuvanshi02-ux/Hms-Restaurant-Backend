const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { attachTenantDb } = require("../middleware/tenant");
const { requireTenantAdmin } = require("../middleware/requireTenantAdmin");
const { checkPermission } = require("../middleware/permissions");
const { uploadImage } = require("../middleware/uploadImage");
const { uploadImageToCloudinary } = require("../controllers/upload.controller");

const router = express.Router();

router.use(requireAuth, attachTenantDb, requireTenantAdmin);

router.post("/image", checkPermission("settings", "add"), uploadImage, uploadImageToCloudinary);

module.exports = router;

