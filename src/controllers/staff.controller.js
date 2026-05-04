const { randomUUID } = require("crypto");
const bcrypt = require("bcrypt");
const { PERMISSION_MODULES } = require("../constants/permissionModules");
const { logError } = require("../utils/logError");

const normalizeEmail = (value) => String(value || "").trim().toLowerCase();

const toPermissionsMap = (rows = []) => {
  const modules = {};
  for (const m of PERMISSION_MODULES) {
    modules[m] = { view: false, add: false, edit: false, delete: false };
  }
  for (const row of rows) {
    const key = String(row.module_name || "").trim();
    if (!key) continue;
    modules[key] = {
      view: Boolean(row.can_view),
      add: Boolean(row.can_add),
      edit: Boolean(row.can_edit),
      delete: Boolean(row.can_delete),
    };
  }
  return modules;
};

const ensureAdmin = (req, res) => {
  if (String(req.user?.role || "").toLowerCase() !== "admin") {
    res.status(403).json({ message: "Only admin can manage staff." });
    return false;
  }
  return true;
};

const ensureTenantUser = (req, res) => {
  const role = String(req.user?.role || "").toLowerCase();
  if (role !== "admin" && role !== "staff") {
    res.status(403).json({ message: "Forbidden." });
    return false;
  }
  return true;
};

const createStaff = async (req, res) => {
  if (!ensureAdmin(req, res)) return;

  const { name, email, phone, password, is_active } = req.body || {};
  const staffName = String(name || "").trim();
  const staffEmail = normalizeEmail(email);
  const staffPhone = String(phone || "").trim();
  const rawPassword = String(password || "");
  if (!staffName) return res.status(400).json({ message: "name is required." });
  if (!staffEmail) return res.status(400).json({ message: "email is required." });
  if (!rawPassword || rawPassword.length < 6) {
    return res.status(400).json({ message: "password must be at least 6 characters." });
  }

  try {
    const exists = await req.tenantDB.query(
      "SELECT id FROM staff_users WHERE LOWER(email) = LOWER($1) LIMIT 1",
      [staffEmail]
    );
    if (exists.rowCount > 0) {
      return res.status(409).json({ message: "Staff email already exists." });
    }

    const staffId = randomUUID();
    const hash = await bcrypt.hash(rawPassword, 10);
    const active = is_active === undefined ? true : Boolean(is_active);

    await req.tenantDB.query("BEGIN");
    await req.tenantDB.query(
      `
      INSERT INTO staff_users (id, restaurant_id, name, email, phone, password_hash, is_active, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
      `,
      [staffId, req.user.restaurant_id, staffName, staffEmail, staffPhone || null, hash, active]
    );

    for (const moduleName of PERMISSION_MODULES) {
      await req.tenantDB.query(
        `
        INSERT INTO permissions (
          id, staff_id, module_name, can_view, can_add, can_edit, can_delete, created_at, updated_at
        ) VALUES ($1, $2, $3, TRUE, TRUE, TRUE, TRUE, NOW(), NOW())
        `,
        [randomUUID(), staffId, moduleName]
      );
    }

    await req.tenantDB.query("COMMIT");
    return res.status(201).json({
      message: "Staff created successfully.",
      data: { id: staffId, name: staffName, email: staffEmail, phone: staffPhone || null, is_active: active },
    });
  } catch (error) {
    try {
      await req.tenantDB.query("ROLLBACK");
    } catch (_) {}
    logError("POST /api/staff", error);
    return res.status(500).json({ message: "Failed to create staff." });
  }
};

const listStaff = async (req, res) => {
  if (!ensureAdmin(req, res)) return;
  try {
    const q = await req.tenantDB.query(
      `
      SELECT id, name, email, phone, is_active, created_at
      FROM staff_users
      ORDER BY created_at DESC
      `
    );
    return res.status(200).json({ data: q.rows || [] });
  } catch (error) {
    logError("GET /api/staff", error);
    return res.status(500).json({ message: "Failed to fetch staff." });
  }
};

const listActiveStaff = async (req, res) => {
  if (!ensureTenantUser(req, res)) return;
  try {
    const q = await req.tenantDB.query(
      `
      SELECT id, name
      FROM staff_users
      WHERE is_active = TRUE
      ORDER BY name ASC
      `
    );
    return res.status(200).json({ data: q.rows || [] });
  } catch (error) {
    logError("GET /api/staff/active", error);
    return res.status(500).json({ message: "Failed to fetch active staff." });
  }
};

