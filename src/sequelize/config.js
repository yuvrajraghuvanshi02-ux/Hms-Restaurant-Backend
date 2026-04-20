const fs = require("fs");
const path = require("path");

const baseConfigPath = path.join(__dirname, "config.json");
const raw = JSON.parse(fs.readFileSync(baseConfigPath, "utf8"));

const expandEnv = (value) => {
  if (typeof value !== "string") return value;
  return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_, key) => process.env[key] ?? "");
};

const resolveConfigBlock = (block) => {
  if (!block || typeof block !== "object") return null;
  const dialect = block.dialect || "postgres";
  const host = expandEnv(block.host) || process.env.DB_HOST;
  const port = Number(expandEnv(block.port) || process.env.DB_PORT || 5432);
  const username = expandEnv(block.username) || process.env.DB_USER;
  const password = expandEnv(block.password) || process.env.DB_PASSWORD;
  const database = expandEnv(block.database) || process.env.DB_NAME;
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
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 5432),
    username: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
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
        return buildConfigForDatabase(process.env.DB_NAME || "postgres", raw[envName] || raw.development);
      }

      return buildConfigForDatabase(envName, raw.development);
    },
  }
);


