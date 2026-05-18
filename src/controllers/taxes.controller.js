const { randomUUID } = require("crypto");
const { logError } = require("../utils/logError");
const { parseListParams, buildPagination, pickSort } = require("../utils/listQuery");
const { isReservedTaxCode, isReservedTaxName } = require("../utils/taxComputation");

const RESTORED_MESSAGE = "This item already existed and has been restored";
const DEACTIVATED_IN_USE_MESSAGE = "This item is in use and has been deactivated instead";

const TAX_SELECT_FIELDS = `
  id, name, percentage, is_active,
  is_system, is_mandatory, is_default, tax_code,
  created_at, updated_at
`;

const toNonNegative = (value, label) => {
  const n = Number(value);
  if (Number.isNaN(n) || !Number.isFinite(n) || n < 0) {
    const err = new Error(`${label} must be >= 0.`);
    err.statusCode = 400;
    throw err;
  }
  return n;
};

const fetchTaxById = async (tenantDB, id) => {
  const q = await tenantDB.query(
    `
    SELECT ${TAX_SELECT_FIELDS}
    FROM taxes
    WHERE id = $1
    LIMIT 1
    `,
    [id]
  );
  return q.rows[0] || null;
};

const isSystemTaxRow = (row) => Boolean(row?.is_system) || Boolean(row?.is_mandatory);

const createTax = async (req, res) => {
  const { name, percentage, is_active, tax_code } = req.body || {};
  const taxName = String(name || "").trim();
  if (!taxName) return res.status(400).json({ message: "name is required." });

  const requestedCode = String(tax_code || "").trim().toUpperCase();
  if (isReservedTaxCode(requestedCode) || isReservedTaxName(taxName)) {
    return res.status(400).json({ message: "CGST and SGST are system taxes and cannot be created manually." });
  }

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
      SELECT id, is_system, is_mandatory
      FROM taxes
      WHERE LOWER(name) = LOWER($1)
        AND COALESCE(is_active, TRUE) = FALSE
      LIMIT 1
      `,
      [taxName]
    );
    if (inactiveExisting.rowCount > 0) {
      if (isSystemTaxRow(inactiveExisting.rows[0])) {
        return res.status(400).json({ message: "System taxes cannot be recreated or restored manually." });
      }
      const restored = await req.tenantDB.query(
        `
        UPDATE taxes
        SET name = $1,
            percentage = $2,
            is_active = $3,
            updated_at = NOW()
        WHERE id = $4
        RETURNING ${TAX_SELECT_FIELDS}
        `,
        [taxName, pct, active, inactiveExisting.rows[0].id]
      );
      return res.status(200).json({ message: RESTORED_MESSAGE, data: restored.rows[0] });
    }

    const out = await req.tenantDB.query(
      `
      INSERT INTO taxes (id, name, percentage, is_active, created_at, updated_at)
      VALUES ($1, $2, $3, $4, NOW(), NOW())
      RETURNING ${TAX_SELECT_FIELDS}
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
    const { sortBy, order } = pickSort(params, ["created_at", "name", "percentage", "tax_code"], "created_at");
    const active = String(req.query?.active || "").trim().toLowerCase();
    const whereParts = [];
    const args = [];
    if (params.search) {
      args.push(`%${params.search}%`);
      whereParts.push(`(name ILIKE $${args.length} OR tax_code ILIKE $${args.length})`);
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
      SELECT ${TAX_SELECT_FIELDS},
        CASE
          WHEN COALESCE(is_system, FALSE) = TRUE OR COALESCE(is_mandatory, FALSE) = TRUE THEN FALSE
          WHEN NOT EXISTS (
            SELECT 1
            FROM orders o
            WHERE o.selected_tax_ids @> to_jsonb(ARRAY[taxes.id::text]::text[])
            LIMIT 1
          ) THEN TRUE
          ELSE FALSE
        END AS can_delete
      FROM taxes
      ${where}
      ORDER BY
        CASE WHEN COALESCE(is_system, FALSE) THEN 0 ELSE 1 END,
        CASE UPPER(COALESCE(tax_code, ''))
          WHEN 'CGST' THEN 1
          WHEN 'SGST' THEN 2
          ELSE 99
        END,
        ${sortBy} ${order}
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
  const { name, percentage, is_active, tax_code, is_system, is_mandatory, is_default } = req.body || {};

  try {
    const existing = await fetchTaxById(req.tenantDB, id);
    if (!existing) return res.status(404).json({ message: "Tax not found." });

    if (isSystemTaxRow(existing)) {
      const blocked = [];
      if (name !== undefined) blocked.push("name");
      if (is_active !== undefined) blocked.push("is_active");
      if (tax_code !== undefined) blocked.push("tax_code");
      if (is_system !== undefined) blocked.push("is_system");
      if (is_mandatory !== undefined) blocked.push("is_mandatory");
      if (is_default !== undefined) blocked.push("is_default");
      if (blocked.length > 0) {
        return res.status(400).json({
          message: `System taxes (CGST/SGST): cannot change ${blocked.join(", ")}. Only percentage can be updated.`,
        });
      }
      if (percentage === undefined) {
        return res.status(400).json({ message: "No fields to update." });
      }

      let pct;
      try {
        pct = toNonNegative(percentage, "percentage");
      } catch (e) {
        return res.status(e.statusCode || 400).json({ message: e.message });
      }

      const out = await req.tenantDB.query(
        `
        UPDATE taxes
        SET percentage = $1, updated_at = NOW()
        WHERE id = $2
        RETURNING ${TAX_SELECT_FIELDS}
        `,
        [pct, id]
      );
      return res.status(200).json({ message: "System tax rate updated.", data: out.rows[0] });
    }

    if (name !== undefined && isReservedTaxName(name)) {
      return res.status(400).json({ message: "Reserved tax names (CGST/SGST) cannot be used." });
    }
    if (tax_code !== undefined && isReservedTaxCode(tax_code)) {
      return res.status(400).json({ message: "Reserved tax codes (CGST/SGST) cannot be used." });
    }

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
    if (tax_code !== undefined) {
      const code = String(tax_code || "").trim();
      args.push(code || null);
      updates.push(`tax_code = $${args.length}`);
    }
    if (updates.length === 0) return res.status(400).json({ message: "No fields to update." });

    args.push(id);
    const out = await req.tenantDB.query(
      `
      UPDATE taxes
      SET ${updates.join(", ")}, updated_at = NOW()
      WHERE id = $${args.length}
      RETURNING ${TAX_SELECT_FIELDS}
      `,
      args
    );
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
    const existing = await fetchTaxById(req.tenantDB, id);
    if (!existing) return res.status(404).json({ message: "Tax not found." });
    if (isSystemTaxRow(existing)) {
      return res.status(403).json({ message: "System taxes (CGST/SGST) cannot be deleted or disabled." });
    }

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
