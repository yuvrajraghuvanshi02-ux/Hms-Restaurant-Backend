require("dotenv").config();
const bcrypt = require("bcrypt");
const { pool } = require("../config/db");

const DEFAULT_ADMIN = {
  firstName: "Super",
  lastName: "Admin",
  email: "superadmin@restaurant.com",
  password: "Super@123",
};

const ensureSuperAdminTable = async () => {
  await pool.query('CREATE EXTENSION IF NOT EXISTS "pgcrypto";');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS super_admin_users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      first_name TEXT NOT NULL,
      last_name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      role TEXT DEFAULT 'super_admin',
      status TEXT DEFAULT 'active',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
};

const createSuperAdmin = async () => {
  try {
    await ensureSuperAdminTable();

    const existingUser = await pool.query(
      "SELECT id FROM super_admin_users WHERE email = $1 LIMIT 1",
      [DEFAULT_ADMIN.email]
    );

    if (existingUser.rowCount > 0) {
      console.log("Super admin already exists.");
      process.exit(0);
    }

    const hashedPassword = await bcrypt.hash(DEFAULT_ADMIN.password, 10);

    await pool.query(
      `
      INSERT INTO super_admin_users (first_name, last_name, email, password)
      VALUES ($1, $2, $3, $4)
      `,
      [
        DEFAULT_ADMIN.firstName,
        DEFAULT_ADMIN.lastName,
        DEFAULT_ADMIN.email,
        hashedPassword,
      ]
    );

    console.log("Super admin created successfully.");
    process.exit(0);
  } catch (error) {
    console.error("Failed to create super admin:", error.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
};

createSuperAdmin();
