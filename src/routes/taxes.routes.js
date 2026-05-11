const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { attachTenantDb } = require("../middleware/tenant");
const { requireTenantAdmin } = require("../middleware/requireTenantAdmin");
const { checkPermission, checkAnyPermission } = require("../middleware/permissions");
const { createTax, listTaxes, updateTax, deleteTax } = require("../controllers/taxes.controller");

const router = express.Router();

router.use(requireAuth, attachTenantDb, requireTenantAdmin);

router.post("/", checkPermission("gst", "add"), createTax);
router.get("/", checkAnyPermission(["gst", "orders"], "view"), listTaxes);
router.put("/:id", checkPermission("gst", "edit"), updateTax);
router.delete("/:id", checkPermission("gst", "delete"), deleteTax);

module.exports = router;

