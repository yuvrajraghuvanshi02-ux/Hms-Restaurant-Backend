const express = require("express");
const { attachPublicTenantDb } = require("../middleware/publicTenant");
const { getPublicMenu, createPublicOrder } = require("../controllers/public.controller");

const router = express.Router();

router.get("/menu", attachPublicTenantDb, getPublicMenu);
router.post("/order", attachPublicTenantDb, createPublicOrder);

module.exports = router;
