const { Pool } = require("pg");
const isProduction = process.env.NODE_ENV === "production";

const tenantPools = new Map();

const getTenantPool = (tenantDatabaseConfig) => {
  const cacheKey = `${tenantDatabaseConfig.host}:${tenantDatabaseConfig.port}:${tenantDatabaseConfig.database}:${tenantDatabaseConfig.user}`;

  if (!tenantPools.has(cacheKey)) {
    tenantPools.set(
      cacheKey,
      new Pool({
        host: tenantDatabaseConfig.host,
        port: Number(tenantDatabaseConfig.port),
        database: tenantDatabaseConfig.database,
        user: tenantDatabaseConfig.user,
        password: tenantDatabaseConfig.password,
        ...(isProduction
          ? {
              ssl: {
                require: true,
                rejectUnauthorized: false,
              },
            }
          : {}),
      })
    );
  }

  return tenantPools.get(cacheKey);
};

module.exports = {
  getTenantPool,
};
