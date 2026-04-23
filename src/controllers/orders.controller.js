const { randomUUID } = require("crypto");
const { logError } = require("../utils/logError");
const { parseListParams, buildPagination, pickSort } = require("../utils/listQuery");
const { deductStockByVariantWithClient } = require("../services/stock.service");

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

const toPositiveNumber = (value, label) => {
  const n = Number(value);
  if (Number.isNaN(n) || !Number.isFinite(n) || n <= 0) {
    const err = new Error(`${label} must be greater than 0.`);
    err.statusCode = 400;
    throw err;
  }
  return n;
};

const nextOrderNumber = async (client) => {
  await client.query("LOCK TABLE orders IN EXCLUSIVE MODE");
  const maxRow = await client.query(
    `
    SELECT COALESCE(MAX(NULLIF(regexp_replace(order_number, '^ORD-', ''), '')::int), 0) AS max_no
    FROM orders
    `
  );
  const maxNo = Number(maxRow.rows[0]?.max_no || 0);
  const nextNo = maxNo + 1;
  return `ORD-${String(nextNo).padStart(4, "0")}`;
};

const ensureTableExists = async (client, tableId) => {
  const t = await client.query("SELECT id FROM tables WHERE id = $1 LIMIT 1", [tableId]);
  return t.rowCount > 0;
};

const normalizeItems = (items) => {
  const rows = Array.isArray(items) ? items : [];
  if (rows.length === 0) {
    const err = new Error("At least 1 item is required.");
    err.statusCode = 400;
    throw err;
  }
  return rows.map((it, idx) => {
    const variantId = String(it?.variant_id || "").trim();
    if (!variantId) {
      const err = new Error(`items[${idx}].variant_id is required.`);
      err.statusCode = 400;
      throw err;
    }
    return {
      variant_id: variantId,
      quantity: toPositiveNumber(it?.quantity, `items[${idx}].quantity`),
    };
  });
};

const fetchVariantPrices = async (client, variantIds) => {
  const q = await client.query(
    `
    SELECT id, price
    FROM menu_item_variants
    WHERE id = ANY($1::uuid[])
    `,
    [variantIds]
  );
  return new Map(q.rows.map((r) => [r.id, Number(r.price || 0)]));
};

const toNonNegativeNumber = (value, label, defaultValue = 0) => {
  if (value === undefined || value === null || value === "") return Number(defaultValue || 0);
  const n = Number(value);
  if (Number.isNaN(n) || !Number.isFinite(n) || n < 0) {
    const err = new Error(`${label} must be >= 0.`);
    err.statusCode = 400;
    throw err;
  }
  return n;
};

const toNullableText = (value, maxLen) => {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  if (!s) return null;
  return maxLen ? s.slice(0, maxLen) : s;
};

const computeTax = (subtotal, taxPercentage) => {
  const sub = Number(subtotal || 0);
  const tp = Number(taxPercentage || 0);
  const taxAmount = (sub * tp) / 100;
  const total = sub + taxAmount;
  return { taxAmount, total };
};

