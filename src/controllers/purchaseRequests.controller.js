const { randomUUID } = require("crypto");
const { logError } = require("../utils/logError");
const { parseListParams, buildPagination, pickSort } = require("../utils/listQuery");

const isUniqueViolation = (error) => error?.code === "23505";

const ensureUuid = (value, label) => {
  const v = String(value || "").trim();
  if (!v) {
    const err = new Error(`${label} is required.`);
    err.statusCode = 400;
    throw err;
  }
  return v;
};

const toPositiveNumber = (value, label) => {
  const n = Number(value);
  if (Number.isNaN(n) || !Number.isFinite(n) || n <= 0) {
    const err = new Error(`${label} must be greater than 0.`);
    err.statusCode = 400;
    throw err;
  }
  return n;
};

const withTenantTx = async (tenantPool, fn) => {
  const client = await tenantPool.connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {}
    throw error;
  } finally {
    client.release();
  }
};

const nextRequestNumber = async (client) => {
  // Prevent concurrent duplicate PR-XXXX generation.
  await client.query("LOCK TABLE purchase_requests IN EXCLUSIVE MODE");

  const maxRow = await client.query(
    `
    SELECT COALESCE(MAX(NULLIF(regexp_replace(request_number, '^PR-', ''), '')::int), 0) AS max_no
    FROM purchase_requests
    `
  );
  const maxNo = Number(maxRow.rows[0]?.max_no || 0);
  const nextNo = maxNo + 1;
  return `PR-${String(nextNo).padStart(4, "0")}`;
};

const ensurePendingRequestForUpdate = async (client, id) => {
  const current = await client.query(
    "SELECT id, status FROM purchase_requests WHERE id = $1 LIMIT 1 FOR UPDATE",
    [id]
  );
  if (current.rowCount === 0) {
    const err = new Error("Purchase request not found.");
    err.statusCode = 404;
    throw err;
  }
  if (current.rows[0].status !== "pending") {
    const err = new Error("Only pending requests can be updated.");
    err.statusCode = 400;
    throw err;
  }
  return current.rows[0];
};

