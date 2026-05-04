const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { attachTenantDb } = require("../middleware/tenant");
const { requireTenantAdmin } = require("../middleware/requireTenantAdmin");
const { checkPermission, checkAnyPermission } = require("../middleware/permissions");

const {
  upsertRecipe,
  listRecipes,
  getRecipeByVariant,
  deleteRecipeByVariant,
} = require("../controllers/recipes.controller");

const router = express.Router();

router.use(requireAuth, attachTenantDb, requireTenantAdmin);

router.post("/", checkPermission("settings", "add"), upsertRecipe);
router.get("/", checkAnyPermission(["settings", "orders"], "view"), listRecipes);
router.get("/:variantId", checkAnyPermission(["settings", "orders"], "view"), getRecipeByVariant);
router.delete("/:variantId", checkPermission("settings", "delete"), deleteRecipeByVariant);

module.exports = router;

