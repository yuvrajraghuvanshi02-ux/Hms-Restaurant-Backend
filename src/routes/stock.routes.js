const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { attachTenantDb } = require("../middleware/tenant");
const { requireTenantAdmin } = require("../middleware/requireTenantAdmin");
const { checkPermission } = require("../middleware/permissions");
const { addStockHandler, testDeductHandler } = require("../controllers/stock.controller");

const router = express.Router();

router.use(requireAuth, attachTenantDb, requireTenantAdmin);

router.post("/add", checkPermission("inventory", "add"), addStockHandler);
router.post("/test-deduct", checkPermission("inventory", "edit"), testDeductHandler);

module.exports = router;

