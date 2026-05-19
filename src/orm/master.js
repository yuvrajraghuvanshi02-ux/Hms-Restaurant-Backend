const { Sequelize, DataTypes } = require("sequelize");
require("dotenv").config();

const isProduction = process.env.NODE_ENV === "production";
const dbName = isProduction
  ? process.env.PG_DB || process.env.PGDATABASE || process.env.DB_NAME || "postgres"
  : process.env.DB_NAME;
const dbUser = isProduction ? process.env.PG_USER : process.env.DB_USER;
const dbPassword = isProduction ? process.env.PG_PASSWORD : process.env.DB_PASSWORD;
const dbHost = isProduction ? process.env.PG_HOST : process.env.DB_HOST;
const dbPort = isProduction ? process.env.PG_PORT : process.env.DB_PORT;
const sslEnabled = isProduction;

console.log("Resolved DB Config", {
  dbName,
  dbUser,
  dbHost,
  dbPort,
  nodeEnv: process.env.NODE_ENV,
});
console.log(`[MASTER DB] NODE_ENV=${process.env.NODE_ENV || "development"} host=${dbHost || "undefined"} ssl=${sslEnabled ? "enabled" : "disabled"}`);

const masterSequelize = new Sequelize(
  dbName,
  dbUser,
  dbPassword,
  {
    host: dbHost,
    port: Number(dbPort || 5432),
    dialect: "postgres",
    logging: false,
    ...(sslEnabled
      ? {
          dialectOptions: {
            ssl: {
              require: true,
              rejectUnauthorized: false,
            },
          },
        }
      : {}),
  }
);

const Restaurant = masterSequelize.define(
  "Restaurant",
  {
    id: { type: DataTypes.UUID, primaryKey: true },
    name: { type: DataTypes.STRING, allowNull: false },
    address: { type: DataTypes.TEXT, allowNull: true },
    logo_url: { type: DataTypes.TEXT, allowNull: true },
    status: { type: DataTypes.STRING, allowNull: false, defaultValue: "active" },
    db_name: { type: DataTypes.STRING, allowNull: false },
    db_user: { type: DataTypes.STRING, allowNull: false },
    db_password: { type: DataTypes.STRING, allowNull: false },
    db_host: { type: DataTypes.STRING, allowNull: false },
    db_port: { type: DataTypes.INTEGER, allowNull: false },
    created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  {
    tableName: "restaurants",
    timestamps: false,
  }
);

const RestaurantAdmin = masterSequelize.define(
  "RestaurantAdmin",
  {
    id: { type: DataTypes.UUID, primaryKey: true },
    restaurant_id: { type: DataTypes.UUID, allowNull: false },
    first_name: { type: DataTypes.STRING, allowNull: false },
    last_name: { type: DataTypes.STRING, allowNull: false },
    email: { type: DataTypes.STRING, allowNull: false },
    phone: { type: DataTypes.STRING, allowNull: false },
    password: { type: DataTypes.STRING, allowNull: false },
    role: { type: DataTypes.STRING, allowNull: false, defaultValue: "admin" },
    created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  {
    tableName: "restaurant_admins",
    timestamps: false,
  }
);

const SuperAdminUser = masterSequelize.define(
  "SuperAdminUser",
  {
    id: { type: DataTypes.UUID, primaryKey: true },
    email: { type: DataTypes.STRING, allowNull: false },
    password: { type: DataTypes.STRING, allowNull: false },
    role: { type: DataTypes.STRING, allowNull: true },
    status: { type: DataTypes.STRING, allowNull: false },
  },
  {
    tableName: "super_admin_users",
    timestamps: false,
  }
);

Restaurant.hasOne(RestaurantAdmin, { foreignKey: "restaurant_id", as: "admin" });
RestaurantAdmin.belongsTo(Restaurant, { foreignKey: "restaurant_id", as: "restaurant" });

module.exports = {
  masterSequelize,
  Restaurant,
  RestaurantAdmin,
  SuperAdminUser,
};

