const { randomUUID } = require("crypto");
const { logError } = require("../utils/logError");
const { parseListParams, buildPagination, pickSort } = require("../utils/listQuery");

const isUniqueViolation = (error) => error?.code === "23505";

const createRawMaterialCategory = async (req, res) => {
  const { name } = req.body || {};
  if (!name?.trim()) {
    return res.status(400).json({ message: "Category name is required." });
  }

  try {
    const created = await req.tenantDB.query(
      `
      INSERT INTO raw_material_categories (id, name)
      VALUES ($1, $2)
      RETURNING id, name, created_at, updated_at
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
    const where = params.search ? "WHERE name ILIKE $1" : "";
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
      SELECT id, name, created_at, updated_at
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
      RETURNING id, name, created_at, updated_at
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
      return res
        .status(400)
        .json({ message: "Cannot delete category, it is linked with raw materials" });
    }

    await req.tenantDB.query("DELETE FROM raw_material_categories WHERE id = $1", [id]);
    return res.status(200).json({ message: "Category deleted." });
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

