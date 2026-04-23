const { randomUUID } = require("crypto");
const { logError } = require("../utils/logError");
const { parseListParams, buildPagination, pickSort } = require("../utils/listQuery");
const { addStockWithClient } = require("../services/stock.service");

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

const toNonNegativeNumber = (value, label) => {
  const n = Number(value);
  if (Number.isNaN(n) || !Number.isFinite(n) || n < 0) {
    const err = new Error(`${label} must be a number greater than or equal to 0.`);
    err.statusCode = 400;
    throw err;
  }
  return n;
};

const nextGrnNumber = async (client) => {
  await client.query("LOCK TABLE grns IN EXCLUSIVE MODE");
  const maxRow = await client.query(
    `
    SELECT COALESCE(MAX(NULLIF(regexp_replace(grn_number, '^GRN-', ''), '')::int), 0) AS max_no
    FROM grns
    `
  );
  const maxNo = Number(maxRow.rows[0]?.max_no || 0);
  const nextNo = maxNo + 1;
  return `GRN-${String(nextNo).padStart(4, "0")}`;
};

const createGrnFromPo = async (req, res) => {
  const poId = String(req.params?.poId || "").trim();
  const { received_date, remarks, items } = req.body || {};

  if (!poId) return res.status(400).json({ message: "poId is required." });

  const receivedDateStr = String(received_date || "").trim();
  const dateObj = receivedDateStr ? new Date(receivedDateStr) : new Date();
  if (Number.isNaN(dateObj.getTime())) {
    return res.status(400).json({ message: "received_date is invalid." });
  }
  const receivedDateISO = dateObj.toISOString().slice(0, 10); // YYYY-MM-DD
  const remarksText = remarks === undefined || remarks === null ? null : String(remarks).trim();

  const provided = Array.isArray(items) ? items : [];
  const receivedByRawId = new Map();
  try {
    for (let i = 0; i < provided.length; i++) {
      const it = provided[i];
      const rawId = String(it?.raw_material_id || "").trim();
      if (!rawId) {
        const err = new Error(`items[${i}].raw_material_id is required.`);
        err.statusCode = 400;
        throw err;
      }
      if (receivedByRawId.has(rawId)) {
        const err = new Error("Duplicate raw_material_id in items is not allowed.");
        err.statusCode = 400;
        throw err;
      }
      receivedByRawId.set(rawId, toNonNegativeNumber(it?.received_quantity, `items[${i}].received_quantity`));
    }
  } catch (e) {
    return res.status(e.statusCode || 400).json({ message: e.message });
  }

  try {
    const created = await withTenantTx(req.tenantDB, async (client) => {
      const po = await client.query(
        `
        SELECT id, supplier_id, po_number, status
        FROM purchase_orders
        WHERE id = $1
        LIMIT 1
        FOR UPDATE
        `,
        [poId]
      );
      if (po.rowCount === 0) {
        const err = new Error("Purchase order not found.");
        err.statusCode = 404;
        throw err;
      }
      const poStatus = po.rows[0].status;
      if (!["sent", "partially_received"].includes(poStatus)) {
        const err = new Error('GRN can only be created when PO status is "sent" or "partially_received".');
        err.statusCode = 400;
        throw err;
      }

      const poItems = await client.query(
        `
        SELECT id, raw_material_id, ordered_quantity, received_quantity, unit_id
        FROM purchase_order_items
        WHERE purchase_order_id = $1
        FOR UPDATE
        `,
        [poId]
      );
      if (poItems.rowCount === 0) {
        const err = new Error("Purchase order has no items.");
        err.statusCode = 400;
        throw err;
      }

      // Validate remaining constraints and require at least one > 0 receipt.
      const normalized = poItems.rows.map((r) => {
        const ordered = Number(r.ordered_quantity);
        const already = Number(r.received_quantity || 0);
        const remaining = ordered - already;
        const incoming = receivedByRawId.has(r.raw_material_id)
          ? Number(receivedByRawId.get(r.raw_material_id))
          : 0;
        return {
          po_item_id: r.id,
          raw_material_id: r.raw_material_id,
          unit_id: r.unit_id,
          ordered_quantity: ordered,
          already_received: already,
          remaining,
          incoming_received: incoming,
        };
      });

      for (const r of normalized) {
        if (r.remaining < 0) {
          const err = new Error("PO received quantities are inconsistent.");
          err.statusCode = 400;
          throw err;
        }
        if (r.incoming_received < 0) {
          const err = new Error("received_quantity must be >= 0.");
          err.statusCode = 400;
          throw err;
        }
        if (r.incoming_received > r.remaining) {
          const err = new Error("received_quantity cannot exceed remaining quantity for an item.");
          err.statusCode = 400;
          throw err;
        }
      }

      const totalIncoming = normalized.reduce((sum, r) => sum + Number(r.incoming_received || 0), 0);
      if (totalIncoming <= 0) {
        const err = new Error("At least one item must have received_quantity > 0.");
        err.statusCode = 400;
        throw err;
      }

      const grnNumber = await nextGrnNumber(client);
      const grnId = randomUUID();

      const insertedGrn = await client.query(
        `
        INSERT INTO grns (id, purchase_order_id, grn_number, received_date, remarks)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id, purchase_order_id, grn_number, received_date, remarks, created_at, updated_at
        `,
        [grnId, poId, grnNumber, receivedDateISO, remarksText || null]
      );

      // Create GRN items (one per PO item, received may be 0)
      for (const r of normalized) {
        await client.query(
          `
          INSERT INTO grn_items (id, grn_id, raw_material_id, ordered_quantity, received_quantity, unit_id)
          VALUES ($1, $2, $3, $4, $5, $6)
          `,
          [randomUUID(), grnId, r.raw_material_id, r.ordered_quantity, r.incoming_received, r.unit_id]
        );
      }

      // Stock update + PO item received increment (only when incoming > 0)
      for (const r of normalized) {
        if (r.incoming_received <= 0) continue;

        // Must use existing stock logic (conversion/locking).
        await addStockWithClient(client, {
          raw_material_id: r.raw_material_id,
          quantity: r.incoming_received,
          unit_id: r.unit_id,
        });

        await client.query(
          `
          UPDATE purchase_order_items
          SET received_quantity = received_quantity + $1
          WHERE id = $2
          `,
          [r.incoming_received, r.po_item_id]
        );
      }

      // Update PO status based on remaining quantities
      const after = await client.query(
        `
        SELECT ordered_quantity, received_quantity
        FROM purchase_order_items
        WHERE purchase_order_id = $1
        `,
        [poId]
      );
      const allComplete = after.rows.every(
        (x) => Number(x.received_quantity || 0) >= Number(x.ordered_quantity || 0)
      );
      const nextStatus = allComplete ? "completed" : "partially_received";

      await client.query(
        `
        UPDATE purchase_orders
        SET status = $1,
            updated_at = NOW()
        WHERE id = $2
        `,
        [nextStatus, poId]
      );

      return insertedGrn.rows[0];
    });

    return res.status(201).json({ message: "GRN created.", data: created });
  } catch (error) {
    if (isUniqueViolation(error)) {
      return res.status(409).json({ message: "GRN number already exists. Please retry." });
    }
    logError("POST /api/grns/from-po/:poId", error);
    return res.status(error.statusCode || 500).json({
      message: error?.message || "Failed to create GRN.",
    });
  }
};

