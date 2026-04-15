const fs = require("fs/promises");
const path = require("path");
const { Pool } = require("pg");

const runTenantMigrations = async (dbConfig) => {
  const tenantPool = new Pool({
    host: dbConfig.host,
    port: Number(dbConfig.port),
    database: dbConfig.database,
    user: dbConfig.user,
    password: dbConfig.password,
  });

  try {
    const migrationDirectory = path.join(__dirname);
    const files = await fs.readdir(migrationDirectory);
    const migrationFiles = files
      .filter((file) => file.endsWith(".sql"))
      .sort((a, b) => a.localeCompare(b));

    for (const fileName of migrationFiles) {
      const sqlPath = path.join(migrationDirectory, fileName);
      const sql = await fs.readFile(sqlPath, "utf8");
      await tenantPool.query(sql);
    }
  } finally {
    await tenantPool.end();
  }
};

module.exports = {
  runTenantMigrations,
};

