const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { attachTenantDb } = require("../middleware/tenant");
const { requireTenantAdmin } = require("../middleware/requireTenantAdmin");
const { listKitchenOrders } = require("../controllers/kitchen.controller");

const router = express.Router();

router.use(requireAuth, attachTenantDb, requireTenantAdmin);
router.get("/orders", listKitchenOrders);

module.exports = router;

