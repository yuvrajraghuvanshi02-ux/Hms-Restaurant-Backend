const { randomUUID } = require("crypto");
const { logError } = require("../utils/logError");
const { parseListParams, buildPagination, pickSort } = require("../utils/listQuery");

const isUniqueViolation = (error) => error?.code === "23505";
const RESTORED_MESSAGE = "This item already existed and has been restored";
const DEACTIVATED_IN_USE_MESSAGE = "This item is in use and has been deactivated instead";

const toCapacity = (value) => {
  const n = Number.parseInt(String(value ?? ""), 10);
  if (Number.isNaN(n) || n < 1) {
    const err = new Error("Capacity must be at least 1.");
    err.statusCode = 400;
    throw err;
  }
  return n;
};

const createTable = async (req, res) => {
  const { name, table_type_id, capacity, is_active } = req.body || {};
  const nm = String(name || "").trim();
  const typeId = String(table_type_id || "").trim();
  if (!nm) return res.status(400).json({ message: "Name is required." });
  if (!typeId) return res.status(400).json({ message: "table_type_id is required." });

  let cap = 1;
  try {
    cap = capacity === undefined ? 1 : toCapacity(capacity);
  } catch (e) {
    return res.status(e.statusCode || 400).json({ message: e.message });
  }

  try {
    const type = await req.tenantDB.query("SELECT id FROM table_types WHERE id = $1 LIMIT 1", [typeId]);
    if (type.rowCount === 0) return res.status(400).json({ message: "Selected table type does not exist." });

    const activeExisting = await req.tenantDB.query(
      `
      SELECT id
      FROM tables
      WHERE LOWER(BTRIM(name::text)) = LOWER(BTRIM($1::text))
        AND COALESCE(is_active, TRUE) = TRUE
      LIMIT 1
      `,
      [nm]
    );
    if (activeExisting.rowCount > 0) {
      return res.status(409).json({ message: "Table name already exists." });
    }

    const inactiveExisting = await req.tenantDB.query(
      `
      SELECT id
      FROM tables
      WHERE LOWER(BTRIM(name::text)) = LOWER(BTRIM($1::text))
        AND COALESCE(is_active, TRUE) = FALSE
      LIMIT 1
      `,
      [nm]
    );
    if (inactiveExisting.rowCount > 0) {
      const restored = await req.tenantDB.query(
        `
        UPDATE tables
        SET name = $1,
            table_type_id = $2,
            capacity = $3,
            is_active = TRUE,
            updated_at = NOW()
        WHERE id = $4
        RETURNING id, name, table_type_id, capacity, is_active, created_at, updated_at
        `,
        [nm, typeId, cap, inactiveExisting.rows[0].id]
      );
      return res.status(200).json({ message: RESTORED_MESSAGE, data: restored.rows[0] });
    }

    const inserted = await req.tenantDB.query(
      `
      INSERT INTO tables (id, name, table_type_id, capacity, is_active)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, name, table_type_id, capacity, is_active, created_at, updated_at
      `,
      [randomUUID(), nm, typeId, cap, is_active === undefined ? true : Boolean(is_active)]
    );
    return res.status(201).json({ message: "Table created.", data: inserted.rows[0] });
  } catch (error) {
    if (isUniqueViolation(error)) return res.status(409).json({ message: "Table name already exists." });
    logError("POST /api/tables", error);
    return res.status(500).json({ message: "Failed to create table." });
  }
};

const listTables = async (req, res) => {
  try {
    const params = parseListParams(req.query, { defaultSortBy: "created_at", defaultOrder: "DESC" });
    const { sortBy, order } = pickSort(params, ["created_at", "name", "capacity"], "created_at");
    const active = String(req.query?.active || "").trim().toLowerCase();
    const whereParts = [];
    const args = [];
    if (params.search) {
      args.push(`%${params.search}%`);
      whereParts.push(`(t.name ILIKE $${args.length} OR tt.name ILIKE $${args.length})`);
    }
    if (active === "true" || active === "false") {
      args.push(active === "true");
      whereParts.push(`t.is_active = $${args.length}`);
    }
    const where = whereParts.length ? `WHERE ${whereParts.join(" AND ")}` : "";

    const totalResult = await req.tenantDB.query(
      `
      SELECT COUNT(*)::int AS total
      FROM tables t
      JOIN table_types tt ON tt.id = t.table_type_id
      ${where}
      `,
      args
    );
    const total = totalResult.rows[0]?.total ?? 0;

    const dataArgs = [...args, params.limit, params.offset];
    const limitIdx = dataArgs.length - 1;
    const offsetIdx = dataArgs.length;

    const result = await req.tenantDB.query(
      `
      SELECT
        t.id,
        t.name,
        t.capacity,
        t.is_active,
        t.created_at,
        t.updated_at,
        t.table_type_id,
        tt.name AS table_type_name,
        NOT EXISTS (
          SELECT 1
          FROM orders o2
          WHERE o2.table_id = t.id
          LIMIT 1
        ) AS can_delete
      FROM tables t
      JOIN table_types tt ON tt.id = t.table_type_id
      ${where}
      ORDER BY t.${sortBy} ${order}
      LIMIT $${limitIdx} OFFSET $${offsetIdx}
      `,
      dataArgs
    );

    return res.status(200).json({
      data: result.rows,
      pagination: buildPagination({ total, page: params.page, limit: params.limit }),
    });
  } catch (error) {
    logError("GET /api/tables", error);
    return res.status(500).json({ message: "Failed to fetch tables." });
  }
};

