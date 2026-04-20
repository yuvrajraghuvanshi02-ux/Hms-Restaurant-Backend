const path = require("path");
const { Umzug, SequelizeStorage } = require("umzug");
const { getTenantSequelize } = require("../orm/tenant");

const runTenantMigrations = async (dbConfig) => {
  const tenant = getTenantSequelize(dbConfig);

  const umzug = new Umzug({
    migrations: {
      glob: path.join(__dirname, "migrations", "*-tenant-*.js"),
    },
    context: tenant.sequelize.getQueryInterface(),
    storage: new SequelizeStorage({
      sequelize: tenant.sequelize,
      tableName: "SequelizeMeta",
    }),
    logger: console,
  });

  await umzug.up();
};

module.exports = {
  runTenantMigrations,
};

