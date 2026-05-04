const express = require("express");
const {
  createRawMaterial,
  createUnit,
  deleteRawMaterial,
  deleteUnit,
  listRawMaterials,
  listUnits,
  updateRawMaterial,
  updateUnit,
} = require("../controllers/inventory.controller");
const { requireAuth } = require("../middleware/auth");
const { attachTenantDb } = require("../middleware/tenant");
const { requireTenantAdmin } = require("../middleware/requireTenantAdmin");
const { checkPermission } = require("../middleware/permissions");

const router = express.Router();

router.use(requireAuth, attachTenantDb, requireTenantAdmin);

router.post("/units", checkPermission("inventory", "add"), createUnit);
router.get("/units", checkPermission("inventory", "view"), listUnits);
router.put("/units/:id", checkPermission("inventory", "edit"), updateUnit);
router.delete("/units/:id", checkPermission("inventory", "delete"), deleteUnit);

router.post("/raw-materials", checkPermission("inventory", "add"), createRawMaterial);
router.get("/raw-materials", checkPermission("inventory", "view"), listRawMaterials);
router.put("/raw-materials/:id", checkPermission("inventory", "edit"), updateRawMaterial);
router.delete("/raw-materials/:id", checkPermission("inventory", "delete"), deleteRawMaterial);

module.exports = router;

