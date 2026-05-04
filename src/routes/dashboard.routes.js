const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { attachTenantDb } = require("../middleware/tenant");
const { requireTenantAdmin } = require("../middleware/requireTenantAdmin");
const { checkAnyPermission } = require("../middleware/permissions");
const { getDashboard } = require("../controllers/dashboard.controller");

const router = express.Router();

router.use(requireAuth, attachTenantDb, requireTenantAdmin);
router.get("/", checkAnyPermission(["audit", "orders", "live_orders"], "view"), getDashboard);

module.exports = router;