const createOrder = async (req, res) => {
  const { order_type, table_id, items, guest_name, guest_phone, guest_address, tax_percentage } = req.body || {};
  const orderType = String(order_type || "dine_in").trim().toLowerCase();
  const allowedTypes = new Set(["dine_in", "takeaway", "delivery"]);
  if (!allowedTypes.has(orderType)) return res.status(400).json({ message: "Invalid order_type." });

  let normalized;
  try {
    normalized = normalizeItems(items);
  } catch (e) {
    return res.status(e.statusCode || 400).json({ message: e.message });
  }

  try {
    const created = await withTenantTx(req.tenantDB, async (client) => {
      const taxPercentage = toNonNegativeNumber(tax_percentage, "tax_percentage", 0);
      const guestName = toNullableText(guest_name, 160);
      const guestPhone = toNullableText(guest_phone, 40);
      const guestAddress = toNullableText(guest_address);

      const tableId = table_id ? String(table_id).trim() : null;
      if (orderType === "dine_in") {
        if (!tableId) {
          const err = new Error("table_id is required for dine_in.");
          err.statusCode = 400;
          throw err;
        }
        const ok = await ensureTableExists(client, tableId);
        if (!ok) {
          const err = new Error("Selected table does not exist.");
          err.statusCode = 400;
          throw err;
        }
      }

      const orderNumber = await nextOrderNumber(client);
      const orderId = randomUUID();

      const variantIds = normalized.map((x) => x.variant_id);
      const prices = await fetchVariantPrices(client, variantIds);
      for (const it of normalized) {
        if (!prices.has(it.variant_id)) {
          const err = new Error("One or more variants do not exist.");
          err.statusCode = 400;
          throw err;
        }
      }

      let subtotal = 0;
      const prepared = normalized.map((it) => {
        const price = Number(prices.get(it.variant_id) || 0);
        const total_price = price * Number(it.quantity);
        subtotal += total_price;
        return { ...it, price, total_price };
      });

      const { taxAmount, total } = computeTax(subtotal, taxPercentage);

      const inserted = await client.query(
        `
        INSERT INTO orders (
          id, order_number, order_type, status, table_id,
          guest_name, guest_phone, guest_address,
          tax_percentage, tax_amount, total_amount
        )
        VALUES ($1, $2, $3, 'created', $4, $5, $6, $7, $8, $9, $10)
        RETURNING
          id, order_number, order_type, status, table_id,
          guest_name, guest_phone, guest_address,
          tax_percentage, tax_amount,
          total_amount, total_cost, total_profit,
          created_at, updated_at
        `,
        [
          orderId,
          orderNumber,
          orderType,
          orderType === "dine_in" ? tableId : null,
          guestName,
          guestPhone,
          guestAddress,
          taxPercentage,
          taxAmount,
          total,
        ]
      );

      for (const it of prepared) {
        await client.query(
          `
          INSERT INTO order_items (
            id, order_id, variant_id, quantity, price, total_price, cost_price, profit
          )
          VALUES ($1, $2, $3, $4, $5, $6, 0, 0)
          `,
          [randomUUID(), orderId, it.variant_id, it.quantity, it.price, it.total_price]
        );
      }

      return inserted.rows[0];
    });

    return res.status(201).json({ message: "Order created.", data: created });
  } catch (error) {
    if (isUniqueViolation(error)) {
      return res.status(409).json({ message: "Order number already exists. Please retry." });
    }
    logError("POST /api/orders", error);
    return res.status(error.statusCode || 500).json({ message: error?.message || "Failed to create order." });
  }
};

