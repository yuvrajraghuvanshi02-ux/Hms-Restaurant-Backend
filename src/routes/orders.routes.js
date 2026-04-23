const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { attachTenantDb } = require("../middleware/tenant");
const { requireTenantAdmin } = require("../middleware/requireTenantAdmin");
const {
  createOrder,
  updateOrder,
  listOrders,
  getOrder,
  getActiveOrderByTable,
  updateOrderStatus,
} = require("../controllers/orders.controller");

const router = express.Router();

router.use(requireAuth, attachTenantDb, requireTenantAdmin);

router.post("/", createOrder);
router.get("/", listOrders);
router.get("/by-table/:table_id", getActiveOrderByTable);
router.get("/:id", getOrder);
router.put("/:id", updateOrder);
router.put("/:id/status", updateOrderStatus);

module.exports = router;

