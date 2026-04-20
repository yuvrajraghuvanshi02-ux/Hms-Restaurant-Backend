const { randomUUID } = require("crypto");
const { logError } = require("../utils/logError");
const { parseListParams, buildPagination, pickSort } = require("../utils/listQuery");

const isUniqueViolation = (error) => error?.code === "23505";
const allowedClosingStockTypes = new Set(["daily", "weekly", "monthly", "yearly"]);

const parseNumber = (value, { label, allowNull = false, min = 0, max = null }) => {
  if (value === undefined || value === null || value === "") {
    if (allowNull) return null;
    return 0;
  }
  const num = Number(value);
  if (Number.isNaN(num)) throw new Error(`${label} must be a valid number.`);
  if (num < min) throw new Error(`${label} must be greater than or equal to ${min}.`);
  if (max !== null && num > max) throw new Error(`${label} must be between ${min} and ${max}.`);
  return num;
};

const createUnit = async (req, res) => {
  const { name, short_name } = req.body || {};

  if (!name?.trim() || !short_name?.trim()) {
    return res
      .status(400)
      .json({ message: "Unit name and short name are required." });
  }

  try {
    const result = await req.tenantDB.query(
      `
      INSERT INTO units (id, name, short_name)
      VALUES ($1, $2, $3)
      RETURNING id, name, short_name, created_at
      `,
      [randomUUID(), name.trim(), short_name.trim()]
    );
    return res.status(201).json({ message: "Unit created.", data: result.rows[0] });
  } catch (error) {
    if (isUniqueViolation(error)) {
      return res.status(409).json({ message: "Unit already exists." });
    }
    logError("POST /api/inventory/units", error);
    return res.status(500).json({ message: "Failed to create unit." });
  }
};

const listUnits = async (req, res) => {
  try {
    const params = parseListParams(req.query, { defaultSortBy: "created_at", defaultOrder: "DESC" });
    const { sortBy, order } = pickSort(params, ["created_at", "name", "short_name"], "created_at");

    const where = params.search ? "WHERE name ILIKE $1 OR short_name ILIKE $1" : "";
    const countArgs = params.search ? [`%${params.search}%`] : [];

    const totalResult = await req.tenantDB.query(
      `SELECT COUNT(*)::int AS total FROM units ${where}`,
      countArgs
    );
    const total = totalResult.rows[0]?.total ?? 0;

    const dataArgs = params.search
      ? [`%${params.search}%`, params.limit, params.offset]
      : [params.limit, params.offset];
    const dataQuery = `
      SELECT id, name, short_name, created_at
      FROM units
      ${where}
      ORDER BY ${sortBy} ${order}
      LIMIT $${params.search ? 2 : 1} OFFSET $${params.search ? 3 : 2}
    `;
    const result = await req.tenantDB.query(dataQuery, dataArgs);

    return res.status(200).json({
      data: result.rows,
      pagination: buildPagination({ total, page: params.page, limit: params.limit }),
    });
  } catch (error) {
    logError("GET /api/inventory/units", error);
    return res.status(500).json({ message: "Failed to fetch units." });
  }
};

const updateUnit = async (req, res) => {
  const { id } = req.params;
  const { name, short_name } = req.body || {};

  if (!name?.trim() || !short_name?.trim()) {
    return res.status(400).json({ message: "Unit name and short name are required." });
  }

  try {
    const existing = await req.tenantDB.query(
      "SELECT id FROM units WHERE id = $1 LIMIT 1",
      [id]
    );
    if (existing.rowCount === 0) {
      return res.status(404).json({ message: "Unit not found." });
    }

    const updated = await req.tenantDB.query(
      `
      UPDATE units
      SET name = $1, short_name = $2
      WHERE id = $3
      RETURNING id, name, short_name, created_at
      `,
      [name.trim(), short_name.trim(), id]
    );

    return res.status(200).json({ message: "Unit updated.", data: updated.rows[0] });
  } catch (error) {
    if (isUniqueViolation(error)) {
      return res.status(409).json({ message: "Unit already exists." });
    }
    logError("PUT /api/inventory/units/:id", error);
    return res.status(500).json({ message: "Failed to update unit." });
  }
};

