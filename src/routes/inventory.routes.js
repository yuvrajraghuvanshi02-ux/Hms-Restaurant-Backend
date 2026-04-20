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

const router = express.Router();

router.use(requireAuth, attachTenantDb, requireTenantAdmin);

router.post("/units", createUnit);
router.get("/units", listUnits);
router.put("/units/:id", updateUnit);
router.delete("/units/:id", deleteUnit);

router.post("/raw-materials", createRawMaterial);
router.get("/raw-materials", listRawMaterials);
router.put("/raw-materials/:id", updateRawMaterial);
router.delete("/raw-materials/:id", deleteRawMaterial);

module.exports = router;