const getMyPermissions = async (req, res) => {
  const role = String(req.user?.role || "").toLowerCase();
  if (role === "admin") {
    const modules = {};
    for (const m of PERMISSION_MODULES) {
      modules[m] = { view: true, add: true, edit: true, delete: true };
    }
    return res.status(200).json({ modules });
  }
  if (role !== "staff") {
    return res.status(403).json({ message: "Forbidden." });
  }
  try {
    const q = await req.tenantDB.query(
      `
      SELECT module_name, can_view, can_add, can_edit, can_delete
      FROM permissions
      WHERE staff_id = $1
      `,
      [req.user.user_id]
    );
    return res.status(200).json({ modules: toPermissionsMap(q.rows || []) });
  } catch (error) {
    logError("GET /api/staff/permissions", error);
    return res.status(500).json({ message: "Failed to fetch permissions." });
  }
};

const getStaffPermissions = async (req, res) => {
  if (!ensureAdmin(req, res)) return;
  const { id } = req.params;
  try {
    const exists = await req.tenantDB.query("SELECT id FROM staff_users WHERE id = $1 LIMIT 1", [id]);
    if (exists.rowCount === 0) return res.status(404).json({ message: "Staff not found." });

    const q = await req.tenantDB.query(
      `
      SELECT module_name, can_view, can_add, can_edit, can_delete
      FROM permissions
      WHERE staff_id = $1
      `,
      [id]
    );
    return res.status(200).json({ modules: toPermissionsMap(q.rows || []) });
  } catch (error) {
    logError("GET /api/staff/:id/permissions", error);
    return res.status(500).json({ message: "Failed to fetch staff permissions." });
  }
};

const updateStaffPermissions = async (req, res) => {
  if (!ensureAdmin(req, res)) return;
  const { id } = req.params;
  const payload = req.body?.modules && typeof req.body.modules === "object" ? req.body.modules : null;
  if (!payload) return res.status(400).json({ message: "modules object is required." });

  try {
    const exists = await req.tenantDB.query("SELECT id FROM staff_users WHERE id = $1 LIMIT 1", [id]);
    if (exists.rowCount === 0) return res.status(404).json({ message: "Staff not found." });

    await req.tenantDB.query("BEGIN");
    for (const moduleName of PERMISSION_MODULES) {
      const mod = payload[moduleName] || {};
      await req.tenantDB.query(
        `
        INSERT INTO permissions (
          id, staff_id, module_name, can_view, can_add, can_edit, can_delete, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
        ON CONFLICT (staff_id, module_name)
        DO UPDATE SET
          can_view = EXCLUDED.can_view,
          can_add = EXCLUDED.can_add,
          can_edit = EXCLUDED.can_edit,
          can_delete = EXCLUDED.can_delete,
          updated_at = NOW()
        `,
        [
          randomUUID(),
          id,
          moduleName,
          Boolean(mod.view),
          Boolean(mod.add),
          Boolean(mod.edit),
          Boolean(mod.delete),
        ]
      );
    }
    await req.tenantDB.query("COMMIT");
    return res.status(200).json({ message: "Permissions updated successfully." });
  } catch (error) {
    try {
      await req.tenantDB.query("ROLLBACK");
    } catch (_) {}
    logError("PUT /api/staff/:id/permissions", error);
    return res.status(500).json({ message: "Failed to update permissions." });
  }
};

const updateStaffStatus = async (req, res) => {
  if (!ensureAdmin(req, res)) return;
  const { id } = req.params;
  const { is_active } = req.body || {};
  if (typeof is_active !== "boolean") {
    return res.status(400).json({ message: "is_active must be boolean." });
  }
  try {
    const out = await req.tenantDB.query(
      `
      UPDATE staff_users
      SET is_active = $1,
          updated_at = NOW()
      WHERE id = $2
      RETURNING id, name, email, phone, is_active
      `,
      [is_active, id]
    );
    if (out.rowCount === 0) return res.status(404).json({ message: "Staff not found." });
    return res.status(200).json({ message: "Staff status updated.", data: out.rows[0] });
  } catch (error) {
    logError("PATCH /api/staff/:id/status", error);
    return res.status(500).json({ message: "Failed to update staff status." });
  }
};

module.exports = {
  createStaff,
  listStaff,
  listActiveStaff,
  getMyPermissions,
  getStaffPermissions,
  updateStaffPermissions,
  updateStaffStatus,
};
