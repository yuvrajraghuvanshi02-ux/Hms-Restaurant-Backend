const { Pool } = require("pg");
require("dotenv").config();

const isProduction = process.env.NODE_ENV === "production";
const dbName = isProduction
  ? process.env.PG_DB || process.env.PGDATABASE || process.env.DB_NAME || "postgres"
  : process.env.DB_NAME;
const dbUser = isProduction ? process.env.PG_USER : process.env.DB_USER;
const dbPassword = isProduction ? process.env.PG_PASSWORD : process.env.DB_PASSWORD;
const dbHost = isProduction ? process.env.PG_HOST : process.env.DB_HOST;
const dbPort = isProduction ? process.env.PG_PORT : process.env.DB_PORT;
const sslEnabled = isProduction;

console.log("Resolved DB Config", {
  dbName,
  dbUser,
  dbHost,
  dbPort,
  nodeEnv: process.env.NODE_ENV,
});

const pool = new Pool({
  host: dbHost,
  port: Number(dbPort || 5432),
  database: dbName,
  user: dbUser,
  password: dbPassword,
  ...(sslEnabled
    ? {
        ssl: {
          require: true,
          rejectUnauthorized: false,
        },
      }
    : {}),
});

const testDbConnection = async () => {
  try {
    const client = await pool.connect();
    await client.query("SELECT NOW()");
    client.release();
    console.log("Database connected successfully.");
  } catch (error) {
    console.error("Failed to connect to database:", error.message);
    throw error;
  }
};

module.exports = {
  pool,
  testDbConnection,
};