const updateOrder = async (req, res) => {
  const { id } = req.params;
  const { table_id, items, guest_name, guest_phone, guest_address, tax_percentage } = req.body || {};

  const hasItems = Array.isArray(items);
  let normalized = null;
  if (hasItems) {
    try {
      normalized = normalizeItems(items);
    } catch (e) {
      return res.status(e.statusCode || 400).json({ message: e.message });
    }
  }

  try {
    const updated = await withTenantTx(req.tenantDB, async (client) => {
      const ord = await client.query(
        "SELECT id, order_type, status, table_id, tax_percentage FROM orders WHERE id = $1 LIMIT 1 FOR UPDATE",
        [id]
      );
      if (ord.rowCount === 0) {
        const err = new Error("Order not found.");
        err.statusCode = 404;
        throw err;
      }
      const status = ord.rows[0].status;
      const s = String(status || "").toLowerCase();
      // Items are editable only up to preparing, but guest/tax can be updated at served (payment step)
      if (hasItems) {
        const editableItems = new Set(["created", "kot_sent", "preparing"]);
        if (!editableItems.has(s)) {
          const err = new Error("Order items cannot be edited at this stage.");
          err.statusCode = 400;
          throw err;
        }
      } else {
        const editableGuest = new Set(["created", "kot_sent", "preparing", "served"]);
        if (!editableGuest.has(s)) {
          const err = new Error("Order cannot be edited at this stage.");
          err.statusCode = 400;
          throw err;
        }
      }

      const orderType = ord.rows[0].order_type;
      const existingTableId = ord.rows[0].table_id;
      const tableId = table_id ? String(table_id).trim() : existingTableId || null;
      if (orderType === "dine_in") {
        if (!tableId) {
          const err = new Error("table_id is required for dine_in.");
          err.statusCode = 400;
          throw err;
        }
        const ok = await ensureTableExists(client, tableId);
        if (!ok) {
          const err = new Error("Selected table does not exist.");
          err.statusCode = 400;
          throw err;
        }
      }

      const existingTax = Number(ord.rows[0]?.tax_percentage || 0);
      const taxPercentage = toNonNegativeNumber(tax_percentage, "tax_percentage", existingTax);
      const guestName = toNullableText(guest_name, 160);
      const guestPhone = toNullableText(guest_phone, 40);
      const guestAddress = toNullableText(guest_address);

      let prepared = [];
      let subtotal = 0;

      if (hasItems) {
        const variantIds = normalized.map((x) => x.variant_id);
        const prices = await fetchVariantPrices(client, variantIds);
        for (const it of normalized) {
          if (!prices.has(it.variant_id)) {
            const err = new Error("One or more variants do not exist.");
            err.statusCode = 400;
            throw err;
          }
        }

        prepared = normalized.map((it) => {
          const price = Number(prices.get(it.variant_id) || 0);
          const total_price = price * Number(it.quantity);
          subtotal += total_price;
          return { ...it, price, total_price };
        });

        await client.query("DELETE FROM order_items WHERE order_id = $1", [id]);
        for (const it of prepared) {
          await client.query(
            `
            INSERT INTO order_items (
              id, order_id, variant_id, quantity, price, total_price, cost_price, profit
            )
            VALUES ($1, $2, $3, $4, $5, $6, 0, 0)
            `,
            [randomUUID(), id, it.variant_id, it.quantity, it.price, it.total_price]
          );
        }
      } else {
        // guest/tax-only update: compute subtotal from existing items
        const existingItems = await client.query(
          `
          SELECT quantity, price, total_price
          FROM order_items
          WHERE order_id = $1
          `,
          [id]
        );
        for (const it of existingItems.rows || []) {
          subtotal += Number(it.total_price || Number(it.price || 0) * Number(it.quantity || 0));
        }
      }

      const { taxAmount, total } = computeTax(subtotal, taxPercentage);

      const out = await client.query(
        `
        UPDATE orders
        SET table_id = $1,
            guest_name = $2,
            guest_phone = $3,
            guest_address = $4,
            tax_percentage = $5,
            tax_amount = $6,
            total_amount = $7,
            updated_at = NOW()
        WHERE id = $8
        RETURNING
          id, order_number, order_type, status, table_id,
          guest_name, guest_phone, guest_address,
          tax_percentage, tax_amount,
          total_amount, total_cost, total_profit,
          created_at, updated_at
        `,
        [orderType === "dine_in" ? tableId : null, guestName, guestPhone, guestAddress, taxPercentage, taxAmount, total, id]
      );

      return out.rows[0];
    });

    return res.status(200).json({ message: "Order updated.", data: updated });
  } catch (error) {
    logError("PUT /api/orders/:id", error);
    return res.status(error.statusCode || 500).json({ message: error?.message || "Failed to update order." });
  }
};

