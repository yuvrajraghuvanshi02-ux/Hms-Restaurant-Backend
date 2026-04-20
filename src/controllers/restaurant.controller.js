const bcrypt = require("bcrypt");
const fs = require("fs/promises");
const path = require("path");
const { randomUUID } = require("crypto");
const { Op } = require("sequelize");
const { masterSequelize, Restaurant, RestaurantAdmin } = require("../orm/master");
const { getTenantPool } = require("../utils/tenantDbManager");
const { createTenantDatabase } = require("../utils/createTenantDatabase");
const { runTenantMigrations } = require("../sequelize/runTenantMigrations");
const { getTenantSequelize } = require("../orm/tenant");
const { logError } = require("../utils/logError");

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
    const existingAdmin = await RestaurantAdmin.findOne({
      where: { email: { [Op.iLike]: normalizedEmail } },
      attributes: ["id"],
    });
    if (existingAdmin) {
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

    const tenant = getTenantSequelize(dbConfig);
    await tenant.models.TenantUser.create({
      id: adminId,
      first_name: adminFirstName.trim(),
      last_name: adminLastName.trim(),
      email: normalizedEmail,
      password: hashedPassword,
      role: "admin",
    });

    await masterSequelize.transaction(async (t) => {
      await Restaurant.create(
        {
          id: restaurantId,
          name: name.trim(),
          address: address?.trim() || null,
          logo_url: logoUrl,
          db_name: dbName,
          db_user: dbConfig.user,
          db_password: dbConfig.password,
          db_host: dbConfig.host,
          db_port: dbConfig.port,
        },
        { transaction: t }
      );

      await RestaurantAdmin.create(
        {
          id: adminId,
          restaurant_id: restaurantId,
          first_name: adminFirstName.trim(),
          last_name: adminLastName.trim(),
          email: normalizedEmail,
          phone: adminPhone.trim(),
          password: hashedPassword,
          role: "admin",
        },
        { transaction: t }
      );
    });

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
    logError("POST /api/restaurants/create", error);
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

    const where = {};
    const adminWhere = {};
    if (status) where.status = status;
    if (search) {
      where.name = { [Op.iLike]: `%${search}%` };
      adminWhere.email = { [Op.iLike]: `%${search}%` };
    }

    const { rows, count } = await Restaurant.findAndCountAll({
      where:
        search
          ? {
              [Op.or]: [{ name: { [Op.iLike]: `%${search}%` } }],
              ...(status ? { status } : {}),
            }
          : where,
      include: [
        {
          model: RestaurantAdmin,
          as: "admin",
          required: true,
          where: search ? { [Op.or]: [adminWhere, {}] } : undefined,
        },
      ],
      order: [["created_at", "DESC"]],
      offset,
      limit,
    });

    const total = count;
    const totalPages = Math.max(1, Math.ceil(total / limit));

    return res.status(200).json({
      data: rows.map((r) => {
        const json = r.toJSON();
        return {
          id: json.id,
          name: json.name,
          address: json.address,
          logo_url: json.logo_url,
          db_name: json.db_name,
          status: json.status,
          created_at: json.created_at,
          admin_id: json.admin?.id,
          admin_first_name: json.admin?.first_name,
          admin_last_name: json.admin?.last_name,
          admin_email: json.admin?.email,
          admin_phone: json.admin?.phone,
        };
      }),
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
    const restaurant = await Restaurant.findByPk(id, {
      include: [{ model: RestaurantAdmin, as: "admin", required: true }],
    });

    if (!restaurant) {
      return res.status(404).json({ message: "Restaurant not found." });
    }

    const json = restaurant.toJSON();
    return res.status(200).json({
      data: {
        id: json.id,
        name: json.name,
        address: json.address,
        logo_url: json.logo_url,
        db_name: json.db_name,
        status: json.status,
        created_at: json.created_at,
        admin_id: json.admin?.id,
        admin_first_name: json.admin?.first_name,
        admin_last_name: json.admin?.last_name,
        admin_email: json.admin?.email,
        admin_phone: json.admin?.phone,
        admin_role: json.admin?.role,
        admin_created_at: json.admin?.created_at,
      },
    });
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

    const restaurant = await Restaurant.findByPk(id, {
      include: [{ model: RestaurantAdmin, as: "admin", required: true }],
    });
    if (!restaurant) {
      return res.status(404).json({ message: "Restaurant not found." });
    }
    const adminId = restaurant.admin.id;

    const normalizedEmail = admin_email ? String(admin_email).trim().toLowerCase() : null;
    if (normalizedEmail) {
      const conflict = await RestaurantAdmin.findOne({
        where: {
          email: { [Op.iLike]: normalizedEmail },
          id: { [Op.ne]: adminId },
        },
        attributes: ["id"],
      });
      if (conflict) {
        return res.status(409).json({ message: "Admin email already exists." });
      }
    }

    await masterSequelize.transaction(async (t) => {
      const restaurantUpdates = {};
      if (name !== undefined) restaurantUpdates.name = String(name).trim();
      if (address !== undefined) restaurantUpdates.address = String(address).trim() || null;
      if (logo_url !== undefined) restaurantUpdates.logo_url = String(logo_url).trim() || null;
      if (Object.keys(restaurantUpdates).length) {
        await restaurant.update(restaurantUpdates, { transaction: t });
      }

      const adminUpdates = {};
      if (admin_first_name !== undefined)
        adminUpdates.first_name = String(admin_first_name).trim();
      if (admin_last_name !== undefined) adminUpdates.last_name = String(admin_last_name).trim();
      if (admin_phone !== undefined) adminUpdates.phone = String(admin_phone).trim();
      if (normalizedEmail !== null) adminUpdates.email = normalizedEmail;
      if (admin_password) adminUpdates.password = await bcrypt.hash(String(admin_password), 10);
      if (Object.keys(adminUpdates).length) {
        await restaurant.admin.update(adminUpdates, { transaction: t });
      }
    });

    const updatedRestaurant = await Restaurant.findByPk(id, {
      include: [{ model: RestaurantAdmin, as: "admin", required: true }],
    });

    return res.status(200).json({
      message: "Restaurant updated successfully.",
      data: {
        id: updatedRestaurant.id,
        name: updatedRestaurant.name,
        address: updatedRestaurant.address,
        logo_url: updatedRestaurant.logo_url,
        db_name: updatedRestaurant.db_name,
        status: updatedRestaurant.status,
        created_at: updatedRestaurant.created_at,
        admin_id: updatedRestaurant.admin.id,
        admin_first_name: updatedRestaurant.admin.first_name,
        admin_last_name: updatedRestaurant.admin.last_name,
        admin_email: updatedRestaurant.admin.email,
        admin_phone: updatedRestaurant.admin.phone,
      },
    });
  },
};