const getTable = async (req, res) => {
  const { id } = req.params;
  try {
    const result = await req.tenantDB.query(
      `
      SELECT
        t.id,
        t.name,
        t.capacity,
        t.is_active,
        t.created_at,
        t.updated_at,
        t.table_type_id,
        tt.name AS table_type_name
      FROM tables t
      JOIN table_types tt ON tt.id = t.table_type_id
      WHERE t.id = $1
      LIMIT 1
      `,
      [id]
    );
    if (result.rowCount === 0) return res.status(404).json({ message: "Table not found." });
    return res.status(200).json({ data: result.rows[0] });
  } catch (error) {
    logError("GET /api/tables/:id", error);
    return res.status(500).json({ message: "Failed to fetch table." });
  }
};

const updateTable = async (req, res) => {
  const { id } = req.params;
  const { name, table_type_id, capacity, is_active } = req.body || {};
  const nm = String(name || "").trim();
  const typeId = String(table_type_id || "").trim();
  if (!nm) return res.status(400).json({ message: "Name is required." });
  if (!typeId) return res.status(400).json({ message: "table_type_id is required." });

  let cap = 1;
  try {
    cap = capacity === undefined ? 1 : toCapacity(capacity);
  } catch (e) {
    return res.status(e.statusCode || 400).json({ message: e.message });
  }

  try {
    const existing = await req.tenantDB.query("SELECT id FROM tables WHERE id = $1 LIMIT 1", [id]);
    if (existing.rowCount === 0) return res.status(404).json({ message: "Table not found." });

    const type = await req.tenantDB.query("SELECT id FROM table_types WHERE id = $1 LIMIT 1", [typeId]);
    if (type.rowCount === 0) return res.status(400).json({ message: "Selected table type does not exist." });

    const updated = await req.tenantDB.query(
      `
      UPDATE tables
      SET name = $1,
          table_type_id = $2,
          capacity = $3,
          is_active = $4,
          updated_at = NOW()
      WHERE id = $5
      RETURNING id, name, table_type_id, capacity, is_active, created_at, updated_at
      `,
      [nm, typeId, cap, Boolean(is_active), id]
    );
    return res.status(200).json({ message: "Table updated.", data: updated.rows[0] });
  } catch (error) {
    if (isUniqueViolation(error)) return res.status(409).json({ message: "Table name already exists." });
    logError("PUT /api/tables/:id", error);
    return res.status(500).json({ message: "Failed to update table." });
  }
};

const deleteTable = async (req, res) => {
  const { id } = req.params;
  try {
    const existing = await req.tenantDB.query("SELECT id FROM tables WHERE id = $1 LIMIT 1", [id]);
    if (existing.rowCount === 0) return res.status(404).json({ message: "Table not found." });

    const used = await req.tenantDB.query("SELECT 1 FROM orders WHERE table_id = $1 LIMIT 1", [id]);
    if (used.rowCount > 0) {
      await req.tenantDB.query(
        `
        UPDATE tables
        SET is_active = FALSE,
            updated_at = NOW()
        WHERE id = $1
        `,
        [id]
      );
      return res.status(200).json({ message: DEACTIVATED_IN_USE_MESSAGE });
    }

    await req.tenantDB.query("DELETE FROM tables WHERE id = $1", [id]);
    return res.status(200).json({ message: "Table deleted." });
  } catch (error) {
    logError("DELETE /api/tables/:id", error);
    return res.status(500).json({ message: "Failed to delete table." });
  }
};

const listTablesWithStatus = async (req, res) => {
  try {
    const result = await req.tenantDB.query(
      `
      SELECT
        t.id AS table_id,
        t.name AS table_name,
        tt.name AS table_type,
        t.capacity,
        t.is_active,
        CASE
          WHEN COALESCE(t.is_active, TRUE) = FALSE THEN 'inactive'
          WHEN EXISTS (
            SELECT 1
            FROM orders o
            WHERE o.table_id = t.id
              AND o.status NOT IN ('completed', 'cancelled')
            LIMIT 1
          ) THEN 'occupied'
          ELSE 'available'
        END AS status
      FROM tables t
      JOIN table_types tt ON tt.id = t.table_type_id
      ORDER BY tt.name ASC, t.name ASC
      `
    );

    return res.status(200).json({ data: result.rows || [] });
  } catch (error) {
    logError("GET /api/tables/with-status", error);
    return res.status(500).json({ message: "Failed to fetch tables with status." });
  }
};

module.exports = {
  createTable,
  listTables,
  listTablesWithStatus,
  getTable,
  updateTable,
  deleteTable,
};

