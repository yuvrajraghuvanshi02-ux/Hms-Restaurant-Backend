const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { attachTenantDb } = require("../middleware/tenant");
const { requireTenantAdmin } = require("../middleware/requireTenantAdmin");
const { checkPermission } = require("../middleware/permissions");
const {
  createTableType,
  listTableTypes,
  updateTableType,
  deleteTableType,
} = require("../controllers/tableTypes.controller");

const router = express.Router();

router.use(requireAuth, attachTenantDb, requireTenantAdmin);

router.post("/", checkPermission("settings", "add"), createTableType);
router.get("/", checkPermission("settings", "view"), listTableTypes);
router.put("/:id", checkPermission("settings", "edit"), updateTableType);
router.delete("/:id", checkPermission("settings", "delete"), deleteTableType);

module.exports = router;

