const requireTenantAdmin = (req, res, next) => {
  const role = String(req.user?.role || "").toLowerCase();
  if (role !== "admin" && role !== "staff") {
    return res.status(403).json({ message: "Forbidden." });
  }
  if (!req.tenantDB) {
    return res.status(500).json({ message: "Tenant DB not available." });
  }
  return next();
};

module.exports = {
  requireTenantAdmin,
};