const createPurchaseRequest = async (req, res) => {
  const { supplier_id, remarks, items } = req.body || {};

  let supplierId;
  try {
    supplierId = ensureUuid(supplier_id, "supplier_id");
  } catch (e) {
    return res.status(e.statusCode || 400).json({ message: e.message });
  }

  const rows = Array.isArray(items) ? items : [];
  if (rows.length === 0) {
    return res.status(400).json({ message: "At least 1 item is required." });
  }

  // normalize + validate basic fields + no duplicates
  let normalized;
  try {
    const seen = new Set();
    normalized = rows.map((it, idx) => {
      const rawId = ensureUuid(it?.raw_material_id, `items[${idx}].raw_material_id`);
      if (seen.has(rawId)) {
        const err = new Error("No duplicate raw_material_id is allowed in a request.");
        err.statusCode = 400;
        throw err;
      }
      seen.add(rawId);
      return {
        raw_material_id: rawId,
        quantity: toPositiveNumber(it?.quantity, `items[${idx}].quantity`),
        unit_id: ensureUuid(it?.unit_id, `items[${idx}].unit_id`),
      };
    });
  } catch (e) {
    return res.status(e.statusCode || 400).json({ message: e.message });
  }

  try {
    const created = await withTenantTx(req.tenantDB, async (client) => {
      const sup = await client.query("SELECT id, name FROM suppliers WHERE id = $1 LIMIT 1", [
        supplierId,
      ]);
      if (sup.rowCount === 0) {
        const err = new Error("Selected supplier does not exist.");
        err.statusCode = 400;
        throw err;
      }

      const rawIds = normalized.map((x) => x.raw_material_id);
      const rm = await client.query(
        `
        SELECT id, name, purchase_unit_id
        FROM raw_materials
        WHERE id = ANY($1::uuid[])
        `,
        [rawIds]
      );
      const byId = new Map(rm.rows.map((r) => [r.id, r]));
      for (const it of normalized) {
        const material = byId.get(it.raw_material_id);
        if (!material) {
          const err = new Error("One or more raw materials do not exist.");
          err.statusCode = 400;
          throw err;
        }
        const allowedUnitId = material.purchase_unit_id;
        if (!allowedUnitId || allowedUnitId !== it.unit_id) {
          const err = new Error(
            `Purchase unit mismatch for ${material.name}. Use the configured purchase unit.`
          );
          err.statusCode = 400;
          throw err;
        }
      }

      // Validate units exist (even though mismatch check above usually catches it).
      const unitIds = Array.from(new Set(normalized.map((x) => x.unit_id)));
      const units = await client.query("SELECT id FROM units WHERE id = ANY($1::uuid[])", [unitIds]);
      if (units.rowCount !== unitIds.length) {
        const err = new Error("One or more units do not exist.");
        err.statusCode = 400;
        throw err;
      }

      const requestNumber = await nextRequestNumber(client);

      const requestId = randomUUID();
      const createdBy = req.user?.id ? String(req.user.id).trim() : null;
      const remarksText = remarks === undefined || remarks === null ? null : String(remarks).trim();

      const inserted = await client.query(
        `
        INSERT INTO purchase_requests (
          id, supplier_id, request_number, status, remarks, created_by
        )
        VALUES ($1, $2, $3, 'pending', $4, $5)
        RETURNING id, supplier_id, request_number, status, remarks, created_by, created_at, updated_at
        `,
        [requestId, supplierId, requestNumber, remarksText || null, createdBy]
      );

      for (const it of normalized) {
        await client.query(
          `
          INSERT INTO purchase_request_items (
            id, purchase_request_id, raw_material_id, quantity, unit_id
          )
          VALUES ($1, $2, $3, $4, $5)
          `,
          [randomUUID(), requestId, it.raw_material_id, it.quantity, it.unit_id]
        );
      }

      return { request: inserted.rows[0], supplier: sup.rows[0] };
    });

    return res.status(201).json({
      message: "Purchase request created.",
      data: created.request,
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      return res.status(409).json({ message: "Request number already exists. Please retry." });
    }
    logError("POST /api/purchase-requests", error);
    return res.status(error.statusCode || 500).json({
      message: error?.message || "Failed to create purchase request.",
    });
  }
};

const listPurchaseRequests = async (req, res) => {
  try {
    const params = parseListParams(req.query, { defaultSortBy: "created_at", defaultOrder: "DESC" });
    const { sortBy, order } = pickSort(params, ["created_at", "request_number", "status"], "created_at");

    const hasSearch = Boolean(params.search);
    const where = hasSearch ? "WHERE pr.request_number ILIKE $1 OR s.name ILIKE $1" : "";
    const countArgs = hasSearch ? [`%${params.search}%`] : [];

    const totalResult = await req.tenantDB.query(
      `
      SELECT COUNT(*)::int AS total
      FROM purchase_requests pr
      JOIN suppliers s ON s.id = pr.supplier_id
      ${where}
      `,
      countArgs
    );
    const total = totalResult.rows[0]?.total ?? 0;

    const dataArgs = hasSearch
      ? [`%${params.search}%`, params.limit, params.offset]
      : [params.limit, params.offset];

    const result = await req.tenantDB.query(
      `
      SELECT
        pr.id,
        pr.request_number,
        pr.status,
        pr.remarks,
        pr.created_at,
        pr.updated_at,
        pr.supplier_id,
        s.name AS supplier_name,
        COALESCE(ic.total_items, 0)::int AS total_items
      FROM purchase_requests pr
      JOIN suppliers s ON s.id = pr.supplier_id
      LEFT JOIN (
        SELECT purchase_request_id, COUNT(*) AS total_items
        FROM purchase_request_items
        GROUP BY purchase_request_id
      ) ic ON ic.purchase_request_id = pr.id
      ${where}
      ORDER BY pr.${sortBy} ${order}
      LIMIT $${hasSearch ? 2 : 1} OFFSET $${hasSearch ? 3 : 2}
      `,
      dataArgs
    );

    return res.status(200).json({
      data: result.rows,
      pagination: buildPagination({ total, page: params.page, limit: params.limit }),
    });
  } catch (error) {
    logError("GET /api/purchase-requests", error);
    return res.status(500).json({ message: "Failed to fetch purchase requests." });
  }
};

const listPendingPurchaseRequestsForApproval = async (req, res) => {
  try {
    const params = parseListParams(req.query, { defaultSortBy: "created_at", defaultOrder: "DESC" });
    const { sortBy, order } = pickSort(params, ["created_at", "request_number"], "created_at");

    const hasSearch = Boolean(params.search);
    const whereSearch = hasSearch ? "AND (pr.request_number ILIKE $1 OR s.name ILIKE $1)" : "";
    const countArgs = hasSearch ? [`%${params.search}%`] : [];

    const totalResult = await req.tenantDB.query(
      `
      SELECT COUNT(*)::int AS total
      FROM purchase_requests pr
      JOIN suppliers s ON s.id = pr.supplier_id
      WHERE pr.status = 'pending'
      ${whereSearch}
      `,
      countArgs
    );
    const total = totalResult.rows[0]?.total ?? 0;

    const dataArgs = hasSearch
      ? [`%${params.search}%`, params.limit, params.offset]
      : [params.limit, params.offset];

    const result = await req.tenantDB.query(
      `
      SELECT
        pr.id,
        pr.request_number,
        pr.created_at,
        pr.supplier_id,
        s.name AS supplier_name,
        COALESCE(ic.total_items, 0)::int AS total_items
      FROM purchase_requests pr
      JOIN suppliers s ON s.id = pr.supplier_id
      LEFT JOIN (
        SELECT purchase_request_id, COUNT(*) AS total_items
        FROM purchase_request_items
        GROUP BY purchase_request_id
      ) ic ON ic.purchase_request_id = pr.id
      WHERE pr.status = 'pending'
      ${whereSearch}
      ORDER BY pr.${sortBy} ${order}
      LIMIT $${hasSearch ? 2 : 1} OFFSET $${hasSearch ? 3 : 2}
      `,
      dataArgs
    );

    return res.status(200).json({
      data: result.rows,
      pagination: buildPagination({ total, page: params.page, limit: params.limit }),
    });
  } catch (error) {
    logError("GET /api/purchase-requests/approval", error);
    return res.status(500).json({ message: "Failed to fetch approval list." });
  }
};

const getPurchaseRequest = async (req, res) => {
  const { id } = req.params;
  try {
    const pr = await req.tenantDB.query(
      `
      SELECT
        pr.id,
        pr.request_number,
        pr.status,
        pr.remarks,
        pr.created_by,
        pr.created_at,
        pr.updated_at,
        pr.supplier_id,
        s.name AS supplier_name
      FROM purchase_requests pr
      JOIN suppliers s ON s.id = pr.supplier_id
      WHERE pr.id = $1
      LIMIT 1
      `,
      [id]
    );
    if (pr.rowCount === 0) return res.status(404).json({ message: "Purchase request not found." });

    const items = await req.tenantDB.query(
      `
      SELECT
        pri.id,
        pri.raw_material_id,
        rm.name AS raw_material_name,
        pri.quantity,
        pri.unit_id,
        u.name AS unit_name,
        u.short_name AS unit_short_name
      FROM purchase_request_items pri
      JOIN raw_materials rm ON rm.id = pri.raw_material_id
      JOIN units u ON u.id = pri.unit_id
      WHERE pri.purchase_request_id = $1
      ORDER BY rm.name ASC
      `,
      [id]
    );

    return res.status(200).json({
      data: {
        ...pr.rows[0],
        items: items.rows,
      },
    });
  } catch (error) {
    logError("GET /api/purchase-requests/:id", error);
    return res.status(500).json({ message: "Failed to fetch purchase request." });
  }
};

const updatePurchaseRequestStatus = async (req, res) => {
  const { id } = req.params;
  const status = String(req.body?.status || "").trim().toLowerCase();
  if (!["approved", "rejected"].includes(status)) {
    return res.status(400).json({ message: 'status must be "approved" or "rejected".' });
  }

  try {
    const updated = await withTenantTx(req.tenantDB, async (client) => {
      await ensurePendingRequestForUpdate(client, id);

      const out = await client.query(
        `
        UPDATE purchase_requests
        SET status = $1,
            updated_at = NOW()
        WHERE id = $2
        RETURNING id, request_number, status, updated_at
        `,
        [status, id]
      );
      return out.rows[0];
    });

    return res.status(200).json({ message: "Status updated.", data: updated });
  } catch (error) {
    logError("PUT /api/purchase-requests/:id/status", error);
    return res.status(error.statusCode || 500).json({
      message: error?.message || "Failed to update status.",
    });
  }
};

const approvePurchaseRequest = async (req, res) => {
  const { id } = req.params;
  try {
    const updated = await withTenantTx(req.tenantDB, async (client) => {
      await ensurePendingRequestForUpdate(client, id);
      const out = await client.query(
        `
        UPDATE purchase_requests
        SET status = 'approved',
            updated_at = NOW()
        WHERE id = $1
        RETURNING id, request_number, status, updated_at
        `,
        [id]
      );
      return out.rows[0];
    });
    return res.status(200).json({ message: "Purchase request approved.", data: updated });
  } catch (error) {
    logError("PUT /api/purchase-requests/:id/approve", error);
    return res.status(error.statusCode || 500).json({
      message: error?.message || "Failed to approve purchase request.",
    });
  }
};

const rejectPurchaseRequest = async (req, res) => {
  const { id } = req.params;
  try {
    const updated = await withTenantTx(req.tenantDB, async (client) => {
      await ensurePendingRequestForUpdate(client, id);
      const out = await client.query(
        `
        UPDATE purchase_requests
        SET status = 'rejected',
            updated_at = NOW()
        WHERE id = $1
        RETURNING id, request_number, status, updated_at
        `,
        [id]
      );
      return out.rows[0];
    });
    return res.status(200).json({ message: "Purchase request rejected.", data: updated });
  } catch (error) {
    logError("PUT /api/purchase-requests/:id/reject", error);
    return res.status(error.statusCode || 500).json({
      message: error?.message || "Failed to reject purchase request.",
    });
  }
};

module.exports = {
  createPurchaseRequest,
  listPurchaseRequests,
  listPendingPurchaseRequestsForApproval,
  getPurchaseRequest,
  updatePurchaseRequestStatus,
  approvePurchaseRequest,
  rejectPurchaseRequest,
};

