const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { attachTenantDb } = require("../middleware/tenant");
const { requireTenantAdmin } = require("../middleware/requireTenantAdmin");
const { checkPermission } = require("../middleware/permissions");
const {
  createOrder,
  updateOrder,
  updateOrderGuest,
  cancelOrder,
  voidOrderItem,
  replaceOrderItem,
  correctOrder,
  listOrders,
  listSelectableOrders,
  listLiveOrders,
  getOrder,
  getActiveOrderByTable,
  updateOrderStatus,
} = require("../controllers/orders.controller");

const router = express.Router();

router.use(requireAuth, attachTenantDb, requireTenantAdmin);

router.post("/", checkPermission("orders", "add"), createOrder);
router.get("/", checkPermission("orders", "view"), listOrders);
router.get("/selectable", checkPermission("orders", "view"), listSelectableOrders);
router.get("/live", checkPermission("live_orders", "view"), listLiveOrders);
router.get("/by-table/:table_id", checkPermission("orders", "view"), getActiveOrderByTable);
router.get("/:id", checkPermission("orders", "view"), getOrder);
router.put("/:id", checkPermission("orders", "edit"), updateOrder);
router.patch("/:id/guest", checkPermission("orders", "edit"), updateOrderGuest);
router.put("/:id/correct", checkPermission("orders", "edit"), correctOrder);
router.post("/:id/cancel", checkPermission("orders", "edit"), cancelOrder);
router.post("/:id/void-item", checkPermission("orders", "edit"), voidOrderItem);
router.post("/:id/replace-item", checkPermission("orders", "edit"), replaceOrderItem);
router.put("/:id/status", checkPermission("orders", "edit"), updateOrderStatus);

module.exports = router;

