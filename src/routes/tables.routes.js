const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { attachTenantDb } = require("../middleware/tenant");
const { requireTenantAdmin } = require("../middleware/requireTenantAdmin");
const {
  createTable,
  listTables,
  listTablesWithStatus,
  getTable,
  updateTable,
  deleteTable,
} = require("../controllers/tables.controller");

const router = express.Router();

router.use(requireAuth, attachTenantDb, requireTenantAdmin);

router.post("/", createTable);
router.get("/with-status", listTablesWithStatus);
router.get("/", listTables);
router.get("/:id", getTable);
router.put("/:id", updateTable);
router.delete("/:id", deleteTable);

module.exports = router;

