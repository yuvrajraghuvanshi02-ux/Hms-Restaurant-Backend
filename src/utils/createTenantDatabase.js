const { Pool } = require("pg");

const quoteIdentifier = (value) => `"${String(value).replace(/"/g, "\"\"")}"`;

const createTenantDatabase = async (databaseName) => {
  const adminPool = new Pool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    database: "postgres",
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
  });

  try {
    await adminPool.query(`CREATE DATABASE ${quoteIdentifier(databaseName)};`);
  } finally {
    await adminPool.end();
  }
};

module.exports = {
  createTenantDatabase,
};

