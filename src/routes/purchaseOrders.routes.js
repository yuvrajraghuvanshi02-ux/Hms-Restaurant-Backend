const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { attachTenantDb } = require("../middleware/tenant");
const { requireTenantAdmin } = require("../middleware/requireTenantAdmin");
const { checkPermission } = require("../middleware/permissions");
const {
  createPurchaseOrderFromPr,
  listPurchaseOrders,
  getPurchaseOrder,
  updatePurchaseOrderStatus,
} = require("../controllers/purchaseOrders.controller");

const router = express.Router();

router.use(requireAuth, attachTenantDb, requireTenantAdmin);

router.post("/from-pr/:prId", checkPermission("purchases", "add"), createPurchaseOrderFromPr);
router.get("/", checkPermission("purchases", "view"), listPurchaseOrders);
router.get("/:id", checkPermission("purchases", "view"), getPurchaseOrder);
router.put("/:id/status", checkPermission("purchases", "edit"), updatePurchaseOrderStatus);

module.exports = router;

