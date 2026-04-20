const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { attachTenantDb } = require("../middleware/tenant");
const { requireTenantAdmin } = require("../middleware/requireTenantAdmin");

const {
  upsertRecipe,
  listRecipes,
  getRecipeByVariant,
  deleteRecipeByVariant,
} = require("../controllers/recipes.controller");

const router = express.Router();

router.use(requireAuth, attachTenantDb, requireTenantAdmin);

router.post("/", upsertRecipe);
router.get("/", listRecipes);
router.get("/:variantId", getRecipeByVariant);
router.delete("/:variantId", deleteRecipeByVariant);

module.exports = router;

