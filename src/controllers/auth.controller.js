const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { Op } = require("sequelize");
const { Restaurant, RestaurantAdmin, SuperAdminUser } = require("../orm/master");
const { getTenantPool } = require("../utils/tenantDbManager");
const { PERMISSION_MODULES } = require("../constants/permissionModules");
const { logError } = require("../utils/logError");

const normalizeEmail = (email) => String(email || "").trim().toLowerCase();
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

const login = async (req, res) => {
  const { email, password, role, restaurant_id } = req.body;

  if (!email || !password || !role) {
    return res
      .status(400)
      .json({ message: "Email, password, and role are required." });
  }

  try {
    const emailNormalized = normalizeEmail(email);

    if (role === "staff") {
      const requestedRestaurantId = String(restaurant_id || "").trim();
      const restaurants = await Restaurant.findAll({
        where: requestedRestaurantId ? { id: requestedRestaurantId, status: "active" } : { status: "active" },
        attributes: ["id", "db_name", "db_user", "db_password", "db_host", "db_port"],
      });

      for (const restaurant of restaurants || []) {
        const dbConfig = {
          host: restaurant.db_host,
          port: Number(restaurant.db_port),
          database: restaurant.db_name,
          user: restaurant.db_user,
          password: restaurant.db_password,
        };
        const pool = getTenantPool(dbConfig);
        try {
          const staffQ = await pool.query(
            `
            SELECT id, restaurant_id, name, email, phone, password_hash, is_active
            FROM staff_users
            WHERE LOWER(email) = LOWER($1)
            LIMIT 1
            `,
            [emailNormalized]
          );
          if (staffQ.rowCount === 0) continue;

          const staff = staffQ.rows[0];
          if (!Boolean(staff.is_active)) {
            return res.status(403).json({ message: "Staff account is deactivated." });
          }

          const isPasswordValid = await bcrypt.compare(password, staff.password_hash);
          if (!isPasswordValid) {
            return res.status(401).json({ message: "Invalid credentials." });
          }

          const permQ = await pool.query(
            `
            SELECT module_name, can_view, can_add, can_edit, can_delete
            FROM permissions
            WHERE staff_id = $1
            `,
            [staff.id]
          );

          const token = jwt.sign(
            {
              user_id: staff.id,
              restaurant_id: staff.restaurant_id || restaurant.id,
              role: "staff",
            },
            process.env.JWT_SECRET,
            { expiresIn: "12h" }
          );

          return res.status(200).json({
            message: "Login successful.",
            token,
            user: {
              id: staff.id,
              name: staff.name,
              email: staff.email,
              role: "staff",
              restaurant_id: staff.restaurant_id || restaurant.id,
            },
            permissions: toPermissionsMap(permQ.rows || []),
          });
        } catch (innerError) {
          // Skip tenants that are not yet migrated with staff tables.
          if (String(innerError?.code || "") === "42P01") continue;
          throw innerError;
        }
      }

      return res.status(401).json({ message: "Invalid credentials." });
    }

    if (role === "super_admin") {
      const user = await SuperAdminUser.findOne({
        where: { email: { [Op.iLike]: emailNormalized } },
      });

      if (!user) {
        return res.status(401).json({ message: "Invalid credentials." });
      }

      if (user.status !== "active") {
        return res.status(403).json({ message: "User is inactive." });
      }

      const isPasswordValid = await bcrypt.compare(password, user.password);
      if (!isPasswordValid) {
        return res.status(401).json({ message: "Invalid credentials." });
      }

      const token = jwt.sign(
        {
          user_id: user.id,
          role: "super_admin",
        },
        process.env.JWT_SECRET,
        { expiresIn: "12h" }
      );

      return res.status(200).json({
        message: "Login successful.",
        token,
        user: {
          id: user.id,
          email: user.email,
          role: "super_admin",
        },
      });
    }

    if (role === "admin") {
      const user = await RestaurantAdmin.findOne({
        where: { email: { [Op.iLike]: emailNormalized } },
      });

      if (!user) {
        return res.status(401).json({ message: "Invalid credentials." });
      }

      const isPasswordValid = await bcrypt.compare(password, user.password);
      if (!isPasswordValid) {
        return res.status(401).json({ message: "Invalid credentials." });
      }

      const token = jwt.sign(
        {
          user_id: user.id,
          restaurant_id: user.restaurant_id,
          role: "admin",
        },
        process.env.JWT_SECRET,
        { expiresIn: "12h" }
      );

      return res.status(200).json({
        message: "Login successful.",
        token,
        user: {
          id: user.id,
          email: user.email,
          role: "admin",
          restaurant_id: user.restaurant_id,
        },
        permissions: toPermissionsMap([]),
      });
    }

    return res.status(400).json({ message: "Invalid role." });
  } catch (error) {
    logError("POST /api/auth/login", error);
    return res.status(500).json({ message: "Internal server error." });
  }
};

module.exports = {
  login,
};