const deleteUnit = async (req, res) => {
  const { id } = req.params;

  try {
    const existing = await req.tenantDB.query(
      "SELECT id FROM units WHERE id = $1 LIMIT 1",
      [id]
    );
    if (existing.rowCount === 0) {
      return res.status(404).json({ message: "Unit not found." });
    }

    const used = await req.tenantDB.query(
      `
      SELECT 1
      FROM raw_materials
      WHERE unit_id = $1
         OR purchase_unit_id = $1
         OR consumption_unit_id = $1
         OR stock_unit_id = $1
      LIMIT 1
      `,
      [id]
    );
    if (used.rowCount > 0) {
      return res
        .status(400)
        .json({ message: "Cannot delete unit, it is linked with raw materials" });
    }

    await req.tenantDB.query("DELETE FROM units WHERE id = $1", [id]);
    return res.status(200).json({ message: "Unit deleted." });
  } catch (error) {
    logError("DELETE /api/inventory/units/:id", error);
    return res.status(500).json({ message: "Failed to delete unit." });
  }
};

const createRawMaterial = async (req, res) => {
  const {
    name,
    category_id,
    purchase_unit_id,
    consumption_unit_id,
    conversion_factor,
    purchase_price,
    transfer_price,
    reconciliation_price,
    normal_loss_percent,
    gst_percent,
    min_stock_level,
    closing_stock_type,
    is_expiry,
    auto_hide_on_low_stock,
  } = req.body || {};

  if (!name?.trim()) {
    return res.status(400).json({ message: "Raw material name is required." });
  }
  if (!purchase_unit_id?.trim() || !consumption_unit_id?.trim()) {
    return res
      .status(400)
      .json({ message: "Purchase unit and consumption unit are required." });
  }

  let parsed;
  try {
    parsed = {
      purchasePrice: parseNumber(purchase_price, { label: "Purchase price", min: 0 }),
      transferPrice: parseNumber(transfer_price, { label: "Transfer price", min: 0 }),
      reconciliationPrice: parseNumber(reconciliation_price, {
        label: "Reconciliation price",
        min: 0,
      }),
      normalLossPercent: parseNumber(normal_loss_percent, {
        label: "Normal loss percent",
        min: 0,
        max: 100,
      }),
      gstPercent: parseNumber(gst_percent, { label: "GST percent", min: 0, max: 100 }),
      minStockLevel: parseNumber(min_stock_level, { label: "Minimum stock level", min: 0 }),
      conversionFactor: parseNumber(conversion_factor, {
        label: "Conversion factor",
        min: Number.EPSILON,
      }),
    };
  } catch (validationError) {
    return res.status(400).json({ message: validationError.message });
  }

  const closingType = String(closing_stock_type || "monthly").toLowerCase();
  if (!allowedClosingStockTypes.has(closingType)) {
    return res.status(400).json({ message: "Invalid closing stock type." });
  }

  try {
    let categoryName = null;
    if (category_id?.trim()) {
      const cat = await req.tenantDB.query(
        "SELECT id, name FROM raw_material_categories WHERE id = $1 LIMIT 1",
        [category_id]
      );
      if (cat.rowCount === 0) {
        return res.status(400).json({ message: "Selected category does not exist." });
      }
      categoryName = cat.rows[0].name;
    }

    const purchaseUnitExists = await req.tenantDB.query(
      "SELECT id FROM units WHERE id = $1 LIMIT 1",
      [purchase_unit_id]
    );
    const consumptionUnitExists = await req.tenantDB.query(
      "SELECT id FROM units WHERE id = $1 LIMIT 1",
      [consumption_unit_id]
    );
    if (purchaseUnitExists.rowCount === 0 || consumptionUnitExists.rowCount === 0) {
      return res
        .status(400)
        .json({ message: "Selected purchase/consumption unit does not exist." });
    }

    const result = await req.tenantDB.query(
      `
      INSERT INTO raw_materials (
        id,
        name,
        category,
        category_id,
        unit_id,
        purchase_unit_id,
        consumption_unit_id,
        purchase_price,
        transfer_price,
        reconciliation_price,
        normal_loss_percent,
        gst_percent,
        conversion_factor,
        min_stock_level,
        min_stock,
        closing_stock_type,
        is_expiry,
        auto_hide_on_low_stock
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7,
        $8, $9, $10, $11, $12, $13, $14, $14, $15, $16, $17
      )
      RETURNING *
      `,
      [
        randomUUID(),
        name.trim(),
        categoryName,
        category_id?.trim() || null,
        purchase_unit_id,
        purchase_unit_id,
        consumption_unit_id,
        parsed.purchasePrice,
        parsed.transferPrice,
        parsed.reconciliationPrice,
        parsed.normalLossPercent,
        parsed.gstPercent,
        parsed.conversionFactor,
        parsed.minStockLevel,
        closingType,
        Boolean(is_expiry),
        Boolean(auto_hide_on_low_stock),
      ]
    );

    return res.status(201).json({ message: "Raw material created.", data: result.rows[0] });
  } catch (error) {
    if (isUniqueViolation(error)) {
      return res.status(409).json({ message: "Raw material already exists." });
    }
    logError("POST /api/inventory/raw-materials", error);
    return res.status(500).json({ message: "Failed to create raw material." });
  }
};

