const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { attachTenantDb } = require("../middleware/tenant");
const { requireTenantAdmin } = require("../middleware/requireTenantAdmin");
const { checkPermission, checkAnyPermission } = require("../middleware/permissions");
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

router.post("/", checkPermission("settings", "add"), createTable);
router.get("/with-status", checkPermission("settings", "view"), listTablesWithStatus);
router.get("/", checkAnyPermission(["settings", "orders"], "view"), listTables);
router.get("/:id", checkPermission("settings", "view"), getTable);
router.put("/:id", checkPermission("settings", "edit"), updateTable);
router.delete("/:id", checkPermission("settings", "delete"), deleteTable);

module.exports = router;

