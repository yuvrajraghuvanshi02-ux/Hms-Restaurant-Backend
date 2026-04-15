const { pool } = require("../../config/db");

const ensureMasterSchema = async () => {
  const createRestaurantsTableQuery = `
    CREATE TABLE IF NOT EXISTS restaurants (
      id UUID PRIMARY KEY,
      name VARCHAR(150) NOT NULL,
      address TEXT,
      logo_url TEXT,
      status VARCHAR(30) NOT NULL DEFAULT 'active',
      db_name VARCHAR(120) NOT NULL UNIQUE,
      db_user VARCHAR(120) NOT NULL,
      db_password VARCHAR(255) NOT NULL,
      db_host VARCHAR(120) NOT NULL,
      db_port INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `;

  const createRestaurantAdminsTableQuery = `
    CREATE TABLE IF NOT EXISTS restaurant_admins (
      id UUID PRIMARY KEY,
      restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
      first_name VARCHAR(80) NOT NULL,
      last_name VARCHAR(80) NOT NULL,
      email VARCHAR(160) NOT NULL UNIQUE,
      phone VARCHAR(30) NOT NULL,
      password VARCHAR(255) NOT NULL,
      role VARCHAR(30) NOT NULL DEFAULT 'admin',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `;

  await pool.query(createRestaurantsTableQuery);
  await pool.query(createRestaurantAdminsTableQuery);

  // Keep schema forward-compatible for existing DBs
  await pool.query(
    "ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS status VARCHAR(30) NOT NULL DEFAULT 'active';"
  );
};

module.exports = {
  ensureMasterSchema,
};

