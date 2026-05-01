const { Restaurant } = require("../orm/master");
const { getTenantPool } = require("../utils/tenantDbManager");

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const extractRestaurantId = (req) => {
  const q = String(req.query?.restaurant_id || "").trim();
  if (q) return q;
  const b = String(req.body?.restaurant_id || "").trim();
  if (b) return b;
  const p = String(req.params?.restaurant_id || "").trim();
  if (p) return p;
  return "";
};

const attachPublicTenantDb = async (req, res, next) => {
  try {
    const restaurantId = extractRestaurantId(req);
    if (!restaurantId) {
      return res.status(400).json({ message: "restaurant_id is required." });
    }
    if (!UUID_REGEX.test(restaurantId)) {
      return res.status(400).json({ message: "restaurant_id is invalid." });
    }

    const restaurant = await Restaurant.findByPk(restaurantId);
    if (!restaurant || String(restaurant.status || "").toLowerCase() !== "active") {
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
    req.tenantDB = getTenantPool(dbConfig);
    return next();
  } catch (error) {
    return next(error);
  }
};

module.exports = {
  attachPublicTenantDb,
};
