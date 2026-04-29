const { randomUUID } = require("crypto");
const { logError } = require("../utils/logError");
const { parseListParams, buildPagination, pickSort } = require("../utils/listQuery");

const isUniqueViolation = (error) => error?.code === "23505";

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

const nextPoNumber = async (client) => {
  await client.query("LOCK TABLE purchase_orders IN EXCLUSIVE MODE");
  const maxRow = await client.query(
    `
    SELECT COALESCE(MAX(NULLIF(regexp_replace(po_number, '^PO-', ''), '')::int), 0) AS max_no
    FROM purchase_orders
    `
  );
  const maxNo = Number(maxRow.rows[0]?.max_no || 0);
  const nextNo = maxNo + 1;
  return `PO-${String(nextNo).padStart(4, "0")}`;
};

const createPurchaseOrderFromPr = async (req, res) => {
  const prId = String(req.params?.prId || "").trim();
  if (!prId) return res.status(400).json({ message: "prId is required." });

  try {
    const created = await withTenantTx(req.tenantDB, async (client) => {
      const pr = await client.query(
        `
        SELECT id, supplier_id, request_number, status, remarks, is_po_created,
               purchase_total, gst_percentage, gst_amount, selected_tax_ids
        FROM purchase_requests
        WHERE id = $1
        LIMIT 1
        FOR UPDATE
        `,
        [prId]
      );
      if (pr.rowCount === 0) {
        const err = new Error("Purchase request not found.");
        err.statusCode = 404;
        throw err;
      }
      if (pr.rows[0].status !== "approved") {
        const err = new Error("PO can only be created from an approved purchase request.");
        err.statusCode = 400;
        throw err;
      }
      if (pr.rows[0].is_po_created) {
        const err = new Error("PO is already created for this purchase request.");
        err.statusCode = 409;
        throw err;
      }

      const existing = await client.query(
        "SELECT id, po_number FROM purchase_orders WHERE purchase_request_id = $1 LIMIT 1",
        [prId]
      );
      if (existing.rowCount > 0) {
        const err = new Error(`PO already exists for this PR (${existing.rows[0].po_number}).`);
        err.statusCode = 409;
        throw err;
      }

      const items = await client.query(
        `
        SELECT raw_material_id, quantity, unit_id
        FROM purchase_request_items
        WHERE purchase_request_id = $1
        `,
        [prId]
      );
      if (items.rowCount === 0) {
        const err = new Error("Cannot create PO: purchase request has no items.");
        err.statusCode = 400;
        throw err;
      }

      const poNumber = await nextPoNumber(client);
      const poId = randomUUID();

      const inserted = await client.query(
        `
        INSERT INTO purchase_orders (
          id, purchase_request_id, supplier_id, po_number, status, remarks,
          purchase_total, gst_percentage, gst_amount, selected_tax_ids
        )
        VALUES ($1, $2, $3, $4, 'created', $5, $6, $7, $8, $9::jsonb)
        RETURNING id, purchase_request_id, supplier_id, po_number, status, remarks,
                  purchase_total, gst_percentage, gst_amount, selected_tax_ids, created_at, updated_at
        `,
        [
          poId,
          prId,
          pr.rows[0].supplier_id,
          poNumber,
          pr.rows[0].remarks || null,
          Number(pr.rows[0].purchase_total || 0),
          Number(pr.rows[0].gst_percentage || 0),
          Number(pr.rows[0].gst_amount || 0),
          JSON.stringify(Array.isArray(pr.rows[0].selected_tax_ids) ? pr.rows[0].selected_tax_ids : []),
        ]
      );

      for (const it of items.rows) {
        await client.query(
          `
          INSERT INTO purchase_order_items (
            id, purchase_order_id, raw_material_id, ordered_quantity, received_quantity, unit_id
          )
          VALUES ($1, $2, $3, $4, 0, $5)
          `,
          [randomUUID(), poId, it.raw_material_id, it.quantity, it.unit_id]
        );
      }

      await client.query(
        `
        UPDATE purchase_requests
        SET is_po_created = true,
            updated_at = NOW()
        WHERE id = $1
        `,
        [prId]
      );

      const inputGstAmount = Number(pr.rows[0].gst_amount || 0);
      await client.query(
        `
        INSERT INTO gst_ledger (id, type, source, source_id, amount)
        VALUES ($1, 'input', 'purchase', $2, $3)
        ON CONFLICT (type, source, source_id)
        DO UPDATE SET amount = EXCLUDED.amount, updated_at = NOW()
        `,
        [randomUUID(), poId, inputGstAmount]
      );

      return inserted.rows[0];
    });

    return res.status(201).json({ message: "Purchase order created.", data: created });
  } catch (error) {
    if (isUniqueViolation(error)) {
      return res.status(409).json({ message: "PO number already exists. Please retry." });
    }
    logError("POST /api/purchase-orders/from-pr/:prId", error);
    return res.status(error.statusCode || 500).json({
      message: error?.message || "Failed to create purchase order.",
    });
  }
};

