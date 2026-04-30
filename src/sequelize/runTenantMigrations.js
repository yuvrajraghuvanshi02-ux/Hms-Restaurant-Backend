const path = require("path");
const { Umzug, SequelizeStorage } = require("umzug");
const { Sequelize } = require("sequelize");
const { getTenantSequelize } = require("../orm/tenant");

const runTenantMigrations = async (dbConfig) => {
  const tenant = getTenantSequelize(dbConfig);

  const umzug = new Umzug({
    migrations: {
      glob: path.join(__dirname, "migrations", "*-tenant-*.js"),
      resolve: ({ name, path: migrationPath, context }) => {
        // Support sequelize-cli style migrations:
        // module.exports = { up(queryInterface, Sequelize), down(queryInterface, Sequelize) }
        // while running through Umzug v3+ context API
        const migration = require(migrationPath);
        return {
          name,
          up: async () => migration.up(context, Sequelize),
          down: async () => migration.down(context, Sequelize),
        };
      },
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
