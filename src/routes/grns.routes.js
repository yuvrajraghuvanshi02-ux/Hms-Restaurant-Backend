const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { attachTenantDb } = require("../middleware/tenant");
const { requireTenantAdmin } = require("../middleware/requireTenantAdmin");
const { checkPermission } = require("../middleware/permissions");
const { createGrnFromPo, listGrns, getGrn } = require("../controllers/grns.controller");

const router = express.Router();

router.use(requireAuth, attachTenantDb, requireTenantAdmin);

router.post("/from-po/:poId", checkPermission("purchases", "add"), createGrnFromPo);
router.get("/", checkPermission("purchases", "view"), listGrns);
router.get("/:id", checkPermission("purchases", "view"), getGrn);

module.exports = router;

