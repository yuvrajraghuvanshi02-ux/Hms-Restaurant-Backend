const fs = require("fs");
const path = require("path");
const isProduction = process.env.NODE_ENV === "production";
const resolvedHost = isProduction ? process.env.PG_HOST : process.env.DB_HOST;
const resolvedPort = isProduction ? process.env.PG_PORT : process.env.DB_PORT;
const resolvedUser = isProduction ? process.env.PG_USER : process.env.DB_USER;
const resolvedPassword = isProduction ? process.env.PG_PASSWORD : process.env.DB_PASSWORD;
const resolvedDatabase = isProduction
  ? process.env.PG_DB || process.env.PGDATABASE || process.env.DB_NAME || "postgres"
  : process.env.DB_NAME;

const baseConfigPath = path.join(__dirname, "config.json");
const raw = JSON.parse(fs.readFileSync(baseConfigPath, "utf8"));

const expandEnv = (value) => {
  if (typeof value !== "string") return value;
  return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_, key) => process.env[key] ?? "");
};

const resolveConfigBlock = (block) => {
  if (!block || typeof block !== "object") return null;
  const dialect = block.dialect || "postgres";
  const host = expandEnv(block.host) || resolvedHost;
  const port = Number(expandEnv(block.port) || resolvedPort || 5432);
  const username = expandEnv(block.username) || resolvedUser;
  const password = expandEnv(block.password) || resolvedPassword;
  const database = expandEnv(block.database) || resolvedDatabase;
  const dialectOptions = block.dialectOptions;

  return {
    dialect,
    host,
    port,
    username,
    password,
    database,
    dialectOptions,
    logging: false,
  };
};

const buildConfigForDatabase = (database, baseBlock) => {
  const resolvedBase = resolveConfigBlock(baseBlock) || resolveConfigBlock(raw.development) || {
    dialect: "postgres",
    host: resolvedHost,
    port: Number(resolvedPort || 5432),
    username: resolvedUser,
    password: resolvedPassword,
    database: resolvedDatabase,
    logging: false,
  };

  return {
    ...resolvedBase,
    database,
  };
};

// sequelize-cli picks config by --env <name>.
// If config.json has an explicit block for that env, we use it.
// Otherwise we treat env name as the tenant database name (DB-per-restaurant).
module.exports = new Proxy(
  {},
  {
    get: (_, envName) => {
      if (typeof envName !== "string") return undefined;
      const explicit = resolveConfigBlock(raw[envName]);
      if (explicit) return explicit;

      if (envName === "development" || envName === "test" || envName === "production") {
        return buildConfigForDatabase(resolvedDatabase || "postgres", raw[envName] || raw.development);
      }

      return buildConfigForDatabase(envName, raw.development);
    },
  }
);


