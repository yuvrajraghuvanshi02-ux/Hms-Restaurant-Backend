const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { attachTenantDb } = require("../middleware/tenant");
const { requireTenantAdmin } = require("../middleware/requireTenantAdmin");
const { createTax, listTaxes, updateTax } = require("../controllers/taxes.controller");

const router = express.Router();

router.use(requireAuth, attachTenantDb, requireTenantAdmin);

router.post("/", createTax);
router.get("/", listTaxes);
router.put("/:id", updateTax);

module.exports = router;

