const { randomUUID } = require("crypto");
const { logError } = require("../utils/logError");
const { parseListParams, buildPagination, pickSort } = require("../utils/listQuery");

const isUniqueViolation = (error) => error?.code === "23505";

const trimOrNull = (v) => {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
};

const createTableType = async (req, res) => {
  const { name, description, is_active } = req.body || {};
  const nm = String(name || "").trim();
  if (!nm) return res.status(400).json({ message: "Name is required." });

  try {
    const inserted = await req.tenantDB.query(
      `
      INSERT INTO table_types (id, name, description, is_active)
      VALUES ($1, $2, $3, $4)
      RETURNING id, name, description, is_active, created_at, updated_at
      `,
      [randomUUID(), nm, trimOrNull(description), is_active === undefined ? true : Boolean(is_active)]
    );
    return res.status(201).json({ message: "Table type created.", data: inserted.rows[0] });
  } catch (error) {
    if (isUniqueViolation(error)) {
      return res.status(409).json({ message: "Table type already exists." });
    }
    logError("POST /api/table-types", error);
    return res.status(500).json({ message: "Failed to create table type." });
  }
};

const listTableTypes = async (req, res) => {
  try {
    const params = parseListParams(req.query, { defaultSortBy: "created_at", defaultOrder: "DESC" });
    const { sortBy, order } = pickSort(params, ["created_at", "name"], "created_at");

    const where = params.search ? "WHERE name ILIKE $1" : "";
    const countArgs = params.search ? [`%${params.search}%`] : [];

    const totalResult = await req.tenantDB.query(
      `SELECT COUNT(*)::int AS total FROM table_types ${where}`,
      countArgs
    );
    const total = totalResult.rows[0]?.total ?? 0;

    const dataArgs = params.search
      ? [`%${params.search}%`, params.limit, params.offset]
      : [params.limit, params.offset];

    const result = await req.tenantDB.query(
      `
      SELECT id, name, description, is_active, created_at, updated_at
      FROM table_types
      ${where}
      ORDER BY ${sortBy} ${order}
      LIMIT $${params.search ? 2 : 1} OFFSET $${params.search ? 3 : 2}
      `,
      dataArgs
    );

    return res.status(200).json({
      data: result.rows,
      pagination: buildPagination({ total, page: params.page, limit: params.limit }),
    });
  } catch (error) {
    logError("GET /api/table-types", error);
    return res.status(500).json({ message: "Failed to fetch table types." });
  }
};

const updateTableType = async (req, res) => {
  const { id } = req.params;
  const { name, description, is_active } = req.body || {};
  const nm = String(name || "").trim();
  if (!nm) return res.status(400).json({ message: "Name is required." });

  try {
    const existing = await req.tenantDB.query("SELECT id FROM table_types WHERE id = $1 LIMIT 1", [id]);
    if (existing.rowCount === 0) return res.status(404).json({ message: "Table type not found." });

    const updated = await req.tenantDB.query(
      `
      UPDATE table_types
      SET name = $1,
          description = $2,
          is_active = $3,
          updated_at = NOW()
      WHERE id = $4
      RETURNING id, name, description, is_active, created_at, updated_at
      `,
      [nm, trimOrNull(description), Boolean(is_active), id]
    );

    return res.status(200).json({ message: "Table type updated.", data: updated.rows[0] });
  } catch (error) {
    if (isUniqueViolation(error)) {
      return res.status(409).json({ message: "Table type already exists." });
    }
    logError("PUT /api/table-types/:id", error);
    return res.status(500).json({ message: "Failed to update table type." });
  }
};

const deleteTableType = async (req, res) => {
  const { id } = req.params;
  try {
    const existing = await req.tenantDB.query("SELECT id FROM table_types WHERE id = $1 LIMIT 1", [id]);
    if (existing.rowCount === 0) return res.status(404).json({ message: "Table type not found." });

    const used = await req.tenantDB.query("SELECT 1 FROM tables WHERE table_type_id = $1 LIMIT 1", [id]);
    if (used.rowCount > 0) {
      return res.status(400).json({ message: "Cannot delete table type, it is used by tables." });
    }

    await req.tenantDB.query("DELETE FROM table_types WHERE id = $1", [id]);
    return res.status(200).json({ message: "Table type deleted." });
  } catch (error) {
    logError("DELETE /api/table-types/:id", error);
    return res.status(500).json({ message: "Failed to delete table type." });
  }
};

module.exports = {
  createTableType,
  listTableTypes,
  updateTableType,
  deleteTableType,
};

