const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { attachTenantDb } = require("../middleware/tenant");
const { requireTenantAdmin } = require("../middleware/requireTenantAdmin");
const {
  createPurchaseOrderFromPr,
  listPurchaseOrders,
  getPurchaseOrder,
  updatePurchaseOrderStatus,
} = require("../controllers/purchaseOrders.controller");

const router = express.Router();

router.use(requireAuth, attachTenantDb, requireTenantAdmin);

router.post("/from-pr/:prId", createPurchaseOrderFromPr);
router.get("/", listPurchaseOrders);
router.get("/:id", getPurchaseOrder);
router.put("/:id/status", updatePurchaseOrderStatus);

module.exports = router;

