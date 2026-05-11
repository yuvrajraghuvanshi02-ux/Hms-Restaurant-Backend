const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { attachTenantDb } = require("../middleware/tenant");
const { requireTenantAdmin } = require("../middleware/requireTenantAdmin");
const { checkPermission } = require("../middleware/permissions");
const {
  getSalesReport,
  getProfitLossReport,
  getPaymentsReport,
  getAllOrdersReport,
  getCancelledOrdersReport,
  getVoidItemsReport,
  getReplacementsReport,
  getComplimentaryItemsReport,
  listTipsReport,
  listDiscountsReport,
  listStaffReport,
  listStaffOrdersReport,
  getStaffPerformanceReport,
  getStaffTipsReport,
  getInventoryConsumptionReport,
  getInventoryPurchasesReport,
  getGstSummaryReport,
  getPeakHoursReport,
  getCustomerInsightsReport,
  getTimeEfficiencyReport,
  getItemProfitabilityReport,
  getStockWastageReport,
  getExecutiveMenuPerformanceReport,
  getExecutiveTableUsageReport,
} = require("../controllers/reports.controller");

const router = express.Router();

router.use(requireAuth, attachTenantDb, requireTenantAdmin);

router.get("/sales", checkPermission("audit", "view"), getSalesReport);
router.get("/profit-loss", checkPermission("audit", "view"), getProfitLossReport);
router.get("/payments", checkPermission("audit", "view"), getPaymentsReport);
router.get("/orders", checkPermission("audit", "view"), getAllOrdersReport);
router.get("/orders/cancelled", checkPermission("audit", "view"), getCancelledOrdersReport);
router.get("/orders/void-items", checkPermission("audit", "view"), getVoidItemsReport);
router.get("/orders/replacements", checkPermission("audit", "view"), getReplacementsReport);
router.get("/orders/complimentary", checkPermission("audit", "view"), getComplimentaryItemsReport);
router.get("/tips", checkPermission("audit", "view"), listTipsReport);
router.get("/discounts", checkPermission("audit", "view"), listDiscountsReport);
router.get("/staff", checkPermission("audit", "view"), listStaffReport);
router.get("/staff/performance", checkPermission("audit", "view"), getStaffPerformanceReport);
router.get("/staff/tips", checkPermission("audit", "view"), getStaffTipsReport);
router.get("/inventory/consumption", checkPermission("audit", "view"), getInventoryConsumptionReport);
router.get("/inventory/purchases", checkPermission("audit", "view"), getInventoryPurchasesReport);
router.get("/insights/peak-hours", checkPermission("audit", "view"), getPeakHoursReport);
router.get("/insights/customer-insights", checkPermission("audit", "view"), getCustomerInsightsReport);
router.get("/insights/time-efficiency", checkPermission("audit", "view"), getTimeEfficiencyReport);
router.get("/insights/item-profitability", checkPermission("audit", "view"), getItemProfitabilityReport);
router.get("/insights/stock-wastage", checkPermission("audit", "view"), getStockWastageReport);
router.get("/executive/menu-performance", checkPermission("audit", "view"), getExecutiveMenuPerformanceReport);
router.get("/executive/table-usage", checkPermission("audit", "view"), getExecutiveTableUsageReport);
router.get("/staff/:staff_id/orders", checkPermission("audit", "view"), listStaffOrdersReport);
router.get("/gst/summary", checkPermission("gst", "view"), getGstSummaryReport);
router.get("/gst-summary", checkPermission("gst", "view"), getGstSummaryReport);

module.exports = router;

