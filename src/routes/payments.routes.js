const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { attachTenantDb } = require("../middleware/tenant");
const { requireTenantAdmin } = require("../middleware/requireTenantAdmin");
const { createPayment, getPaymentByOrder } = require("../controllers/payments.controller");

const router = express.Router();

router.use(requireAuth, attachTenantDb, requireTenantAdmin);

router.post("/", createPayment);
router.get("/:order_id", getPaymentByOrder);

module.exports = router;

