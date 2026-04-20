const { Sequelize, DataTypes } = require("sequelize");

const tenantSequelizeCache = new Map();

const getTenantSequelize = (dbConfig) => {
  const key = `${dbConfig.host}:${dbConfig.port}:${dbConfig.database}:${dbConfig.user}`;
  if (tenantSequelizeCache.has(key)) return tenantSequelizeCache.get(key);

  const sequelize = new Sequelize(dbConfig.database, dbConfig.user, dbConfig.password, {
    host: dbConfig.host,
    port: Number(dbConfig.port),
    dialect: "postgres",
    logging: false,
  });

  const Unit = sequelize.define(
    "Unit",
    {
      id: { type: DataTypes.UUID, primaryKey: true },
      name: { type: DataTypes.STRING, allowNull: false },
      short_name: { type: DataTypes.STRING, allowNull: false },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    },
    { tableName: "units", timestamps: false }
  );

  const RawMaterial = sequelize.define(
    "RawMaterial",
    {
      id: { type: DataTypes.UUID, primaryKey: true },
      name: { type: DataTypes.STRING, allowNull: false },
      unit_id: { type: DataTypes.UUID, allowNull: false },
      current_stock: { type: DataTypes.DECIMAL, allowNull: false, defaultValue: 0 },
      min_stock: { type: DataTypes.DECIMAL, allowNull: true },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    },
    { tableName: "raw_materials", timestamps: false }
  );

  const TenantUser = sequelize.define(
    "TenantUser",
    {
      id: { type: DataTypes.UUID, primaryKey: true },
      first_name: { type: DataTypes.STRING, allowNull: false },
      last_name: { type: DataTypes.STRING, allowNull: false },
      email: { type: DataTypes.STRING, allowNull: false },
      password: { type: DataTypes.STRING, allowNull: false },
      role: { type: DataTypes.STRING, allowNull: false, defaultValue: "admin" },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    },
    { tableName: "users", timestamps: false }
  );

  Unit.hasMany(RawMaterial, { foreignKey: "unit_id", as: "rawMaterials" });
  RawMaterial.belongsTo(Unit, { foreignKey: "unit_id", as: "unit" });

  const bundle = { sequelize, models: { Unit, RawMaterial, TenantUser } };
  tenantSequelizeCache.set(key, bundle);
  return bundle;
};

module.exports = {
  getTenantSequelize,
};

