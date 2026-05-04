const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { attachTenantDb } = require("../middleware/tenant");
const { requireTenantAdmin } = require("../middleware/requireTenantAdmin");
const { checkPermission } = require("../middleware/permissions");
const {
  createRawMaterialCategory,
  listRawMaterialCategories,
  updateRawMaterialCategory,
  deleteRawMaterialCategory,
} = require("../controllers/rawMaterialCategories.controller");

const router = express.Router();

router.use(requireAuth, attachTenantDb, requireTenantAdmin);

router.post("/raw-material-categories", checkPermission("settings", "add"), createRawMaterialCategory);
router.get("/raw-material-categories", checkPermission("settings", "view"), listRawMaterialCategories);
router.put("/raw-material-categories/:id", checkPermission("settings", "edit"), updateRawMaterialCategory);
router.delete("/raw-material-categories/:id", checkPermission("settings", "delete"), deleteRawMaterialCategory);

module.exports = router;

