const { randomUUID } = require("crypto");
const { logError } = require("../utils/logError");
const { parseListParams, buildPagination, pickSort } = require("../utils/listQuery");

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

module.exports = { createTax, listTaxes, updateTax };

