const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { attachTenantDb } = require("../middleware/tenant");
const { requireTenantAdmin } = require("../middleware/requireTenantAdmin");
const { checkPermission } = require("../middleware/permissions");
const { getDayEndAudit } = require("../controllers/audit.controller");

const router = express.Router();

router.use(requireAuth, attachTenantDb, requireTenantAdmin);

router.get("/day-end", checkPermission("audit", "view"), getDayEndAudit);

module.exports = router;
