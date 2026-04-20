const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { attachTenantDb } = require("../middleware/tenant");
const { requireTenantAdmin } = require("../middleware/requireTenantAdmin");
const {
  createRawMaterialCategory,
  listRawMaterialCategories,
  updateRawMaterialCategory,
  deleteRawMaterialCategory,
} = require("../controllers/rawMaterialCategories.controller");

const router = express.Router();

router.use(requireAuth, attachTenantDb, requireTenantAdmin);

router.post("/raw-material-categories", createRawMaterialCategory);
router.get("/raw-material-categories", listRawMaterialCategories);
router.put("/raw-material-categories/:id", updateRawMaterialCategory);
router.delete("/raw-material-categories/:id", deleteRawMaterialCategory);

module.exports = router;

