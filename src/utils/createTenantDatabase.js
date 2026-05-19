const { Pool } = require("pg");
require("dotenv").config();

const isProduction = process.env.NODE_ENV === "production";
const adminDbUser = isProduction ? process.env.PG_USER : process.env.DB_USER;
const adminDbPassword = isProduction ? process.env.PG_PASSWORD : process.env.DB_PASSWORD;
const adminDbHost = isProduction ? process.env.PG_HOST : process.env.DB_HOST;
const adminDbPort = isProduction ? process.env.PG_PORT : process.env.DB_PORT;
const sslEnabled = isProduction;

const quoteIdentifier = (value) => `"${String(value).replace(/"/g, "\"\"")}"`;

const createTenantDatabase = async (databaseName) => {
  const adminPool = new Pool({
    host: adminDbHost,
    port: Number(adminDbPort || 5432),
    database: "postgres",
    user: adminDbUser,
    password: adminDbPassword,
    ...(sslEnabled
      ? {
          ssl: {
            require: true,
            rejectUnauthorized: false,
          },
        }
      : {}),
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

