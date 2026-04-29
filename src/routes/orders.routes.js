const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { attachTenantDb } = require("../middleware/tenant");
const { requireTenantAdmin } = require("../middleware/requireTenantAdmin");
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

router.post("/", createOrder);
router.get("/", listOrders);
router.get("/selectable", listSelectableOrders);
router.get("/live", listLiveOrders);
router.get("/by-table/:table_id", getActiveOrderByTable);
router.get("/:id", getOrder);
router.put("/:id", updateOrder);
router.patch("/:id/guest", updateOrderGuest);
router.put("/:id/correct", correctOrder);
router.post("/:id/cancel", cancelOrder);
router.post("/:id/void-item", voidOrderItem);
router.post("/:id/replace-item", replaceOrderItem);
router.put("/:id/status", updateOrderStatus);

module.exports = router;

