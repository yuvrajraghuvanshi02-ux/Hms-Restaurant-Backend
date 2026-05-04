const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { attachTenantDb } = require("../middleware/tenant");
const { requireTenantAdmin } = require("../middleware/requireTenantAdmin");
const { checkPermission } = require("../middleware/permissions");
const { listKitchenOrders } = require("../controllers/kitchen.controller");

const router = express.Router();

router.use(requireAuth, attachTenantDb, requireTenantAdmin);
router.get("/orders", checkPermission("kds", "view"), listKitchenOrders);

module.exports = router;