const listOrders = async (req, res) => {
  try {
    const params = parseListParams(req.query, { defaultSortBy: "created_at", defaultOrder: "DESC" });
    const { sortBy, order } = pickSort(params, ["created_at", "order_number", "status", "total_amount"], "created_at");

    const statusFilter = String(req.query?.status || "").trim().toLowerCase();
    const allowedStatuses = new Set(["created", "kot_sent", "preparing", "ready", "served", "completed", "cancelled"]);
    const status = allowedStatuses.has(statusFilter) ? statusFilter : "";

    const whereParts = [];
    const args = [];
    if (params.search) {
      args.push(`%${params.search}%`);
      whereParts.push(`(o.order_number ILIKE $${args.length} OR t.name ILIKE $${args.length})`);
    }
    if (status) {
      args.push(status);
      whereParts.push(`o.status = $${args.length}`);
    }
    const where = whereParts.length ? `WHERE ${whereParts.join(" AND ")}` : "";

    const totalResult = await req.tenantDB.query(
      `
      SELECT COUNT(*)::int AS total
      FROM orders o
      LEFT JOIN tables t ON t.id = o.table_id
      LEFT JOIN table_types tt ON tt.id = t.table_type_id
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
        o.id,
        o.order_number,
        o.order_type,
        o.status,
        o.kot_sent_at,
        o.payment_status,
        o.guest_name,
        o.guest_phone,
        o.guest_address,
        o.tax_percentage,
        o.tax_amount,
        o.table_id,
        t.name AS table_name,
        tt.name AS table_type_name,
        o.total_amount,
        o.total_cost,
        o.total_profit,
        o.created_at,
        o.updated_at
      FROM orders o
      LEFT JOIN tables t ON t.id = o.table_id
      LEFT JOIN table_types tt ON tt.id = t.table_type_id
      ${where}
      ORDER BY o.${sortBy} ${order}
      LIMIT $${limitIdx} OFFSET $${offsetIdx}
      `,
      dataArgs
    );

    return res.status(200).json({
      data: result.rows,
      pagination: buildPagination({ total, page: params.page, limit: params.limit }),
    });
  } catch (error) {
    logError("GET /api/orders", error);
    return res.status(500).json({ message: "Failed to fetch orders." });
  }
};

const getOrder = async (req, res) => {
  const { id } = req.params;
  try {
    const ord = await req.tenantDB.query(
      `
      SELECT
        o.id,
        o.order_number,
        o.order_type,
        o.status,
        o.kot_sent_at,
        o.payment_status,
        o.guest_name,
        o.guest_phone,
        o.guest_address,
        o.tax_percentage,
        o.tax_amount,
        o.table_id,
        t.name AS table_name,
        tt.name AS table_type_name,
        o.total_amount,
        o.total_cost,
        o.total_profit,
        o.created_at,
        o.updated_at
      FROM orders o
      LEFT JOIN tables t ON t.id = o.table_id
      LEFT JOIN table_types tt ON tt.id = t.table_type_id
      WHERE o.id = $1
      LIMIT 1
      `,
      [id]
    );
    if (ord.rowCount === 0) return res.status(404).json({ message: "Order not found." });

    const items = await req.tenantDB.query(
      `
      SELECT
        oi.id,
        oi.variant_id,
        v.name AS variant_name,
        i.name AS item_name,
        oi.quantity,
        oi.price,
        oi.total_price,
        oi.cost_price,
        oi.profit
      FROM order_items oi
      JOIN menu_item_variants v ON v.id = oi.variant_id
      JOIN menu_items i ON i.id = v.item_id
      WHERE oi.order_id = $1
      ORDER BY i.name ASC, v.name ASC
      `,
      [id]
    );

    return res.status(200).json({
      data: {
        ...ord.rows[0],
        items: items.rows,
      },
    });
  } catch (error) {
    logError("GET /api/orders/:id", error);
    return res.status(500).json({ message: "Failed to fetch order." });
  }
};

