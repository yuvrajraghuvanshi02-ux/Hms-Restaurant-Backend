const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { attachTenantDb } = require("../middleware/tenant");
const { requireTenantAdmin } = require("../middleware/requireTenantAdmin");
const { createGrnFromPo, listGrns, getGrn } = require("../controllers/grns.controller");

const router = express.Router();

router.use(requireAuth, attachTenantDb, requireTenantAdmin);

router.post("/from-po/:poId", createGrnFromPo);
router.get("/", listGrns);
router.get("/:id", getGrn);

module.exports = router;

