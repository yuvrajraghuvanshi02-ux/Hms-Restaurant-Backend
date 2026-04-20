const { Restaurant } = require("../orm/master");
const { getTenantSequelize } = require("../orm/tenant");
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

      const restaurant = await Restaurant.findByPk(restaurantId);
      if (!restaurant) {
        return res.status(404).json({ message: "Restaurant not found." });
      }

      const dbConfig = {
        host: restaurant.db_host,
        port: Number(restaurant.db_port),
        database: restaurant.db_name,
        user: restaurant.db_user,
        password: restaurant.db_password,
      };

      req.restaurant = restaurant.toJSON();
      const tenant = getTenantSequelize(dbConfig);
      req.tenant = tenant;
      // For modules that explicitly require pg-style querying:
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