const getActiveOrderByTable = async (req, res) => {
  const { table_id } = req.params;
  const tableId = String(table_id || "").trim();
  if (!tableId) return res.status(400).json({ message: "table_id is required." });

  try {
    const ord = await req.tenantDB.query(
      `
      SELECT
        o.id AS order_id,
        o.table_id,
        o.status,
        o.payment_status,
        o.guest_name,
        o.guest_phone,
        o.guest_address,
        o.tax_percentage,
        o.tax_amount,
        o.total_amount
      FROM orders o
      WHERE o.table_id = $1
        AND o.status NOT IN ('completed', 'cancelled')
      ORDER BY o.created_at DESC
      LIMIT 1
      `,
      [tableId]
    );

    if (ord.rowCount === 0) return res.status(200).json({ data: null });

    const orderId = ord.rows[0].order_id;
    const items = await req.tenantDB.query(
      `
      SELECT
        oi.variant_id,
        oi.quantity,
        oi.price,
        i.name AS item_name,
        v.name AS variant_name
      FROM order_items oi
      JOIN menu_item_variants v ON v.id = oi.variant_id
      JOIN menu_items i ON i.id = v.item_id
      WHERE oi.order_id = $1
      ORDER BY i.name ASC, v.name ASC
      `,
      [orderId]
    );

    return res.status(200).json({
      data: {
        ...ord.rows[0],
        items: items.rows || [],
      },
    });
  } catch (error) {
    logError("GET /api/orders/by-table/:table_id", error);
    return res.status(500).json({ message: "Failed to fetch active order for table." });
  }
};

const canTransition = (from, to) => {
  if (from === "created" && to === "kot_sent") return true;
  if (from === "kot_sent" && to === "preparing") return true;
  if (from === "preparing" && to === "ready") return true;
  if (from === "ready" && to === "served") return true;
  if (from === "served" && to === "completed") return true;
  return false;
};

