const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { attachTenantDb } = require("../middleware/tenant");
const { requireTenantAdmin } = require("../middleware/requireTenantAdmin");
const {
  createTableType,
  listTableTypes,
  updateTableType,
  deleteTableType,
} = require("../controllers/tableTypes.controller");

const router = express.Router();

router.use(requireAuth, attachTenantDb, requireTenantAdmin);

router.post("/", createTableType);
router.get("/", listTableTypes);
router.put("/:id", updateTableType);
router.delete("/:id", deleteTableType);

module.exports = router;

