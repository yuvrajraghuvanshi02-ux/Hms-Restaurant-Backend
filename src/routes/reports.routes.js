const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { attachTenantDb } = require("../middleware/tenant");
const { requireTenantAdmin } = require("../middleware/requireTenantAdmin");
const {
  listTipsReport,
  listDiscountsReport,
  getGstSummaryReport,
} = require("../controllers/reports.controller");

const router = express.Router();

router.use(requireAuth, attachTenantDb, requireTenantAdmin);

router.get("/tips", listTipsReport);
router.get("/discounts", listDiscountsReport);
router.get("/gst-summary", getGstSummaryReport);

module.exports = router;

