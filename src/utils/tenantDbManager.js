const { Pool } = require("pg");

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
      })
    );
  }

  return tenantPools.get(cacheKey);
};

module.exports = {
  getTenantPool,
};
