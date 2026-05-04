const toActionFromMethod = (method) => {
  const m = String(method || "").toUpperCase();
  if (m === "GET" || m === "HEAD" || m === "OPTIONS") return "view";
  if (m === "POST") return "add";
  if (m === "PUT" || m === "PATCH") return "edit";
  if (m === "DELETE") return "delete";
  return "view";
};

const checkPermission = (moduleName, action) => {
  return async (req, res, next) => {
    try {
      const role = String(req.user?.role || "").toLowerCase();
      if (role === "admin" || role === "super_admin") return next();
      if (role !== "staff") return res.status(403).json({ message: "Forbidden." });
      if (!req.tenantDB) return res.status(500).json({ message: "Tenant DB not available." });

      const staffId = String(req.user?.user_id || "").trim();
      if (!staffId) return res.status(401).json({ message: "Unauthorized." });

      const actionKey = String(action || toActionFromMethod(req.method)).toLowerCase();
      const actionColumn =
        actionKey === "add"
          ? "can_add"
          : actionKey === "edit"
            ? "can_edit"
            : actionKey === "delete"
              ? "can_delete"
              : "can_view";

      const q = await req.tenantDB.query(
        `
        SELECT ${actionColumn} AS allowed
        FROM permissions
        WHERE staff_id = $1
          AND module_name = $2
        LIMIT 1
        `,
        [staffId, String(moduleName || "").trim()]
      );

      const allowed = Boolean(q.rows[0]?.allowed);
      if (!allowed) return res.status(403).json({ message: "Permission denied." });
      return next();
    } catch (error) {
      return next(error);
    }
  };
};

const checkAnyPermission = (moduleNames = [], action) => {
  return async (req, res, next) => {
    try {
      const role = String(req.user?.role || "").toLowerCase();
      if (role === "admin" || role === "super_admin") return next();
      if (role !== "staff") return res.status(403).json({ message: "Forbidden." });
      if (!req.tenantDB) return res.status(500).json({ message: "Tenant DB not available." });

      const staffId = String(req.user?.user_id || "").trim();
      if (!staffId) return res.status(401).json({ message: "Unauthorized." });

      const modules = Array.isArray(moduleNames)
        ? moduleNames.map((m) => String(m || "").trim()).filter(Boolean)
        : [String(moduleNames || "").trim()].filter(Boolean);
      if (modules.length === 0) return res.status(403).json({ message: "Permission denied." });

      const actionKey = String(action || toActionFromMethod(req.method)).toLowerCase();
      const actionColumn =
        actionKey === "add"
          ? "can_add"
          : actionKey === "edit"
            ? "can_edit"
            : actionKey === "delete"
              ? "can_delete"
              : "can_view";

      const q = await req.tenantDB.query(
        `
        SELECT ${actionColumn} AS allowed
        FROM permissions
        WHERE staff_id = $1
          AND module_name = ANY($2::text[])
        `,
        [staffId, modules]
      );

      const allowed = (q.rows || []).some((r) => Boolean(r.allowed));
      if (!allowed) return res.status(403).json({ message: "Permission denied." });
      return next();
    } catch (error) {
      return next(error);
    }
  };
};

module.exports = {
  checkPermission,
  checkAnyPermission,
};
