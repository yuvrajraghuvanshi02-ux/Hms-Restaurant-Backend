const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { attachTenantDb } = require("../middleware/tenant");
const { requireTenantAdmin } = require("../middleware/requireTenantAdmin");
const { addStockHandler, testDeductHandler } = require("../controllers/stock.controller");

const router = express.Router();

router.use(requireAuth, attachTenantDb, requireTenantAdmin);

router.post("/add", addStockHandler);
router.post("/test-deduct", testDeductHandler);

module.exports = router;

