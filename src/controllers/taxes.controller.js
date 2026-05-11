const { randomUUID } = require("crypto");
const { logError } = require("../utils/logError");
const { parseListParams, buildPagination, pickSort } = require("../utils/listQuery");
const RESTORED_MESSAGE = "This item already existed and has been restored";
const DEACTIVATED_IN_USE_MESSAGE = "This item is in use and has been deactivated instead";

const toNonNegative = (value, label) => {
  const n = Number(value);
  if (Number.isNaN(n) || !Number.isFinite(n) || n < 0) {
    const err = new Error(`${label} must be >= 0.`);
    err.statusCode = 400;
    throw err;
  }
  return n;
};

const createTax = async (req, res) => {
  const { name, percentage, is_active } = req.body || {};
  const taxName = String(name || "").trim();
  if (!taxName) return res.status(400).json({ message: "name is required." });

  try {
    const pct = toNonNegative(percentage, "percentage");
    const active = is_active === undefined ? true : Boolean(is_active);

    const activeExisting = await req.tenantDB.query(
      `
      SELECT id
      FROM taxes
      WHERE LOWER(name) = LOWER($1)
        AND COALESCE(is_active, TRUE) = TRUE
      LIMIT 1
      `,
      [taxName]
    );
    if (activeExisting.rowCount > 0) {
      return res.status(409).json({ message: "Tax name already exists." });
    }

    const inactiveExisting = await req.tenantDB.query(
      `
      SELECT id
      FROM taxes
      WHERE LOWER(name) = LOWER($1)
        AND COALESCE(is_active, TRUE) = FALSE
      LIMIT 1
      `,
      [taxName]
    );
    if (inactiveExisting.rowCount > 0) {
      const restored = await req.tenantDB.query(
        `
        UPDATE taxes
        SET name = $1,
            percentage = $2,
            is_active = $3,
            updated_at = NOW()
        WHERE id = $4
        RETURNING id, name, percentage, is_active, created_at, updated_at
        `,
        [taxName, pct, active, inactiveExisting.rows[0].id]
      );
      return res.status(200).json({ message: RESTORED_MESSAGE, data: restored.rows[0] });
    }

    const out = await req.tenantDB.query(
      `
      INSERT INTO taxes (id, name, percentage, is_active, created_at, updated_at)
      VALUES ($1, $2, $3, $4, NOW(), NOW())
      RETURNING id, name, percentage, is_active, created_at, updated_at
      `,
      [randomUUID(), taxName, pct, active]
    );
    return res.status(201).json({ message: "Tax created.", data: out.rows[0] });
  } catch (error) {
    logError("POST /api/taxes", error);
    if (error?.code === "23505") return res.status(409).json({ message: "Tax name already exists." });
    return res.status(error.statusCode || 500).json({ message: error?.message || "Failed to create tax." });
  }
};

const listTaxes = async (req, res) => {
  try {
    const params = parseListParams(req.query, { defaultSortBy: "created_at", defaultOrder: "DESC" });
    const { sortBy, order } = pickSort(params, ["created_at", "name", "percentage"], "created_at");
    const active = String(req.query?.active || "").trim().toLowerCase();
    const whereParts = [];
    const args = [];
    if (params.search) {
      args.push(`%${params.search}%`);
      whereParts.push(`name ILIKE $${args.length}`);
    }
    if (active === "true" || active === "false") {
      args.push(active === "true");
      whereParts.push(`is_active = $${args.length}`);
    }
    const where = whereParts.length ? `WHERE ${whereParts.join(" AND ")}` : "";

    const countQ = await req.tenantDB.query(`SELECT COUNT(*)::int AS total FROM taxes ${where}`, args);
    const total = countQ.rows[0]?.total ?? 0;

    const dataArgs = [...args, params.limit, params.offset];
    const limitIdx = dataArgs.length - 1;
    const offsetIdx = dataArgs.length;
    const dataQ = await req.tenantDB.query(
      `
      SELECT id, name, percentage, is_active, created_at, updated_at
      , NOT EXISTS (
          SELECT 1
          FROM orders o
          WHERE o.selected_tax_ids @> to_jsonb(ARRAY[taxes.id::text]::text[])
          LIMIT 1
        ) AS can_delete
      FROM taxes
      ${where}
      ORDER BY ${sortBy} ${order}
      LIMIT $${limitIdx} OFFSET $${offsetIdx}
      `,
      dataArgs
    );

    return res.status(200).json({
      data: dataQ.rows || [],
      pagination: buildPagination({ total, page: params.page, limit: params.limit }),
    });
  } catch (error) {
    logError("GET /api/taxes", error);
    return res.status(500).json({ message: "Failed to fetch taxes." });
  }
};

const updateTax = async (req, res) => {
  const { id } = req.params;
  const { name, percentage, is_active } = req.body || {};
  const updates = [];
  const args = [];

  if (name !== undefined) {
    const taxName = String(name || "").trim();
    if (!taxName) return res.status(400).json({ message: "name cannot be empty." });
    args.push(taxName);
    updates.push(`name = $${args.length}`);
  }
  if (percentage !== undefined) {
    try {
      args.push(toNonNegative(percentage, "percentage"));
    } catch (e) {
      return res.status(e.statusCode || 400).json({ message: e.message });
    }
    updates.push(`percentage = $${args.length}`);
  }
  if (is_active !== undefined) {
    args.push(Boolean(is_active));
    updates.push(`is_active = $${args.length}`);
  }
  if (updates.length === 0) return res.status(400).json({ message: "No fields to update." });

  try {
    args.push(id);
    const out = await req.tenantDB.query(
      `
      UPDATE taxes
      SET ${updates.join(", ")}, updated_at = NOW()
      WHERE id = $${args.length}
      RETURNING id, name, percentage, is_active, created_at, updated_at
      `,
      args
    );
    if (out.rowCount === 0) return res.status(404).json({ message: "Tax not found." });
    return res.status(200).json({ message: "Tax updated.", data: out.rows[0] });
  } catch (error) {
    logError("PUT /api/taxes/:id", error);
    if (error?.code === "23505") return res.status(409).json({ message: "Tax name already exists." });
    return res.status(500).json({ message: error?.message || "Failed to update tax." });
  }
};

const deleteTax = async (req, res) => {
  const { id } = req.params;
  try {
    const exists = await req.tenantDB.query("SELECT id FROM taxes WHERE id = $1 LIMIT 1", [id]);
    if (exists.rowCount === 0) return res.status(404).json({ message: "Tax not found." });

    const usedInOrders = await req.tenantDB.query(
      `
      SELECT 1
      FROM orders
      WHERE selected_tax_ids @> to_jsonb(ARRAY[$1]::text[])
      LIMIT 1
      `,
      [id]
    );
    if (usedInOrders.rowCount > 0) {
      await req.tenantDB.query(
        `
        UPDATE taxes
        SET is_active = FALSE,
            updated_at = NOW()
        WHERE id = $1
        `,
        [id]
      );
      return res.status(200).json({ message: DEACTIVATED_IN_USE_MESSAGE });
    }

    await req.tenantDB.query("DELETE FROM taxes WHERE id = $1", [id]);
    return res.status(200).json({ message: "Tax deleted." });
  } catch (error) {
    logError("DELETE /api/taxes/:id", error);
    return res.status(500).json({ message: "Failed to delete tax." });
  }
};

module.exports = { createTax, listTaxes, updateTax, deleteTax };

