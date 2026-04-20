const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { attachTenantDb } = require("../middleware/tenant");
const { requireTenantAdmin } = require("../middleware/requireTenantAdmin");

const {
  createMenuCategory,
  listMenuCategories,
  updateMenuCategory,
  deleteMenuCategory,
  createMenuItem,
  listMenuItems,
  updateMenuItem,
  deleteMenuItem,
} = require("../controllers/menu.controller");

const router = express.Router();

router.use(requireAuth, attachTenantDb, requireTenantAdmin);

router.post("/categories", createMenuCategory);
router.get("/categories", listMenuCategories);
router.put("/categories/:id", updateMenuCategory);
router.delete("/categories/:id", deleteMenuCategory);

router.post("/items", createMenuItem);
router.get("/items", listMenuItems);
router.put("/items/:id", updateMenuItem);
router.delete("/items/:id", deleteMenuItem);

module.exports = router;

