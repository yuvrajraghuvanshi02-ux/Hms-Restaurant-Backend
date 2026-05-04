const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { attachTenantDb } = require("../middleware/tenant");
const { requireTenantAdmin } = require("../middleware/requireTenantAdmin");
const { checkPermission } = require("../middleware/permissions");
const {
  listTipsReport,
  listDiscountsReport,
  listStaffReport,
  listStaffOrdersReport,
  getGstSummaryReport,
} = require("../controllers/reports.controller");

const router = express.Router();

router.use(requireAuth, attachTenantDb, requireTenantAdmin);

router.get("/tips", checkPermission("audit", "view"), listTipsReport);
router.get("/discounts", checkPermission("audit", "view"), listDiscountsReport);
router.get("/staff", checkPermission("audit", "view"), listStaffReport);
router.get("/staff/:staff_id/orders", checkPermission("audit", "view"), listStaffOrdersReport);
router.get("/gst-summary", checkPermission("gst", "view"), getGstSummaryReport);

module.exports = router;

