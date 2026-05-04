const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { attachTenantDb } = require("../middleware/tenant");
const { requireTenantAdmin } = require("../middleware/requireTenantAdmin");
const { login } = require("../controllers/auth.controller");
const {
  createStaff,
  listStaff,
  listActiveStaff,
  getMyPermissions,
  getStaffPermissions,
  updateStaffPermissions,
  updateStaffStatus,
} = require("../controllers/staff.controller");

const router = express.Router();

router.post("/login", (req, res) => {
  req.body = { ...(req.body || {}), role: "staff" };
  return login(req, res);
});

router.use(requireAuth, attachTenantDb, requireTenantAdmin);

router.post("/", createStaff);
router.get("/", listStaff);
router.get("/active", listActiveStaff);
router.get("/permissions", getMyPermissions);
router.get("/:id/permissions", getStaffPermissions);
router.put("/:id/permissions", updateStaffPermissions);
router.patch("/:id/status", updateStaffStatus);

module.exports = router;
