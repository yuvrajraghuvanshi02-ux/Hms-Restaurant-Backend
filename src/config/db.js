const { Pool } = require("pg");

const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
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