const listGrns = async (req, res) => {
  try {
    const params = parseListParams(req.query, { defaultSortBy: "received_date", defaultOrder: "DESC" });
    const { sortBy, order } = pickSort(params, ["received_date", "created_at", "grn_number"], "received_date");

    const hasSearch = Boolean(params.search);
    const where = hasSearch
      ? "WHERE g.grn_number ILIKE $1 OR po.po_number ILIKE $1 OR s.name ILIKE $1"
      : "";
    const countArgs = hasSearch ? [`%${params.search}%`] : [];

    const totalResult = await req.tenantDB.query(
      `
      SELECT COUNT(*)::int AS total
      FROM grns g
      JOIN purchase_orders po ON po.id = g.purchase_order_id
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
        g.id,
        g.grn_number,
        g.received_date,
        g.created_at,
        g.purchase_order_id,
        po.po_number,
        s.name AS supplier_name
      FROM grns g
      JOIN purchase_orders po ON po.id = g.purchase_order_id
      JOIN suppliers s ON s.id = po.supplier_id
      ${where}
      ORDER BY g.${sortBy} ${order}
      LIMIT $${hasSearch ? 2 : 1} OFFSET $${hasSearch ? 3 : 2}
      `,
      dataArgs
    );

    return res.status(200).json({
      data: result.rows,
      pagination: buildPagination({ total, page: params.page, limit: params.limit }),
    });
  } catch (error) {
    logError("GET /api/grns", error);
    return res.status(500).json({ message: "Failed to fetch GRNs." });
  }
};

const getGrn = async (req, res) => {
  const { id } = req.params;
  try {
    const grn = await req.tenantDB.query(
      `
      SELECT
        g.id,
        g.grn_number,
        g.received_date,
        g.remarks,
        g.created_at,
        g.updated_at,
        g.purchase_order_id,
        po.po_number,
        s.id AS supplier_id,
        s.name AS supplier_name
      FROM grns g
      JOIN purchase_orders po ON po.id = g.purchase_order_id
      JOIN suppliers s ON s.id = po.supplier_id
      WHERE g.id = $1
      LIMIT 1
      `,
      [id]
    );
    if (grn.rowCount === 0) return res.status(404).json({ message: "GRN not found." });

    const items = await req.tenantDB.query(
      `
      SELECT
        gi.id,
        gi.raw_material_id,
        rm.name AS raw_material_name,
        gi.ordered_quantity,
        gi.received_quantity,
        gi.unit_id,
        u.name AS unit_name,
        u.short_name AS unit_short_name
      FROM grn_items gi
      JOIN raw_materials rm ON rm.id = gi.raw_material_id
      JOIN units u ON u.id = gi.unit_id
      WHERE gi.grn_id = $1
      ORDER BY rm.name ASC
      `,
      [id]
    );

    return res.status(200).json({
      data: {
        ...grn.rows[0],
        items: items.rows,
      },
    });
  } catch (error) {
    logError("GET /api/grns/:id", error);
    return res.status(500).json({ message: "Failed to fetch GRN." });
  }
};

module.exports = {
  createGrnFromPo,
  listGrns,
  getGrn,
};

