const bcrypt = require("bcrypt");
const fs = require("fs/promises");
const path = require("path");
const { randomUUID } = require("crypto");
const { pool } = require("../config/db");
const { getTenantPool } = require("../utils/tenantDbManager");
const { createTenantDatabase } = require("../utils/createTenantDatabase");
const { runTenantMigrations } = require("../migrations/tenant/runTenantMigrations");

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 8;

const buildTenantDbName = () =>
  `rms_restaurant_${Date.now()}_${randomUUID().replace(/-/g, "").slice(0, 8)}`;

const validateCreateRestaurantPayload = (payload) => {
  const errors = [];

  if (!payload.name?.trim()) errors.push("Restaurant name is required.");
  if (!payload.adminFirstName?.trim()) errors.push("Admin first name is required.");
  if (!payload.adminLastName?.trim()) errors.push("Admin last name is required.");
  if (!payload.adminEmail?.trim()) {
    errors.push("Admin email is required.");
  } else if (!EMAIL_REGEX.test(payload.adminEmail)) {
    errors.push("Admin email format is invalid.");
  }
  if (!payload.adminPhone?.trim()) errors.push("Admin phone number is required.");
  if (!payload.adminPassword) {
    errors.push("Admin password is required.");
  } else if (payload.adminPassword.length < MIN_PASSWORD_LENGTH) {
    errors.push(`Admin password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }

  return errors;
};

const createRestaurant = async (req, res) => {
  const {
    name,
    address,
    adminFirstName,
    adminLastName,
    adminEmail,
    adminPhone,
    adminPassword,
  } = req.body;

  const validationErrors = validateCreateRestaurantPayload({
    name,
    address,
    adminFirstName,
    adminLastName,
    adminEmail,
    adminPhone,
    adminPassword,
  });

  if (validationErrors.length > 0) {
    return res.status(400).json({
      message: "Validation failed.",
      errors: validationErrors,
    });
  }

  const normalizedEmail = adminEmail.trim().toLowerCase();
  const dbName = buildTenantDbName();
  const dbConfig = {
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    database: dbName,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
  };

  const restaurantId = randomUUID();
  const adminId = randomUUID();
  let logoUrl = null;

  try {
    const existingAdmin = await pool.query(
      "SELECT id FROM restaurant_admins WHERE email = $1 LIMIT 1",
      [normalizedEmail]
    );
    if (existingAdmin.rowCount > 0) {
      return res.status(409).json({ message: "Admin email already exists." });
    }

    if (req.file) {
      const uploadDir = path.join(__dirname, "..", "..", "uploads", "logos");
      await fs.mkdir(uploadDir, { recursive: true });
      const extension = path.extname(req.file.originalname || "").toLowerCase() || ".png";
      const fileName = `${restaurantId}${extension}`;
      await fs.writeFile(path.join(uploadDir, fileName), req.file.buffer);
      logoUrl = `/uploads/logos/${fileName}`;
    }

    const hashedPassword = await bcrypt.hash(adminPassword, 10);

    await createTenantDatabase(dbName);
    await runTenantMigrations(dbConfig);

    const tenantPool = getTenantPool(dbConfig);
    await tenantPool.query(
      `
      INSERT INTO users (id, first_name, last_name, email, password, role)
      VALUES ($1, $2, $3, $4, $5, 'admin')
      `,
      [adminId, adminFirstName.trim(), adminLastName.trim(), normalizedEmail, hashedPassword]
    );

    const masterClient = await pool.connect();
    try {
      await masterClient.query("BEGIN");
      await masterClient.query(
        `
        INSERT INTO restaurants
          (id, name, address, logo_url, db_name, db_user, db_password, db_host, db_port)
        VALUES
          ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        `,
        [
          restaurantId,
          name.trim(),
          address?.trim() || null,
          logoUrl,
          dbName,
          dbConfig.user,
          dbConfig.password,
          dbConfig.host,
          dbConfig.port,
        ]
      );

      await masterClient.query(
        `
        INSERT INTO restaurant_admins
          (id, restaurant_id, first_name, last_name, email, phone, password, role)
        VALUES
          ($1, $2, $3, $4, $5, $6, $7, 'admin')
        `,
        [
          adminId,
          restaurantId,
          adminFirstName.trim(),
          adminLastName.trim(),
          normalizedEmail,
          adminPhone.trim(),
          hashedPassword,
        ]
      );

      await masterClient.query("COMMIT");
    } catch (masterError) {
      await masterClient.query("ROLLBACK");
      throw masterError;
    } finally {
      masterClient.release();
    }

    return res.status(201).json({
      message: "Restaurant and tenant admin created successfully.",
      data: {
        restaurantId,
        restaurantName: name.trim(),
        adminId,
        adminEmail: normalizedEmail,
        tenantDatabase: dbName,
        logoUrl,
      },
    });
  } catch (error) {
    console.error("Create restaurant failed:", error.message);
    return res.status(500).json({
      message: "Failed to create restaurant tenant.",
      error: error.message,
    });
  }
};

module.exports = {
  createRestaurant,
  listRestaurants: async (req, res) => {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 10));
    const offset = (page - 1) * limit;
    const search = String(req.query.search || "").trim();
    const status = String(req.query.status || "").trim();

    const where = [];
    const params = [];

    if (search) {
      params.push(`%${search}%`);
      where.push(`(r.name ILIKE $${params.length} OR a.email ILIKE $${params.length})`);
    }

    if (status) {
      params.push(status);
      where.push(`r.status = $${params.length}`);
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const countQuery = `
      SELECT COUNT(*)::int AS total
      FROM restaurants r
      JOIN restaurant_admins a ON r.id = a.restaurant_id
      ${whereSql}
    `;

    const listQuery = `
      SELECT
        r.id,
        r.name,
        r.address,
        r.logo_url,
        r.status,
        r.created_at,
        a.id AS admin_id,
        a.first_name AS admin_first_name,
        a.last_name AS admin_last_name,
        a.email AS admin_email,
        a.phone AS admin_phone
      FROM restaurants r
      JOIN restaurant_admins a ON r.id = a.restaurant_id
      ${whereSql}
      ORDER BY r.created_at DESC
      OFFSET $${params.length + 1}
      LIMIT $${params.length + 2}
    `;

    const countResult = await pool.query(countQuery, params);
    const total = countResult.rows[0]?.total || 0;
    const totalPages = Math.max(1, Math.ceil(total / limit));

    const listResult = await pool.query(listQuery, [...params, offset, limit]);

    return res.status(200).json({
      data: listResult.rows,
      pagination: {
        total,
        page,
        limit,
        totalPages,
      },
    });
  },

  getRestaurantById: async (req, res) => {
    const { id } = req.params;
    const result = await pool.query(
      `
      SELECT
        r.id,
        r.name,
        r.address,
        r.logo_url,
        r.status,
        r.created_at,
        a.id AS admin_id,
        a.first_name AS admin_first_name,
        a.last_name AS admin_last_name,
        a.email AS admin_email,
        a.phone AS admin_phone,
        a.role AS admin_role,
        a.created_at AS admin_created_at
      FROM restaurants r
      JOIN restaurant_admins a ON r.id = a.restaurant_id
      WHERE r.id = $1
      LIMIT 1
      `,
      [id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ message: "Restaurant not found." });
    }

    return res.status(200).json({ data: result.rows[0] });
  },

  updateRestaurant: async (req, res) => {
    const { id } = req.params;
    const {
      name,
      address,
      logo_url,
      admin_first_name,
      admin_last_name,
      admin_email,
      admin_phone,
      admin_password,
    } = req.body || {};

    const errors = [];
    if (name !== undefined && !String(name).trim()) errors.push("Restaurant name cannot be empty.");
    if (admin_email !== undefined && String(admin_email).trim() && !EMAIL_REGEX.test(admin_email)) {
      errors.push("Admin email format is invalid.");
    }
    if (admin_password !== undefined && admin_password) {
      if (String(admin_password).length < MIN_PASSWORD_LENGTH) {
        errors.push(`Admin password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      }
    }

    if (errors.length) {
      return res.status(400).json({ message: "Validation failed.", errors });
    }

    const current = await pool.query(
      `
      SELECT r.id, a.id AS admin_id
      FROM restaurants r
      JOIN restaurant_admins a ON r.id = a.restaurant_id
      WHERE r.id = $1
      LIMIT 1
      `,
      [id]
    );
    if (current.rowCount === 0) {
      return res.status(404).json({ message: "Restaurant not found." });
    }
    const adminId = current.rows[0].admin_id;

    const normalizedEmail = admin_email ? String(admin_email).trim().toLowerCase() : null;
    if (normalizedEmail) {
      const conflict = await pool.query(
        "SELECT id FROM restaurant_admins WHERE email = $1 AND id <> $2 LIMIT 1",
        [normalizedEmail, adminId]
      );
      if (conflict.rowCount > 0) {
        return res.status(409).json({ message: "Admin email already exists." });
      }
    }

    const restaurantFields = [];
    const restaurantValues = [];
    if (name !== undefined) {
      restaurantValues.push(String(name).trim());
      restaurantFields.push(`name = $${restaurantValues.length}`);
    }
    if (address !== undefined) {
      restaurantValues.push(String(address).trim() || null);
      restaurantFields.push(`address = $${restaurantValues.length}`);
    }
    if (logo_url !== undefined) {
      restaurantValues.push(String(logo_url).trim() || null);
      restaurantFields.push(`logo_url = $${restaurantValues.length}`);
    }

    const adminFields = [];
    const adminValues = [];
    if (admin_first_name !== undefined) {
      adminValues.push(String(admin_first_name).trim());
      adminFields.push(`first_name = $${adminValues.length}`);
    }
    if (admin_last_name !== undefined) {
      adminValues.push(String(admin_last_name).trim());
      adminFields.push(`last_name = $${adminValues.length}`);
    }
    if (admin_phone !== undefined) {
      adminValues.push(String(admin_phone).trim());
      adminFields.push(`phone = $${adminValues.length}`);
    }
    if (normalizedEmail !== null) {
      adminValues.push(normalizedEmail);
      adminFields.push(`email = $${adminValues.length}`);
    }
    if (admin_password) {
      const hashed = await bcrypt.hash(String(admin_password), 10);
      adminValues.push(hashed);
      adminFields.push(`password = $${adminValues.length}`);
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      if (restaurantFields.length) {
        await client.query(
          `UPDATE restaurants SET ${restaurantFields.join(", ")} WHERE id = $${
            restaurantValues.length + 1
          }`,
          [...restaurantValues, id]
        );
      }

      if (adminFields.length) {
        await client.query(
          `UPDATE restaurant_admins SET ${adminFields.join(", ")} WHERE id = $${
            adminValues.length + 1
          }`,
          [...adminValues, adminId]
        );
      }

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    const updated = await pool.query(
      `
      SELECT
        r.id,
        r.name,
        r.address,
        r.logo_url,
        r.status,
        r.created_at,
        a.id AS admin_id,
        a.first_name AS admin_first_name,
        a.last_name AS admin_last_name,
        a.email AS admin_email,
        a.phone AS admin_phone
      FROM restaurants r
      JOIN restaurant_admins a ON r.id = a.restaurant_id
      WHERE r.id = $1
      LIMIT 1
      `,
      [id]
    );

    return res.status(200).json({
      message: "Restaurant updated successfully.",
      data: updated.rows[0],
    });
  },
};