const listRawMaterials = async (req, res) => {
  try {
    const params = parseListParams(req.query, { defaultSortBy: "created_at", defaultOrder: "DESC" });
    const { sortBy, order } = pickSort(params, ["created_at", "name"], "created_at");
    const searchWhere = params.search ? "WHERE rm.name ILIKE $1" : "";
    const countArgs = params.search ? [`%${params.search}%`] : [];

    const totalResult = await req.tenantDB.query(
      `SELECT COUNT(*)::int AS total FROM raw_materials rm ${searchWhere}`,
      countArgs
    );
    const total = totalResult.rows[0]?.total ?? 0;

    const dataArgs = params.search
      ? [`%${params.search}%`, params.limit, params.offset]
      : [params.limit, params.offset];

    const result = await req.tenantDB.query(
      `
      SELECT
        rm.id,
        rm.name,
        rm.category_id,
        c.name AS category_name,
        rm.purchase_unit_id,
        pu.name AS purchase_unit_name,
        pu.short_name AS purchase_unit_short_name,
        rm.consumption_unit_id,
        cu.name AS consumption_unit_name,
        cu.short_name AS consumption_unit_short_name,
        rm.current_stock,
        rm.purchase_price,
        rm.transfer_price,
        rm.reconciliation_price,
        rm.normal_loss_percent,
        rm.gst_percent,
        rm.conversion_factor,
        rm.min_stock_level,
        rm.closing_stock_type,
        rm.is_expiry,
        rm.auto_hide_on_low_stock,
        rm.created_at
      FROM raw_materials rm
      LEFT JOIN raw_material_categories c ON c.id = rm.category_id
      LEFT JOIN units pu ON pu.id = rm.purchase_unit_id
      LEFT JOIN units cu ON cu.id = rm.consumption_unit_id
      ${searchWhere}
      ORDER BY rm.${sortBy} ${order}
      LIMIT $${params.search ? 2 : 1} OFFSET $${params.search ? 3 : 2}
      `
      ,
      dataArgs
    );
    return res.status(200).json({
      data: result.rows,
      pagination: buildPagination({ total, page: params.page, limit: params.limit }),
    });
  } catch (error) {
    logError("GET /api/inventory/raw-materials", error);
    return res.status(500).json({ message: "Failed to fetch raw materials." });
  }
};

