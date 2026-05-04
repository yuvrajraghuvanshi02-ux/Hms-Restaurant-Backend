const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { attachTenantDb } = require("../middleware/tenant");
const { requireTenantAdmin } = require("../middleware/requireTenantAdmin");
const { checkPermission } = require("../middleware/permissions");
const {
  createSupplier,
  listSuppliers,
  getSupplier,
  updateSupplier,
  deleteSupplier,
} = require("../controllers/suppliers.controller");

const router = express.Router();

router.use(requireAuth, attachTenantDb, requireTenantAdmin);

router.post("/", checkPermission("purchases", "add"), createSupplier);
router.get("/", checkPermission("purchases", "view"), listSuppliers);
router.get("/:id", checkPermission("purchases", "view"), getSupplier);
router.put("/:id", checkPermission("purchases", "edit"), updateSupplier);
router.delete("/:id", checkPermission("purchases", "delete"), deleteSupplier);

module.exports = router;
