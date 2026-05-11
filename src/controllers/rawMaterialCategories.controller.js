const { randomUUID } = require("crypto");
const { logError } = require("../utils/logError");
const { parseListParams, buildPagination, pickSort } = require("../utils/listQuery");

const isUniqueViolation = (error) => error?.code === "23505";
const IN_USE_MESSAGE = "This item is already in use and cannot be deleted";
const RESTORED_MESSAGE = "This item already existed and has been restored";

const createRawMaterialCategory = async (req, res) => {
  const { name } = req.body || {};
  if (!name?.trim()) {
    return res.status(400).json({ message: "Category name is required." });
  }

  try {
    const activeExisting = await req.tenantDB.query(
      `
      SELECT id
      FROM raw_material_categories
      WHERE LOWER(name) = LOWER($1)
        AND COALESCE(is_active, TRUE) = TRUE
      LIMIT 1
      `,
      [name.trim()]
    );
    if (activeExisting.rowCount > 0) {
      return res.status(409).json({ message: "Category already exists." });
    }

    const inactiveExisting = await req.tenantDB.query(
      `
      SELECT id
      FROM raw_material_categories
      WHERE LOWER(name) = LOWER($1)
        AND COALESCE(is_active, TRUE) = FALSE
      LIMIT 1
      `,
      [name.trim()]
    );
    if (inactiveExisting.rowCount > 0) {
      const restored = await req.tenantDB.query(
        `
        UPDATE raw_material_categories
        SET name = $1,
            is_active = TRUE,
            updated_at = NOW()
        WHERE id = $2
        RETURNING id, name, is_active, created_at, updated_at
        `,
        [name.trim(), inactiveExisting.rows[0].id]
      );
      return res.status(200).json({ message: RESTORED_MESSAGE, data: restored.rows[0] });
    }

    const created = await req.tenantDB.query(
      `
      INSERT INTO raw_material_categories (id, name, is_active)
      VALUES ($1, $2, TRUE)
      RETURNING id, name, is_active, created_at, updated_at
      `,
      [randomUUID(), name.trim()]
    );
    return res.status(201).json({ message: "Category created.", data: created.rows[0] });
  } catch (error) {
    if (isUniqueViolation(error)) {
      return res.status(409).json({ message: "Category already exists." });
    }
    logError("POST /api/masters/raw-material-categories", error);
    return res.status(500).json({ message: "Failed to create category." });
  }
};

const listRawMaterialCategories = async (req, res) => {
  try {
    const params = parseListParams(req.query, { defaultSortBy: "name", defaultOrder: "ASC" });
    const { sortBy, order } = pickSort(params, ["name", "created_at", "updated_at"], "name");
    const where = params.search ? "WHERE is_active = TRUE AND name ILIKE $1" : "WHERE is_active = TRUE";
    const countArgs = params.search ? [`%${params.search}%`] : [];

    const totalResult = await req.tenantDB.query(
      `SELECT COUNT(*)::int AS total FROM raw_material_categories ${where}`,
      countArgs
    );
    const total = totalResult.rows[0]?.total ?? 0;

    const dataArgs = params.search
      ? [`%${params.search}%`, params.limit, params.offset]
      : [params.limit, params.offset];

    const result = await req.tenantDB.query(
      `
      SELECT id, name, is_active, created_at, updated_at
      FROM raw_material_categories
      ${where}
      ORDER BY ${sortBy} ${order}
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
    logError("GET /api/masters/raw-material-categories", error);
    return res.status(500).json({ message: "Failed to fetch categories." });
  }
};

const updateRawMaterialCategory = async (req, res) => {
  const { id } = req.params;
  const { name } = req.body || {};

  if (!name?.trim()) {
    return res.status(400).json({ message: "Category name is required." });
  }

  try {
    const existing = await req.tenantDB.query(
      "SELECT id FROM raw_material_categories WHERE id = $1 LIMIT 1",
      [id]
    );
    if (existing.rowCount === 0) {
      return res.status(404).json({ message: "Category not found." });
    }

    const updated = await req.tenantDB.query(
      `
      UPDATE raw_material_categories
      SET name = $1,
          updated_at = NOW()
      WHERE id = $2
      RETURNING id, name, is_active, created_at, updated_at
      `,
      [name.trim(), id]
    );
    return res.status(200).json({ message: "Category updated.", data: updated.rows[0] });
  } catch (error) {
    if (isUniqueViolation(error)) {
      return res.status(409).json({ message: "Category already exists." });
    }
    logError("PUT /api/masters/raw-material-categories/:id", error);
    return res.status(500).json({ message: "Failed to update category." });
  }
};

const deleteRawMaterialCategory = async (req, res) => {
  const { id } = req.params;
  try {
    const existing = await req.tenantDB.query(
      "SELECT id FROM raw_material_categories WHERE id = $1 LIMIT 1",
      [id]
    );
    if (existing.rowCount === 0) {
      return res.status(404).json({ message: "Category not found." });
    }

    const used = await req.tenantDB.query(
      "SELECT 1 FROM raw_materials WHERE category_id = $1 LIMIT 1",
      [id]
    );
    if (used.rowCount > 0) {
      return res.status(400).json({ message: IN_USE_MESSAGE });
    }

    await req.tenantDB.query(
      `
      UPDATE raw_material_categories
      SET is_active = FALSE,
          updated_at = NOW()
      WHERE id = $1
      `,
      [id]
    );
    return res.status(200).json({ message: "Category deactivated." });
  } catch (error) {
    logError("DELETE /api/masters/raw-material-categories/:id", error);
    return res.status(500).json({ message: "Failed to delete category." });
  }
};

module.exports = {
  createRawMaterialCategory,
  listRawMaterialCategories,
  updateRawMaterialCategory,
  deleteRawMaterialCategory,
};

