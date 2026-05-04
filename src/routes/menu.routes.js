const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { attachTenantDb } = require("../middleware/tenant");
const { requireTenantAdmin } = require("../middleware/requireTenantAdmin");
const { checkPermission, checkAnyPermission } = require("../middleware/permissions");

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

router.post("/categories", checkPermission("settings", "add"), createMenuCategory);
router.get("/categories", checkAnyPermission(["settings", "orders"], "view"), listMenuCategories);
router.put("/categories/:id", checkPermission("settings", "edit"), updateMenuCategory);
router.delete("/categories/:id", checkPermission("settings", "delete"), deleteMenuCategory);

router.post("/items", checkPermission("settings", "add"), createMenuItem);
router.get("/items", checkAnyPermission(["settings", "orders"], "view"), listMenuItems);
router.put("/items/:id", checkPermission("settings", "edit"), updateMenuItem);
router.delete("/items/:id", checkPermission("settings", "delete"), deleteMenuItem);

module.exports = router;