const updateOrderStatus = async (req, res) => {
  const { id } = req.params;
  const next = String(req.body?.status || "").trim().toLowerCase();
  const allowedStatuses = new Set(["created", "kot_sent", "preparing", "ready", "served", "completed", "cancelled"]);
  if (!allowedStatuses.has(next)) return res.status(400).json({ message: "Invalid status." });

  try {
    const out = await withTenantTx(req.tenantDB, async (client) => {
      const ord = await client.query(
        "SELECT id, status, kot_sent_at, payment_status FROM orders WHERE id = $1 LIMIT 1 FOR UPDATE",
        [id]
      );
      if (ord.rowCount === 0) {
        const err = new Error("Order not found.");
        err.statusCode = 404;
        throw err;
      }
      const current = ord.rows[0].status;
      if (!canTransition(current, next)) {
        const err = new Error(`Invalid status transition: ${current} → ${next}`);
        err.statusCode = 400;
        throw err;
      }

      if (current === "served" && next === "completed") {
        const ps = String(ord.rows[0]?.payment_status || "unpaid").toLowerCase();
        if (ps !== "paid") {
          const err = new Error("Cannot complete order without payment.");
          err.statusCode = 400;
          throw err;
        }
      }

      if (next !== "served") {
        // created -> kot_sent should set kot_sent_at only once
        const shouldSetKot = current === "created" && next === "kot_sent";
        const updated = shouldSetKot
          ? await client.query(
              `
              UPDATE orders
              SET status = $1,
                  kot_sent_at = COALESCE(kot_sent_at, NOW()),
                  updated_at = NOW()
              WHERE id = $2
              RETURNING id, order_number, status, kot_sent_at, updated_at
              `,
              [next, id]
            )
          : await client.query(
              `
              UPDATE orders
              SET status = $1,
                  updated_at = NOW()
              WHERE id = $2
              RETURNING id, order_number, status, kot_sent_at, updated_at
              `,
              [next, id]
            );
        return updated.rows[0];
      }

      // Served finalization logic (execute once, inside same tx)
      const items = await client.query(
        `
        SELECT id, variant_id, quantity, price, total_price
        FROM order_items
        WHERE order_id = $1
        `,
        [id]
      );
      if (items.rowCount === 0) {
        const err = new Error("Order has no items.");
        err.statusCode = 400;
        throw err;
      }

      let totalAmount = 0;
      let totalCost = 0;

      for (const it of items.rows) {
        const qty = Number(it.quantity);
        const totalPrice = Number(it.total_price);
        totalAmount += totalPrice;

        // Fetch recipe ingredients with raw material pricing/config
        const recipe = await client.query(
          `
          SELECT
            ri.raw_material_id,
            ri.quantity AS recipe_quantity,
            ri.unit_id AS recipe_unit_id,
            rm.name AS raw_material_name,
            rm.purchase_price,
            rm.purchase_unit_id,
            rm.consumption_unit_id,
            rm.conversion_factor
          FROM recipe_items ri
          JOIN raw_materials rm ON rm.id = ri.raw_material_id
          WHERE ri.menu_item_variant_id = $1
          `,
          [it.variant_id]
        );
        if (recipe.rowCount === 0) {
          const err = new Error("Recipe not found for one or more order items.");
          err.statusCode = 400;
          throw err;
        }

        let itemCost = 0;
        for (const ing of recipe.rows) {
          const perUnit = Number(ing.recipe_quantity);
          if (!Number.isFinite(perUnit) || perUnit <= 0) continue;
          const reqConsumptionQty = perUnit * qty; // recipe is in consumption unit

          const purchasePrice = Number(ing.purchase_price || 0);
          const factor = Number(ing.conversion_factor || 1);
          if (!Number.isFinite(purchasePrice) || purchasePrice < 0) {
            const err = new Error(`Invalid purchase price for ${ing.raw_material_name}`);
            err.statusCode = 400;
            throw err;
          }
          if (!Number.isFinite(factor) || factor <= 0) {
            const err = new Error(`Invalid conversion factor for ${ing.raw_material_name}`);
            err.statusCode = 400;
            throw err;
          }

          // Convert consumption qty → purchase qty when recipe unit is consumption unit.
          // purchase_qty = consumption_qty / conversion_factor
          const recipeUnitId = ing.recipe_unit_id;
          let purchaseQty;
          if (ing.purchase_unit_id && recipeUnitId === ing.purchase_unit_id) {
            purchaseQty = reqConsumptionQty;
          } else if (ing.consumption_unit_id && recipeUnitId === ing.consumption_unit_id) {
            purchaseQty = reqConsumptionQty / factor;
          } else {
            const err = new Error(`Recipe unit mismatch for ${ing.raw_material_name}`);
            err.statusCode = 400;
            throw err;
          }

          itemCost += purchaseQty * purchasePrice;
        }

        // Deduct stock using existing stock logic (conversion + locking), multiplied by item quantity
        await deductStockByVariantWithClient(client, it.variant_id, { multiplier: qty });

        const profit = totalPrice - itemCost;
        totalCost += itemCost;

        await client.query(
          `
          UPDATE order_items
          SET cost_price = $1,
              profit = $2
          WHERE id = $3
          `,
          [itemCost, profit, it.id]
        );
      }

      const totalProfit = totalAmount - totalCost;

      const updated = await client.query(
        `
        UPDATE orders
        SET status = 'served',
            total_amount = $1,
            total_cost = $2,
            total_profit = $3,
            updated_at = NOW()
        WHERE id = $4
        RETURNING id, order_number, status, kot_sent_at, total_amount, total_cost, total_profit, updated_at
        `,
        [totalAmount, totalCost, totalProfit, id]
      );

      return updated.rows[0];
    });

    return res.status(200).json({ message: "Order status updated.", data: out });
  } catch (error) {
    logError("PUT /api/orders/:id/status", error);
    return res.status(error.statusCode || 500).json({
      message: error?.message || "Failed to update status.",
    });
  }
};

module.exports = {
  createOrder,
  updateOrder,
  listOrders,
  getOrder,
  getActiveOrderByTable,
  updateOrderStatus,
};