const updateRawMaterial = async (req, res) => {
  const { id } = req.params;
  const {
    name,
    category_id,
    purchase_unit_id,
    consumption_unit_id,
    conversion_factor,
    purchase_price,
    transfer_price,
    reconciliation_price,
    normal_loss_percent,
    gst_percent,
    min_stock_level,
    closing_stock_type,
    is_expiry,
    auto_hide_on_low_stock,
  } = req.body || {};

  if (!name?.trim()) {
    return res.status(400).json({ message: "Name is required." });
  }
  if (!purchase_unit_id?.trim() || !consumption_unit_id?.trim()) {
    return res
      .status(400)
      .json({ message: "Purchase unit and consumption unit are required." });
  }

  let parsed;
  try {
    parsed = {
      purchasePrice: parseNumber(purchase_price, { label: "Purchase price", min: 0 }),
      transferPrice: parseNumber(transfer_price, { label: "Transfer price", min: 0 }),
      reconciliationPrice: parseNumber(reconciliation_price, {
        label: "Reconciliation price",
        min: 0,
      }),
      normalLossPercent: parseNumber(normal_loss_percent, {
        label: "Normal loss percent",
        min: 0,
        max: 100,
      }),
      gstPercent: parseNumber(gst_percent, { label: "GST percent", min: 0, max: 100 }),
      minStockLevel: parseNumber(min_stock_level, { label: "Minimum stock level", min: 0 }),
      conversionFactor: parseNumber(conversion_factor, {
        label: "Conversion factor",
        min: Number.EPSILON,
      }),
    };
  } catch (validationError) {
    return res.status(400).json({ message: validationError.message });
  }

  const closingType = String(closing_stock_type || "monthly").toLowerCase();
  if (!allowedClosingStockTypes.has(closingType)) {
    return res.status(400).json({ message: "Invalid closing stock type." });
  }

  try {
    let categoryName = null;
    if (category_id?.trim()) {
      const cat = await req.tenantDB.query(
        "SELECT id, name FROM raw_material_categories WHERE id = $1 LIMIT 1",
        [category_id]
      );
      if (cat.rowCount === 0) {
        return res.status(400).json({ message: "Selected category does not exist." });
      }
      categoryName = cat.rows[0].name;
    }

    const existing = await req.tenantDB.query(
      "SELECT id FROM raw_materials WHERE id = $1 LIMIT 1",
      [id]
    );
    if (existing.rowCount === 0) {
      return res.status(404).json({ message: "Raw material not found." });
    }

    const purchaseUnitExists = await req.tenantDB.query(
      "SELECT id FROM units WHERE id = $1 LIMIT 1",
      [purchase_unit_id]
    );
    const consumptionUnitExists = await req.tenantDB.query(
      "SELECT id FROM units WHERE id = $1 LIMIT 1",
      [consumption_unit_id]
    );
    if (purchaseUnitExists.rowCount === 0 || consumptionUnitExists.rowCount === 0) {
      return res
        .status(400)
        .json({ message: "Selected purchase/consumption unit does not exist." });
    }

    const updated = await req.tenantDB.query(
      `
      UPDATE raw_materials
      SET name = $1,
          category = $2,
          category_id = $3,
          unit_id = $4,
          purchase_unit_id = $4,
          consumption_unit_id = $5,
          purchase_price = $6,
          transfer_price = $7,
          reconciliation_price = $8,
          normal_loss_percent = $9,
          gst_percent = $10,
          conversion_factor = $11,
          min_stock_level = $12,
          min_stock = $12,
          closing_stock_type = $13,
          is_expiry = $14,
          auto_hide_on_low_stock = $15
      WHERE id = $16
      RETURNING *
      `,
      [
        name.trim(),
        categoryName,
        category_id?.trim() || null,
        purchase_unit_id,
        consumption_unit_id,
        parsed.purchasePrice,
        parsed.transferPrice,
        parsed.reconciliationPrice,
        parsed.normalLossPercent,
        parsed.gstPercent,
        parsed.conversionFactor,
        parsed.minStockLevel,
        closingType,
        Boolean(is_expiry),
        Boolean(auto_hide_on_low_stock),
        id,
      ]
    );

    return res.status(200).json({ message: "Raw material updated.", data: updated.rows[0] });
  } catch (error) {
    if (isUniqueViolation(error)) {
      return res.status(409).json({ message: "Raw material already exists." });
    }
    logError("PUT /api/inventory/raw-materials/:id", error);
    return res.status(500).json({ message: "Failed to update raw material." });
  }
};

const deleteRawMaterial = async (req, res) => {
  const { id } = req.params;
  try {
    const existing = await req.tenantDB.query(
      "SELECT id FROM raw_materials WHERE id = $1 LIMIT 1",
      [id]
    );
    if (existing.rowCount === 0) {
      return res.status(404).json({ message: "Raw material not found." });
    }
    await req.tenantDB.query("DELETE FROM raw_materials WHERE id = $1", [id]);
    return res.status(200).json({ message: "Raw material deleted." });
  } catch (error) {
    logError("DELETE /api/inventory/raw-materials/:id", error);
    return res.status(500).json({ message: "Failed to delete raw material." });
  }
};

module.exports = {
  createUnit,
  listUnits,
  updateUnit,
  deleteUnit,
  createRawMaterial,
  listRawMaterials,
  updateRawMaterial,
  deleteRawMaterial,
};