const listPurchaseOrders = async (req, res) => {
  try {
    const params = parseListParams(req.query, { defaultSortBy: "created_at", defaultOrder: "DESC" });
    const { sortBy, order } = pickSort(params, ["created_at", "po_number", "status"], "created_at");

    const hasSearch = Boolean(params.search);
    const where = hasSearch ? "WHERE po.po_number ILIKE $1 OR s.name ILIKE $1" : "";
    const countArgs = hasSearch ? [`%${params.search}%`] : [];

    const totalResult = await req.tenantDB.query(
      `
      SELECT COUNT(*)::int AS total
      FROM purchase_orders po
      JOIN suppliers s ON s.id = po.supplier_id
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
        po.id,
        po.po_number,
        po.status,
        po.purchase_total,
        po.gst_percentage,
        po.gst_amount,
        po.selected_tax_ids,
        po.created_at,
        po.updated_at,
        po.supplier_id,
        s.name AS supplier_name
      FROM purchase_orders po
      JOIN suppliers s ON s.id = po.supplier_id
      ${where}
      ORDER BY po.${sortBy} ${order}
      LIMIT $${hasSearch ? 2 : 1} OFFSET $${hasSearch ? 3 : 2}
      `,
      dataArgs
    );

    return res.status(200).json({
      data: result.rows,
      pagination: buildPagination({ total, page: params.page, limit: params.limit }),
    });
  } catch (error) {
    logError("GET /api/purchase-orders", error);
    return res.status(500).json({ message: "Failed to fetch purchase orders." });
  }
};

const getPurchaseOrder = async (req, res) => {
  const { id } = req.params;
  try {
    const po = await req.tenantDB.query(
      `
      SELECT
        po.id,
        po.purchase_request_id,
        po.supplier_id,
        s.name AS supplier_name,
        po.po_number,
        po.status,
        po.remarks,
        po.purchase_total,
        po.gst_percentage,
        po.gst_amount,
        po.selected_tax_ids,
        po.created_at,
        po.updated_at
      FROM purchase_orders po
      JOIN suppliers s ON s.id = po.supplier_id
      WHERE po.id = $1
      LIMIT 1
      `,
      [id]
    );
    if (po.rowCount === 0) return res.status(404).json({ message: "Purchase order not found." });

    const items = await req.tenantDB.query(
      `
      SELECT
        poi.id,
        poi.raw_material_id,
        rm.name AS raw_material_name,
        poi.ordered_quantity,
        poi.received_quantity,
        poi.unit_id,
        u.name AS unit_name,
        u.short_name AS unit_short_name
      FROM purchase_order_items poi
      JOIN raw_materials rm ON rm.id = poi.raw_material_id
      JOIN units u ON u.id = poi.unit_id
      WHERE poi.purchase_order_id = $1
      ORDER BY rm.name ASC
      `,
      [id]
    );

    return res.status(200).json({
      data: {
        ...po.rows[0],
        items: items.rows,
      },
    });
  } catch (error) {
    logError("GET /api/purchase-orders/:id", error);
    return res.status(500).json({ message: "Failed to fetch purchase order." });
  }
};

const updatePurchaseOrderStatus = async (req, res) => {
  const { id } = req.params;
  const status = String(req.body?.status || "").trim().toLowerCase();
  const allowed = new Set(["created", "sent", "partially_received", "completed"]);
  if (!allowed.has(status)) return res.status(400).json({ message: "Invalid status." });

  const canTransition = (from, to) => {
    if (from === "created" && to === "sent") return true;
    if (from === "sent" && to === "partially_received") return true;
    if (from === "partially_received" && to === "completed") return true;
    return false;
  };

  try {
    const updated = await withTenantTx(req.tenantDB, async (client) => {
      const current = await client.query(
        "SELECT id, status FROM purchase_orders WHERE id = $1 LIMIT 1 FOR UPDATE",
        [id]
      );
      if (current.rowCount === 0) {
        const err = new Error("Purchase order not found.");
        err.statusCode = 404;
        throw err;
      }
      const from = current.rows[0].status;
      if (!canTransition(from, status)) {
        const err = new Error(`Invalid status transition: ${from} → ${status}`);
        err.statusCode = 400;
        throw err;
      }

      const out = await client.query(
        `
        UPDATE purchase_orders
        SET status = $1,
            updated_at = NOW()
        WHERE id = $2
        RETURNING id, po_number, status, updated_at
        `,
        [status, id]
      );
      return out.rows[0];
    });

    return res.status(200).json({ message: "Status updated.", data: updated });
  } catch (error) {
    logError("PUT /api/purchase-orders/:id/status", error);
    return res.status(error.statusCode || 500).json({
      message: error?.message || "Failed to update status.",
    });
  }
};

module.exports = {
  createPurchaseOrderFromPr,
  listPurchaseOrders,
  getPurchaseOrder,
  updatePurchaseOrderStatus,
};

