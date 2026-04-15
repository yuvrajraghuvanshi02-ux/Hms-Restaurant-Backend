const { pool } = require("../config/db");
const { getTenantPool } = require("../utils/tenantDbManager");

const attachTenantDb = async (req, res, next) => {
  try {
    const role = req.user?.role;

    if (role === "super_admin") {
      return next();
    }

    if (role === "admin") {
      const restaurantId = req.user?.restaurant_id;
      if (!restaurantId) {
        return res.status(400).json({ message: "restaurant_id missing in token." });
      }

      const restaurantResult = await pool.query(
        `
        SELECT id, name, db_name, db_user, db_password, db_host, db_port
        FROM restaurants
        WHERE id = $1
        LIMIT 1
        `,
        [restaurantId]
      );

      if (restaurantResult.rowCount === 0) {
        return res.status(404).json({ message: "Restaurant not found." });
      }

      const restaurant = restaurantResult.rows[0];
      const dbConfig = {
        host: restaurant.db_host,
        port: Number(restaurant.db_port),
        database: restaurant.db_name,
        user: restaurant.db_user,
        password: restaurant.db_password,
      };

      req.restaurant = restaurant;
      req.tenantDB = getTenantPool(dbConfig);
      return next();
    }

    return res.status(403).json({ message: "Unsupported role." });
  } catch (error) {
    return next(error);
  }
};

module.exports = {
  attachTenantDb,
};

