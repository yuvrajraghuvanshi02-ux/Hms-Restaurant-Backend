const { randomUUID } = require("crypto");
const { logError } = require("../utils/logError");
const { parseListParams, buildPagination, pickSort } = require("../utils/listQuery");
const { deductStockByVariantWithClient, addStockWithClient } = require("../services/stock.service");

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
      is_complimentary: Boolean(it?.is_complimentary),
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

const normalizeTaxIds = (value) => {
  const arr = Array.isArray(value) ? value : [];
  return Array.from(
    new Set(
      arr
        .map((x) => String(x || "").trim())
        .filter(Boolean)
    )
  );
};

const computeTaxesFromSelection = async (client, subtotal, selectedTaxIds) => {
  const sub = Number(subtotal || 0);
  const ids = normalizeTaxIds(selectedTaxIds);
  if (ids.length === 0) return { selectedTaxIds: [], taxBreakup: {}, totalTaxAmount: 0, taxPercentage: 0 };

  const q = await client.query(
    `
    SELECT id, name, percentage
    FROM taxes
    WHERE id = ANY($1::uuid[])
      AND is_active = TRUE
    `,
    [ids]
  );
  const rows = q.rows || [];
  const selected = rows.map((r) => String(r.id));
  const taxBreakup = {};
  let totalTaxAmount = 0;
  let taxPercentage = 0;
  for (const t of rows) {
    const pct = Number(t.percentage || 0);
    const amount = (sub * pct) / 100;
    taxBreakup[String(t.name || "").trim() || "Tax"] = amount;
    totalTaxAmount += amount;
    taxPercentage += pct;
  }
  return { selectedTaxIds: selected, taxBreakup, totalTaxAmount, taxPercentage };
};

const recalcOrderTotalsForNonVoidedItems = async (client, orderId, { taxPercentage, selectedTaxIds, totalCost, discountAmount }) => {
  const sums = await client.query(
    `
    SELECT COALESCE(SUM(total_price), 0)::numeric AS subtotal
    FROM order_items
    WHERE order_id = $1
      AND COALESCE(status, 'active') IN ('active', 'replaced')
      AND COALESCE(is_voided, FALSE) = FALSE
      AND COALESCE(is_complimentary, FALSE) = FALSE
    `,
    [orderId]
  );
  const subtotal = Number(sums.rows[0]?.subtotal || 0);
  let taxAmount = 0;
  let total = subtotal;
  let outTaxPercentage = Number(taxPercentage || 0);
  let outSelectedTaxIds = normalizeTaxIds(selectedTaxIds);
  let outTaxBreakup = {};
  let outTotalTaxAmount = 0;
  if (outSelectedTaxIds.length > 0) {
    const tx = await computeTaxesFromSelection(client, subtotal, outSelectedTaxIds);
    outSelectedTaxIds = tx.selectedTaxIds;
    outTaxBreakup = tx.taxBreakup;
    outTotalTaxAmount = Number(tx.totalTaxAmount || 0);
    outTaxPercentage = Number(tx.taxPercentage || 0);
    taxAmount = outTotalTaxAmount;
    total = subtotal + taxAmount;
  } else {
    const c = computeTax(subtotal, outTaxPercentage);
    taxAmount = Number(c.taxAmount || 0);
    total = Number(c.total || 0);
    outTaxBreakup = outTaxPercentage > 0 ? { Tax: taxAmount } : {};
    outTotalTaxAmount = taxAmount;
  }
  const netRevenue = total - Math.max(0, Number(discountAmount || 0));
  const totalProfit = netRevenue - Number(totalCost || 0);
  return {
    subtotal,
    taxAmount,
    total,
    totalProfit,
    selectedTaxIds: outSelectedTaxIds,
    taxBreakup: outTaxBreakup,
    totalTaxAmount: outTotalTaxAmount,
    taxPercentage: outTaxPercentage,
  };
};

const toConsumptionQty = ({ recipeQty, recipeUnitId, qtyMultiplier, consumptionUnitId, purchaseUnitId, conversionFactor, rawMaterialName }) => {
  const perUnit = Number(recipeQty);
  if (!Number.isFinite(perUnit) || perUnit <= 0) return 0;
  const reqQty = perUnit * Number(qtyMultiplier || 0);
  if (!Number.isFinite(reqQty) || reqQty <= 0) return 0;

  const factor = Number(conversionFactor || 1);
  if (!Number.isFinite(factor) || factor <= 0) {
    const err = new Error(`Invalid conversion factor for ${rawMaterialName || "raw material"}`);
    err.statusCode = 400;
    throw err;
  }

  if (consumptionUnitId && recipeUnitId === consumptionUnitId) {
    return reqQty;
  }
  if (consumptionUnitId && purchaseUnitId && recipeUnitId === purchaseUnitId) {
    // consumption_qty = purchase_qty * conversion_factor
    return reqQty * factor;
  }

  const err = new Error(`Recipe unit mismatch for ${rawMaterialName || "raw material"}`);
  err.statusCode = 400;
  throw err;
};

const startOfRange = (range) => {
  const r = String(range || "day").trim().toLowerCase();
  const now = new Date();
  if (r === "month") return new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
  if (r === "week") {
    // Week starts Monday (server local timezone)
    const day = now.getDay(); // 0=Sun ... 6=Sat
    const diff = day === 0 ? 6 : day - 1;
    const d = new Date(now);
    d.setDate(now.getDate() - diff);
    d.setHours(0, 0, 0, 0);
    return d;
  }
  // default "day"
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d;
};

const createOrder = async (req, res) => {
  const { order_type, table_id, items, guest_name, guest_phone, guest_address, tax_percentage, selected_tax_ids } = req.body || {};
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
      let taxPercentage = toNonNegativeNumber(tax_percentage, "tax_percentage", 0);
      let selectedTaxIds = normalizeTaxIds(selected_tax_ids);
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
        const billableTotalPrice = it.is_complimentary ? 0 : price * Number(it.quantity);
        subtotal += billableTotalPrice;
        return { ...it, price, total_price: billableTotalPrice };
      });

      let taxAmount = 0;
      let total = subtotal;
      let taxBreakup = {};
      let totalTaxAmount = 0;
      if (selectedTaxIds.length > 0) {
        const tx = await computeTaxesFromSelection(client, subtotal, selectedTaxIds);
        selectedTaxIds = tx.selectedTaxIds;
        taxBreakup = tx.taxBreakup;
        totalTaxAmount = Number(tx.totalTaxAmount || 0);
        taxPercentage = Number(tx.taxPercentage || 0);
        taxAmount = totalTaxAmount;
        total = subtotal + taxAmount;
      } else {
        const c = computeTax(subtotal, taxPercentage);
        taxAmount = Number(c.taxAmount || 0);
        total = Number(c.total || 0);
        taxBreakup = taxPercentage > 0 ? { Tax: taxAmount } : {};
        totalTaxAmount = taxAmount;
      }

      const inserted = await client.query(
        `
        INSERT INTO orders (
          id, order_number, order_type, status, table_id,
          guest_name, guest_phone, guest_address,
          tax_percentage, tax_amount, total_amount, selected_tax_ids, tax_breakup, total_tax_amount,
          kot_sent_at
        )
        VALUES ($1, $2, $3, 'kot_sent', $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, NOW())
        RETURNING
          id, order_number, order_type, status, table_id,
          guest_name, guest_phone, guest_address,
          tax_percentage, tax_amount, selected_tax_ids, tax_breakup, total_tax_amount,
          total_amount, total_cost, total_profit,
          kot_sent_at,
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
          JSON.stringify(selectedTaxIds),
          JSON.stringify(taxBreakup),
          totalTaxAmount,
        ]
      );

      for (const it of prepared) {
        await client.query(
          `
          INSERT INTO order_items (
            id, order_id, variant_id, quantity, price, total_price, cost_price, profit, is_complimentary
          )
          VALUES ($1, $2, $3, $4, $5, $6, 0, 0, $7)
          `,
          [randomUUID(), orderId, it.variant_id, it.quantity, it.price, it.total_price, Boolean(it.is_complimentary)]
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
  const { table_id, items, guest_name, guest_phone, guest_address, tax_percentage, selected_tax_ids } = req.body || {};

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
        "SELECT id, order_type, status, table_id, tax_percentage, selected_tax_ids, discount_amount FROM orders WHERE id = $1 LIMIT 1 FOR UPDATE",
        [id]
      );
      if (ord.rowCount === 0) {
        const err = new Error("Order not found.");
        err.statusCode = 404;
        throw err;
      }
      const status = String(ord.rows[0].status || "").toLowerCase();
      if (status === "served" || status === "completed" || status === "cancelled") {
        const err = new Error("Order cannot be edited after served");
        err.statusCode = 400;
        throw err;
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
      const selectedTaxIds = selected_tax_ids !== undefined
        ? normalizeTaxIds(selected_tax_ids)
        : normalizeTaxIds(ord.rows[0]?.selected_tax_ids);
      const guestName = toNullableText(guest_name, 160);
      const guestPhone = toNullableText(guest_phone, 40);
      const guestAddress = toNullableText(guest_address);

      let subtotal = 0;

      // Replace items when payload includes items[]
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

        await client.query("DELETE FROM order_items WHERE order_id = $1", [id]);
        for (const it of normalized) {
          const price = Number(prices.get(it.variant_id) || 0);
          const totalPrice = it.is_complimentary ? 0 : price * Number(it.quantity);

          await client.query(
            `
            INSERT INTO order_items (
              id, order_id, variant_id, quantity, price, total_price, cost_price, profit, is_complimentary
            )
            VALUES ($1, $2, $3, $4, $5, $6, 0, 0, $7)
            `,
            [randomUUID(), id, it.variant_id, it.quantity, price, totalPrice, Boolean(it.is_complimentary)]
          );
        }
      }

      // Always recompute subtotal from DB (source of truth)
      const dbItems = await client.query(
        `
        SELECT id, variant_id, quantity, price, total_price, is_complimentary
        FROM order_items
        WHERE order_id = $1
        `,
        [id]
      );
      if (dbItems.rowCount === 0) {
        const err = new Error("Order has no items.");
        err.statusCode = 400;
        throw err;
      }
      for (const it of dbItems.rows || []) {
        if (Boolean(it.is_complimentary)) continue;
        subtotal += Number(it.total_price || Number(it.price || 0) * Number(it.quantity || 0));
      }

      let taxAmount = 0;
      let total = subtotal;
      let outTaxPercentage = Number(taxPercentage || 0);
      let outSelectedTaxIds = selectedTaxIds;
      let taxBreakup = {};
      let totalTaxAmount = 0;
      if (outSelectedTaxIds.length > 0) {
        const tx = await computeTaxesFromSelection(client, subtotal, outSelectedTaxIds);
        outSelectedTaxIds = tx.selectedTaxIds;
        outTaxPercentage = Number(tx.taxPercentage || 0);
        taxBreakup = tx.taxBreakup;
        totalTaxAmount = Number(tx.totalTaxAmount || 0);
        taxAmount = totalTaxAmount;
        total = subtotal + taxAmount;
      } else {
        const c = computeTax(subtotal, outTaxPercentage);
        taxAmount = Number(c.taxAmount || 0);
        total = Number(c.total || 0);
        taxBreakup = outTaxPercentage > 0 ? { Tax: taxAmount } : {};
        totalTaxAmount = taxAmount;
      }

      // Recalculate costing (recipes only) - DO NOT deduct stock here
      let totalCost = 0;
      for (const it of dbItems.rows || []) {
        const qty = Number(it.quantity);
        const totalPrice = Number(it.total_price);

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

        const itemProfit = totalPrice - itemCost;
        totalCost += itemCost;

        await client.query(
          `
          UPDATE order_items
          SET cost_price = $1,
              profit = $2
          WHERE id = $3
          `,
          [itemCost, itemProfit, it.id]
        );
      }

      // Profit should reflect net revenue (discount reduces profit, tip does not affect profit)
      const discountAmount = Number(ord.rows[0]?.discount_amount || 0);
      const netRevenue = total - Math.max(0, discountAmount);
      const totalProfit = netRevenue - totalCost;

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
            selected_tax_ids = $8::jsonb,
            tax_breakup = $9::jsonb,
            total_tax_amount = $10,
            total_cost = $11,
            total_profit = $12,
            updated_at = NOW()
        WHERE id = $13
        RETURNING
          id, order_number, order_type, status, table_id,
          guest_name, guest_phone, guest_address,
          tax_percentage, tax_amount, selected_tax_ids, tax_breakup, total_tax_amount,
          total_amount, total_cost, total_profit,
          created_at, updated_at
        `,
        [
          orderType === "dine_in" ? tableId : null,
          guestName,
          guestPhone,
          guestAddress,
          outTaxPercentage,
          taxAmount,
          total,
          JSON.stringify(outSelectedTaxIds),
          JSON.stringify(taxBreakup),
          totalTaxAmount,
          totalCost,
          totalProfit,
          id,
        ]
      );

      return out.rows[0];
    });

    return res.status(200).json({ message: "Order updated.", data: updated });
  } catch (error) {
    logError("PUT /api/orders/:id", error);
    return res.status(error.statusCode || 500).json({ message: error?.message || "Failed to update order." });
  }
};

const updateOrderGuest = async (req, res) => {
  const { id } = req.params;
  const { guest_name, guest_phone, guest_address } = req.body || {};

  try {
    const updated = await withTenantTx(req.tenantDB, async (client) => {
      const ord = await client.query("SELECT id, status FROM orders WHERE id = $1 LIMIT 1 FOR UPDATE", [id]);
      if (ord.rowCount === 0) {
        const err = new Error("Order not found.");
        err.statusCode = 404;
        throw err;
      }

      const status = String(ord.rows[0]?.status || "").toLowerCase();
      if (status === "completed") {
        const err = new Error("Cannot update guest after order is completed");
        err.statusCode = 400;
        throw err;
      }

      const guestName = toNullableText(guest_name, 160);
      const guestPhone = toNullableText(guest_phone, 40);
      const guestAddress = toNullableText(guest_address);

      const out = await client.query(
        `
        UPDATE orders
        SET guest_name = $1,
            guest_phone = $2,
            guest_address = $3,
            updated_at = NOW()
        WHERE id = $4
        RETURNING
          id, order_number, order_type, status, table_id,
          guest_name, guest_phone, guest_address,
          tax_percentage, tax_amount, selected_tax_ids, tax_breakup, total_tax_amount,
          total_amount, total_cost, total_profit,
          payment_status,
          kot_sent_at, served_at, completed_at,
          created_at, updated_at
        `,
        [guestName, guestPhone, guestAddress, id]
      );

      return out.rows[0];
    });

    return res.status(200).json({ message: "Guest details updated.", data: updated });
  } catch (error) {
    logError("PATCH /api/orders/:id/guest", error);
    return res.status(error.statusCode || 500).json({ message: error?.message || "Failed to update guest details." });
  }
};

const cancelOrder = async (req, res) => {
  const { id } = req.params;
  const { reason } = req.body || {};

  try {
    const out = await withTenantTx(req.tenantDB, async (client) => {
      const ord = await client.query(
        "SELECT id, status FROM orders WHERE id = $1 LIMIT 1 FOR UPDATE",
        [id]
      );
      if (ord.rowCount === 0) {
        const err = new Error("Order not found.");
        err.statusCode = 404;
        throw err;
      }
      const status = String(ord.rows[0]?.status || "").toLowerCase();
      if (status === "served" || status === "completed") {
        const err = new Error("Order cannot be cancelled after served");
        err.statusCode = 400;
        throw err;
      }
      if (status === "cancelled") {
        return { id, status: "cancelled" };
      }

      // Cancel all items (before served) - no stock impact
      await client.query(
        `
        UPDATE order_items
        SET status = 'cancelled'
        WHERE order_id = $1
          AND COALESCE(status, 'active') = 'active'
        `,
        [id]
      );

      await client.query(
        `
        INSERT INTO order_adjustments (
          id, order_id, order_item_id, type, reason, quantity, amount_impact, cost_impact, created_by, created_at
        ) VALUES ($1, $2, NULL, 'cancel_before_served', $3, 0, 0, 0, $4, NOW())
        `,
        [
          randomUUID(),
          id,
          String(reason || "").trim() || null,
          req.user?.id ? String(req.user.id) : null,
        ]
      );

      const updated = await client.query(
        `
        UPDATE orders
        SET status = 'cancelled',
            subtotal = 0,
            tax_amount = 0,
            total_amount = 0,
            total_cost = 0,
            total_profit = 0,
            payment_status = 'unpaid',
            updated_at = NOW()
        WHERE id = $1
        RETURNING id, order_number, status, subtotal, tax_amount, total_amount, total_cost, total_profit, payment_status, updated_at
        `,
        [id]
      );

      return updated.rows[0];
    });

    return res.status(200).json({
      message: out?.status === "cancelled" ? "Order cancelled." : "Order cancelled.",
      data: out,
    });
  } catch (error) {
    logError("POST /api/orders/:id/cancel", error);
    return res.status(error.statusCode || 500).json({ message: error?.message || "Failed to cancel order." });
  }
};

const voidOrderItem = async (req, res) => {
  const { id } = req.params;
  const { order_item_id, reason } = req.body || {};
  const itemId = String(order_item_id || "").trim();
  const reasonText = String(reason || "").trim();
  if (!itemId) return res.status(400).json({ message: "order_item_id is required." });
  if (!reasonText) return res.status(400).json({ message: "reason is required." });

  try {
    const out = await withTenantTx(req.tenantDB, async (client) => {
      const ord = await client.query(
        "SELECT id, status, payment_status, completed_at, tax_percentage, selected_tax_ids, discount_amount, total_cost FROM orders WHERE id = $1 LIMIT 1 FOR UPDATE",
        [id]
      );
      if (ord.rowCount === 0) {
        const err = new Error("Order not found.");
        err.statusCode = 404;
        throw err;
      }
      const o = ord.rows[0];
      const status = String(o.status || "").toLowerCase();
      const ps = String(o.payment_status || "unpaid").toLowerCase();
      if (status !== "served" || ps === "paid" || o.completed_at) {
        const err = new Error("Order cannot be corrected after completion");
        err.statusCode = 400;
        throw err;
      }

      const it = await client.query(
        "SELECT id, quantity, total_price, cost_price, is_voided, status, is_complimentary FROM order_items WHERE id = $1 AND order_id = $2 LIMIT 1 FOR UPDATE",
        [itemId, id]
      );
      if (it.rowCount === 0) {
        const err = new Error("Order item not found.");
        err.statusCode = 404;
        throw err;
      }
      if (it.rows[0].is_voided || String(it.rows[0].status || "active") !== "active") {
        const err = new Error("Item already voided.");
        err.statusCode = 409;
        throw err;
      }

      await client.query(
        "UPDATE order_items SET status = 'voided', is_voided = TRUE, void_reason = $1, voided_at = NOW() WHERE id = $2",
        [
          reasonText,
          itemId,
        ]
      );

      await client.query(
        `
        INSERT INTO order_adjustments (id, order_id, order_item_id, type, reason, quantity, amount_impact, cost_impact, created_by, created_at)
        VALUES ($1, $2, $3, 'void_after_served', $4, $5, $6, $7, $8, NOW())
        `,
        [
          randomUUID(),
          id,
          itemId,
          reasonText,
          Number(it.rows[0].quantity || 0),
          Number(it.rows[0].total_price || 0),
          Number(it.rows[0].cost_price || 0),
          req.user?.id ? String(req.user.id) : null,
        ]
      );

      const taxPercentage = Number(o.tax_percentage || 0);
      const discountAmount = Number(o.discount_amount || 0);
      const totalCost = Number(o.total_cost || 0); // keep cost as-is
      const { subtotal, taxAmount, total, totalProfit, selectedTaxIds, taxBreakup, totalTaxAmount, taxPercentage: nextTaxPercentage } =
        await recalcOrderTotalsForNonVoidedItems(client, id, {
        taxPercentage,
        selectedTaxIds: o.selected_tax_ids,
        totalCost,
        discountAmount,
      });

      const updated = await client.query(
        `
        UPDATE orders
        SET subtotal = $1,
            tax_amount = $2,
            total_amount = $3,
            selected_tax_ids = $4::jsonb,
            tax_breakup = $5::jsonb,
            total_tax_amount = $6,
            tax_percentage = $7,
            total_profit = $8,
            updated_at = NOW()
        WHERE id = $9
        RETURNING id, order_number, status, payment_status, subtotal, tax_amount, total_amount, total_cost, total_profit, selected_tax_ids, tax_breakup, total_tax_amount, updated_at
        `,
        [
          subtotal,
          taxAmount,
          total,
          JSON.stringify(selectedTaxIds || []),
          JSON.stringify(taxBreakup || {}),
          Number(totalTaxAmount || 0),
          Number(nextTaxPercentage || 0),
          totalProfit,
          id,
        ]
      );
      return updated.rows[0];
    });

    return res.status(200).json({ message: "Item voided.", data: out });
  } catch (error) {
    logError("POST /api/orders/:id/void-item", error);
    return res.status(error.statusCode || 500).json({ message: error?.message || "Failed to void item." });
  }
};

const replaceOrderItem = async (req, res) => {
  const { id } = req.params;
  const { order_item_id, new_variant_id, quantity, reason } = req.body || {};
  const itemId = String(order_item_id || "").trim();
  const newVariantId = String(new_variant_id || "").trim();
  const qty = Number(quantity);
  const reasonText = String(reason || "").trim();
  if (!itemId) return res.status(400).json({ message: "order_item_id is required." });
  if (!newVariantId) return res.status(400).json({ message: "new_variant_id is required." });
  if (!Number.isFinite(qty) || qty <= 0) return res.status(400).json({ message: "quantity must be > 0." });
  if (!reasonText) return res.status(400).json({ message: "reason is required." });

  try {
    const out = await withTenantTx(req.tenantDB, async (client) => {
      const ord = await client.query(
        "SELECT id, status, payment_status, completed_at, tax_percentage, selected_tax_ids, discount_amount, total_cost FROM orders WHERE id = $1 LIMIT 1 FOR UPDATE",
        [id]
      );
      if (ord.rowCount === 0) {
        const err = new Error("Order not found.");
        err.statusCode = 404;
        throw err;
      }
      const o = ord.rows[0];
      const status = String(o.status || "").toLowerCase();
      const ps = String(o.payment_status || "unpaid").toLowerCase();
      if (status !== "served" || ps === "paid" || o.completed_at) {
        const err = new Error("Order cannot be corrected after completion");
        err.statusCode = 400;
        throw err;
      }

      const it = await client.query(
        "SELECT id, variant_id, quantity, total_price, is_voided, status, is_complimentary FROM order_items WHERE id = $1 AND order_id = $2 LIMIT 1 FOR UPDATE",
        [itemId, id]
      );
      if (it.rowCount === 0) {
        const err = new Error("Order item not found.");
        err.statusCode = 404;
        throw err;
      }
      if (it.rows[0].is_voided || String(it.rows[0].status || "active") !== "active") {
        const err = new Error("Only active items can be replaced.");
        err.statusCode = 409;
        throw err;
      }

      // Auto-void original item (single replacement action)
      await client.query(
        "UPDATE order_items SET status = 'voided', is_voided = TRUE, void_reason = $1, voided_at = NOW() WHERE id = $2",
        [reasonText, itemId]
      );

      const prices = await fetchVariantPrices(client, [newVariantId]);
      if (!prices.has(newVariantId)) {
        const err = new Error("Replacement variant does not exist.");
        err.statusCode = 400;
        throw err;
      }
      const newPrice = Number(prices.get(newVariantId) || 0);
      const isComplimentary = Boolean(it.rows[0]?.is_complimentary);
      const newTotalPrice = isComplimentary ? 0 : newPrice * qty;

      // Add replacement item; keep complimentary flag from original item.
      const newItemId = randomUUID();
      await client.query(
        `
        INSERT INTO order_items (id, order_id, variant_id, quantity, price, total_price, cost_price, profit, is_voided, status, is_complimentary)
        VALUES ($1, $2, $3, $4, $5, $6, 0, 0, FALSE, 'replaced', $7)
        `,
        [newItemId, id, newVariantId, qty, newPrice, newTotalPrice, isComplimentary]
      );

      // Deduct stock again + snapshot consumption + compute replacement cost
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
        [newVariantId]
      );
      if (recipe.rowCount === 0) {
        const err = new Error("Recipe not found for replacement item.");
        err.statusCode = 400;
        throw err;
      }

      let replacementCost = 0;
      for (const ing of recipe.rows) {
        const purchasePrice = Number(ing.purchase_price || 0);
        if (!Number.isFinite(purchasePrice) || purchasePrice < 0) {
          const err = new Error(`Invalid purchase price for ${ing.raw_material_name}`);
          err.statusCode = 400;
          throw err;
        }

        const consumptionQty = toConsumptionQty({
          recipeQty: ing.recipe_quantity,
          recipeUnitId: ing.recipe_unit_id,
          qtyMultiplier: qty,
          consumptionUnitId: ing.consumption_unit_id,
          purchaseUnitId: ing.purchase_unit_id,
          conversionFactor: ing.conversion_factor,
          rawMaterialName: ing.raw_material_name,
        });

        const factor = Number(ing.conversion_factor || 1);
        const purchaseQty = consumptionQty > 0 ? consumptionQty / factor : 0;
        replacementCost += purchaseQty * purchasePrice;

        if (consumptionQty > 0) {
          if (!ing.consumption_unit_id) {
            const err = new Error(`Consumption unit not configured for ${ing.raw_material_name}`);
            err.statusCode = 400;
            throw err;
          }
          await client.query(
            `
            INSERT INTO order_item_consumptions (id, order_id, order_item_id, raw_material_id, quantity_used, created_at)
            VALUES ($1, $2, $3, $4, $5, NOW())
            `,
            [randomUUID(), id, newItemId, ing.raw_material_id, consumptionQty]
          );
        }
      }

      await deductStockByVariantWithClient(client, newVariantId, { multiplier: qty });

      // replacement item profit = revenue(actual) - cost
      await client.query("UPDATE order_items SET cost_price = $1, profit = $2 WHERE id = $3", [
        replacementCost,
        newTotalPrice - replacementCost,
        newItemId,
      ]);

      const nextTotalCost = Number(o.total_cost || 0) + replacementCost;

      const taxPercentage = Number(o.tax_percentage || 0);
      const discountAmount = Number(o.discount_amount || 0);
      const { subtotal, taxAmount, total, totalProfit, selectedTaxIds, taxBreakup, totalTaxAmount, taxPercentage: nextTaxPercentage } =
        await recalcOrderTotalsForNonVoidedItems(client, id, {
        taxPercentage,
        selectedTaxIds: o.selected_tax_ids,
        totalCost: nextTotalCost,
        discountAmount,
      });

      await client.query(
        `
        INSERT INTO order_adjustments (id, order_id, order_item_id, type, reason, quantity, amount_impact, cost_impact, created_by, created_at)
        VALUES ($1, $2, $3, 'replacement', $4, $5, $6, $7, $8, NOW())
        `,
        [
          randomUUID(),
          id,
          itemId,
          reasonText,
          qty,
          newTotalPrice,
          replacementCost,
          req.user?.id ? String(req.user.id) : null,
        ]
      );

      const updated = await client.query(
        `
        UPDATE orders
        SET subtotal = $1,
            tax_amount = $2,
            total_amount = $3,
            selected_tax_ids = $4::jsonb,
            tax_breakup = $5::jsonb,
            total_tax_amount = $6,
            tax_percentage = $7,
            total_cost = $8,
            total_profit = $9,
            updated_at = NOW()
        WHERE id = $10
        RETURNING id, order_number, status, payment_status, subtotal, tax_amount, total_amount, total_cost, total_profit, selected_tax_ids, tax_breakup, total_tax_amount, updated_at
        `,
        [
          subtotal,
          taxAmount,
          total,
          JSON.stringify(selectedTaxIds || []),
          JSON.stringify(taxBreakup || {}),
          Number(totalTaxAmount || 0),
          Number(nextTaxPercentage || 0),
          nextTotalCost,
          totalProfit,
          id,
        ]
      );

      return updated.rows[0];
    });

    return res.status(200).json({ message: "Replacement created.", data: out });
  } catch (error) {
    logError("POST /api/orders/:id/replace-item", error);
    return res.status(error.statusCode || 500).json({ message: error?.message || "Failed to replace item." });
  }
};

const correctOrder = async (req, res) => {
  const { id } = req.params;
  const { items } = req.body || {};

  let normalized;
  try {
    normalized = normalizeItems(items);
  } catch (e) {
    return res.status(e.statusCode || 400).json({ message: e.message });
  }

  try {
    const updated = await withTenantTx(req.tenantDB, async (client) => {
      const ord = await client.query(
        `
        SELECT id, status, payment_status, completed_at, tax_percentage, selected_tax_ids, discount_amount, order_type, table_id
        FROM orders
        WHERE id = $1
        LIMIT 1
        FOR UPDATE
        `,
        [id]
      );
      if (ord.rowCount === 0) {
        const err = new Error("Order not found.");
        err.statusCode = 404;
        throw err;
      }

      const o = ord.rows[0];
      const status = String(o.status || "").toLowerCase();
      const paymentStatus = String(o.payment_status || "unpaid").toLowerCase();
      if (status !== "served" || paymentStatus === "paid" || o.completed_at) {
        const err = new Error("Order cannot be corrected after completion");
        err.statusCode = 400;
        throw err;
      }

      // Reverse old consumption snapshot (increase stock back)
      const oldCons = await client.query(
        `
        SELECT
          c.raw_material_id,
          c.quantity_used,
          rm.consumption_unit_id
        FROM order_item_consumptions c
        JOIN raw_materials rm ON rm.id = c.raw_material_id
        WHERE c.order_id = $1
        `,
        [id]
      );

      for (const r of oldCons.rows || []) {
        const unitId = String(r.consumption_unit_id || "").trim();
        if (!unitId) {
          const err = new Error("Consumption unit not configured for one or more raw materials.");
          err.statusCode = 400;
          throw err;
        }
        await addStockWithClient(client, {
          raw_material_id: r.raw_material_id,
          quantity: Number(r.quantity_used || 0),
          unit_id: unitId,
        });
      }

      // Replace order_items
      const variantIds = normalized.map((x) => x.variant_id);
      const prices = await fetchVariantPrices(client, variantIds);
      for (const it of normalized) {
        if (!prices.has(it.variant_id)) {
          const err = new Error("One or more variants do not exist.");
          err.statusCode = 400;
          throw err;
        }
      }

      await client.query("DELETE FROM order_items WHERE order_id = $1", [id]);

      const insertedItems = [];
      for (const it of normalized) {
        const price = Number(prices.get(it.variant_id) || 0);
        const totalPrice = it.is_complimentary ? 0 : price * Number(it.quantity);
        const itemId = randomUUID();
        await client.query(
          `
          INSERT INTO order_items (
            id, order_id, variant_id, quantity, price, total_price, cost_price, profit, is_complimentary
          )
          VALUES ($1, $2, $3, $4, $5, $6, 0, 0, $7)
          `,
          [itemId, id, it.variant_id, it.quantity, price, totalPrice, Boolean(it.is_complimentary)]
        );
        insertedItems.push({
          id: itemId,
          variant_id: it.variant_id,
          quantity: it.quantity,
          total_price: totalPrice,
          is_complimentary: Boolean(it.is_complimentary),
        });
      }

      // Recalculate billing from new items
      const subtotal = insertedItems.reduce((s, it) => {
        if (Boolean(it.is_complimentary)) return s;
        return s + Number(it.total_price || 0);
      }, 0);
      let taxPercentage = Number(o.tax_percentage || 0);
      let selectedTaxIds = normalizeTaxIds(o.selected_tax_ids);
      let taxBreakup = {};
      let totalTaxAmount = 0;
      let taxAmount = 0;
      let total = subtotal;
      if (selectedTaxIds.length > 0) {
        const tx = await computeTaxesFromSelection(client, subtotal, selectedTaxIds);
        selectedTaxIds = tx.selectedTaxIds;
        taxBreakup = tx.taxBreakup;
        totalTaxAmount = Number(tx.totalTaxAmount || 0);
        taxPercentage = Number(tx.taxPercentage || 0);
        taxAmount = totalTaxAmount;
        total = subtotal + taxAmount;
      } else {
        const c = computeTax(subtotal, taxPercentage);
        taxAmount = Number(c.taxAmount || 0);
        total = Number(c.total || 0);
        taxBreakup = taxPercentage > 0 ? { Tax: taxAmount } : {};
        totalTaxAmount = taxAmount;
      }

      // Delete old snapshot rows (after reversing)
      await client.query("DELETE FROM order_item_consumptions WHERE order_id = $1", [id]);

      // Apply new consumption: cost calc + deduct stock + insert snapshot
      let totalCost = 0;
      for (const it of insertedItems) {
        const qty = Number(it.quantity);
        const totalPrice = Number(it.total_price);

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
          const purchasePrice = Number(ing.purchase_price || 0);
          if (!Number.isFinite(purchasePrice) || purchasePrice < 0) {
            const err = new Error(`Invalid purchase price for ${ing.raw_material_name}`);
            err.statusCode = 400;
            throw err;
          }

          const consumptionQty = toConsumptionQty({
            recipeQty: ing.recipe_quantity,
            recipeUnitId: ing.recipe_unit_id,
            qtyMultiplier: qty,
            consumptionUnitId: ing.consumption_unit_id,
            purchaseUnitId: ing.purchase_unit_id,
            conversionFactor: ing.conversion_factor,
            rawMaterialName: ing.raw_material_name,
          });

          if (consumptionQty > 0) {
            if (!ing.consumption_unit_id) {
              const err = new Error(`Consumption unit not configured for ${ing.raw_material_name}`);
              err.statusCode = 400;
              throw err;
            }

            // For costing, convert consumption -> purchase if needed
            const factor = Number(ing.conversion_factor || 1);
            let purchaseQty;
            if (ing.purchase_unit_id && ing.recipe_unit_id === ing.purchase_unit_id) {
              // recipe unit was purchase => req qty is purchase qty; consumptionQty derived above
              purchaseQty = Number(ing.recipe_quantity) * qty;
            } else {
              // recipe unit is consumption => purchase_qty = consumption_qty / factor
              purchaseQty = consumptionQty / factor;
            }
            itemCost += purchaseQty * purchasePrice;

            await client.query(
              `
              INSERT INTO order_item_consumptions (
                id, order_id, order_item_id, raw_material_id, quantity_used, created_at
              )
              VALUES ($1, $2, $3, $4, $5, NOW())
              `,
              [randomUUID(), id, it.id, ing.raw_material_id, consumptionQty]
            );
          }
        }

        // Deduct stock for this variant
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

      // Profit should reflect net revenue (discount reduces profit, tip does not affect profit)
      const discountAmount = Number(o.discount_amount || 0);
      const netRevenue = total - Math.max(0, discountAmount);
      const totalProfit = netRevenue - totalCost;

      const out = await client.query(
        `
        UPDATE orders
        SET tax_amount = $1,
            total_amount = $2,
            selected_tax_ids = $3::jsonb,
            tax_breakup = $4::jsonb,
            total_tax_amount = $5,
            tax_percentage = $6,
            total_cost = $7,
            total_profit = $8,
            updated_at = NOW()
        WHERE id = $9
        RETURNING id, order_number, status, payment_status, tax_amount, total_amount, total_cost, total_profit, selected_tax_ids, tax_breakup, total_tax_amount, updated_at
        `,
        [
          taxAmount,
          total,
          JSON.stringify(selectedTaxIds || []),
          JSON.stringify(taxBreakup || {}),
          totalTaxAmount,
          taxPercentage,
          totalCost,
          totalProfit,
          id,
        ]
      );

      return out.rows[0];
    });

    return res.status(200).json({ message: "Order corrected successfully", data: updated });
  } catch (error) {
    logError("PUT /api/orders/:id/correct", error);
    return res.status(error.statusCode || 500).json({ message: error?.message || "Failed to correct order." });
  }
};

const listOrders = async (req, res) => {
  try {
    const params = parseListParams(req.query, { defaultSortBy: "created_at", defaultOrder: "DESC" });
    const { sortBy, order } = pickSort(params, ["created_at", "order_number", "status", "total_amount"], "created_at");

    const statusFilter = String(req.query?.status || "").trim().toLowerCase();
    const allowedStatuses = new Set(["created", "kot_sent", "preparing", "ready", "served", "completed", "cancelled"]);
    const allowedStatusGroups = new Set(["all", "active", "completed", "cancelled"]);
    const status = allowedStatuses.has(statusFilter) ? statusFilter : "";
    const statusGroup = allowedStatusGroups.has(statusFilter) ? statusFilter : "";

    const whereParts = [];
    const args = [];
    const range = String(req.query?.range || "day").trim().toLowerCase();
    const allowedRanges = new Set(["day", "week", "month"]);
    const rangeStart = startOfRange(allowedRanges.has(range) ? range : "day");
    args.push(rangeStart);
    whereParts.push(`o.created_at >= $${args.length}`);
    if (params.search) {
      args.push(`%${params.search}%`);
      whereParts.push(`(o.order_number ILIKE $${args.length} OR t.name ILIKE $${args.length})`);
    }
    if (status) {
      args.push(status);
      whereParts.push(`o.status = $${args.length}`);
    } else if (statusGroup === "active") {
      whereParts.push(`o.status NOT IN ('completed', 'cancelled')`);
    } else if (statusGroup === "completed") {
      whereParts.push(`o.status = 'completed'`);
    } else if (statusGroup === "cancelled") {
      whereParts.push(`o.status = 'cancelled'`);
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
        o.served_at,
        o.completed_at,
        o.discount_amount,
        o.tip_amount,
        o.payment_status,
        o.guest_name,
        o.guest_phone,
        o.guest_address,
        o.tax_percentage,
        o.tax_amount,
        o.selected_tax_ids,
        o.tax_breakup,
        o.total_tax_amount,
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

const listSelectableOrders = async (req, res) => {
  try {
    const mode = String(req.query?.mode || "").trim().toLowerCase(); // cancel | void | replacement
    const allowedModes = new Set(["cancel", "void", "replacement"]);
    if (!allowedModes.has(mode)) return res.status(400).json({ message: "Invalid mode." });
    const scope = String(req.query?.scope || "").trim().toLowerCase(); // active | cancelled (cancel mode only)

    const params = parseListParams(req.query, { defaultSortBy: "created_at", defaultOrder: "DESC" });

    const range = String(req.query?.range || "day").trim().toLowerCase();
    const allowedRanges = new Set(["day", "week", "month"]);
    const rangeStart = startOfRange(allowedRanges.has(range) ? range : "day");

    const whereParts = ["o.created_at >= $1"];
    const args = [rangeStart];

    if (params.search) {
      args.push(`%${params.search}%`);
      whereParts.push(`(o.order_number ILIKE $${args.length})`);
    }

    if (mode === "cancel") {
      if (scope === "cancelled") {
        whereParts.push(`o.status = 'cancelled'`);
      } else {
        whereParts.push(`o.status NOT IN ('served', 'completed', 'cancelled')`);
      }
    } else {
      whereParts.push(`o.status = 'served'`);
      whereParts.push(`COALESCE(o.payment_status, 'unpaid') <> 'paid'`);
      whereParts.push(`o.completed_at IS NULL`);
    }

    const where = `WHERE ${whereParts.join(" AND ")}`;

    const totalQ = await req.tenantDB.query(
      `
      SELECT COUNT(*)::int AS total
      FROM orders o
      ${where}
      `,
      args
    );
    const total = totalQ.rows[0]?.total ?? 0;

    const dataArgs = [...args, params.limit, params.offset];
    const limitIdx = dataArgs.length - 1;
    const offsetIdx = dataArgs.length;

    const dataQ = await req.tenantDB.query(
      `
      SELECT
        o.id AS order_id,
        o.order_number,
        o.created_at,
        o.order_type,
        o.status,
        o.payment_status,
        o.table_id,
        t.name AS table_name,
        o.guest_name,
        o.total_amount
      FROM orders o
      LEFT JOIN tables t ON t.id = o.table_id
      ${where}
      ORDER BY o.created_at DESC
      LIMIT $${limitIdx} OFFSET $${offsetIdx}
      `,
      dataArgs
    );

    return res.status(200).json({
      orders: dataQ.rows || [],
      pagination: buildPagination({ total, page: params.page, limit: params.limit }),
    });
  } catch (error) {
    logError("GET /api/orders/selectable", error);
    return res.status(500).json({ message: "Failed to fetch selectable orders." });
  }
};

const listLiveOrders = async (req, res) => {
  try {
    const typeFilter = String(req.query?.type || "all").trim().toLowerCase();
    const allowedTypes = new Set(["all", "dine_in", "delivery", "takeaway"]);
    const type = allowedTypes.has(typeFilter) ? typeFilter : "all";

    const params = parseListParams(req.query, { defaultSortBy: "created_at", defaultOrder: "DESC" });

    // Live orders include full lifecycle up to completion (exclude cancelled)
    const statuses = ["created", "kot_sent", "preparing", "ready", "served", "completed"];
    const whereParts = ["o.status = ANY($1::text[])"];
    const args = [statuses];
    const range = String(req.query?.range || "day").trim().toLowerCase();
    const allowedRanges = new Set(["day", "week", "month"]);
    const rangeStart = startOfRange(allowedRanges.has(range) ? range : "day");
    args.push(rangeStart);
    whereParts.push(`o.created_at >= $${args.length}`);
    if (type !== "all") {
      args.push(type);
      whereParts.push(`o.order_type = $${args.length}`);
    }
    const where = `WHERE ${whereParts.join(" AND ")}`;

    const totalResult = await req.tenantDB.query(
      `
      SELECT COUNT(*)::int AS total
      FROM orders o
      LEFT JOIN tables t ON t.id = o.table_id
      ${where}
      `,
      args
    );
    const total = totalResult.rows[0]?.total ?? 0;

    const dataArgs = [...args, params.limit, params.offset];
    const limitIdx = dataArgs.length - 1;
    const offsetIdx = dataArgs.length;

    const ordersQ = await req.tenantDB.query(
      `
      SELECT
        o.id AS order_id,
        o.order_number,
        o.order_type,
        o.status,
        o.kot_sent_at,
        o.created_at,
        o.completed_at,
        o.discount_amount,
        o.tip_amount,
        o.payment_status,
        t.name AS table_name
      FROM orders o
      LEFT JOIN tables t ON t.id = o.table_id
      ${where}
      ORDER BY o.created_at DESC
      LIMIT $${limitIdx} OFFSET $${offsetIdx}
      `,
      dataArgs
    );

    const orders = ordersQ.rows || [];
    if (orders.length === 0)
      return res.status(200).json({ data: [], pagination: buildPagination({ total, page: params.page, limit: params.limit }) });

    const orderIds = orders.map((o) => o.order_id);

    const itemsQ = await req.tenantDB.query(
      `
      SELECT
        oi.order_id,
        i.name AS item_name,
        v.name AS variant_name,
        oi.quantity,
        oi.status,
        oi.is_voided,
        oi.voided_at,
        oi.is_complimentary
      FROM order_items oi
      JOIN menu_item_variants v ON v.id = oi.variant_id
      JOIN menu_items i ON i.id = v.item_id
      WHERE oi.order_id = ANY($1::uuid[])
      ORDER BY oi.order_id ASC, i.name ASC, v.name ASC
      `,
      [orderIds]
    );

    const itemsByOrder = new Map();
    for (const it of itemsQ.rows || []) {
      const arr = itemsByOrder.get(it.order_id) || [];
      arr.push({
        item_name: it.item_name,
        variant_name: it.variant_name,
        quantity: it.quantity,
        status: it.status,
        is_voided: it.is_voided,
        voided_at: it.voided_at,
        is_complimentary: it.is_complimentary,
      });
      itemsByOrder.set(it.order_id, arr);
    }

    return res.status(200).json({
      data: orders.map((o) => ({
        order_id: o.order_id,
        order_number: o.order_number,
        order_type: o.order_type,
        status: o.status,
        kot_sent_at: o.kot_sent_at,
        created_at: o.created_at,
        completed_at: o.completed_at,
        discount_amount: o.discount_amount,
        tip_amount: o.tip_amount,
        payment_status: o.payment_status,
        table_name: o.table_name,
        items: itemsByOrder.get(o.order_id) || [],
      })),
      pagination: buildPagination({ total, page: params.page, limit: params.limit }),
    });
  } catch (error) {
    logError("GET /api/orders/live", error);
    return res.status(500).json({ message: "Failed to fetch live orders." });
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
        o.served_at,
        o.completed_at,
        o.discount_amount,
        o.tip_amount,
        o.payment_status,
        o.guest_name,
        o.guest_phone,
        o.guest_address,
        o.tax_percentage,
        o.tax_amount,
        o.selected_tax_ids,
        o.tax_breakup,
        o.total_tax_amount,
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
        oi.profit,
        oi.status,
        oi.is_voided,
        oi.void_reason,
        oi.voided_at,
        oi.is_complimentary
      FROM order_items oi
      JOIN menu_item_variants v ON v.id = oi.variant_id
      JOIN menu_items i ON i.id = v.item_id
      WHERE oi.order_id = $1
      ORDER BY i.name ASC, v.name ASC
      `,
      [id]
    );

    const adjustments = await req.tenantDB.query(
      `
      SELECT
        a.id,
        a.type,
        a.reason,
        a.quantity,
        a.amount_impact,
        a.cost_impact,
        a.created_by,
        a.created_at,
        a.order_item_id,
        i.name AS item_name,
        v.name AS variant_name
      FROM order_adjustments a
      LEFT JOIN order_items oi ON oi.id = a.order_item_id
      LEFT JOIN menu_item_variants v ON v.id = oi.variant_id
      LEFT JOIN menu_items i ON i.id = v.item_id
      WHERE a.order_id = $1
      ORDER BY a.created_at DESC
      `,
      [id]
    );

    return res.status(200).json({
      data: {
        ...ord.rows[0],
        items: items.rows,
        adjustments: adjustments.rows || [],
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
        o.kot_sent_at,
        o.served_at,
        o.completed_at,
        o.created_at,
        o.payment_status,
        o.guest_name,
        o.guest_phone,
        o.guest_address,
        o.tax_percentage,
        o.tax_amount,
        o.selected_tax_ids,
        o.tax_breakup,
        o.total_tax_amount,
        o.discount_amount,
        o.tip_amount,
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
        oi.is_complimentary,
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
        "SELECT id, status, tax_percentage, selected_tax_ids, discount_amount, kot_sent_at, served_at, completed_at, payment_status FROM orders WHERE id = $1 LIMIT 1 FOR UPDATE",
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
        const shouldSetCompleted = current === "served" && next === "completed";
        const updated = await client.query(
          `
          UPDATE orders
          SET status = $1,
              kot_sent_at = CASE WHEN $2::boolean THEN COALESCE(kot_sent_at, NOW()) ELSE kot_sent_at END,
              completed_at = CASE WHEN $3::boolean THEN COALESCE(completed_at, NOW()) ELSE completed_at END,
              updated_at = NOW()
          WHERE id = $4
          RETURNING id, order_number, status, kot_sent_at, served_at, completed_at, updated_at
          `,
          [next, shouldSetKot, shouldSetCompleted, id]
        );
        return updated.rows[0];
      }

      // Served finalization logic (execute once, inside same tx)
      const items = await client.query(
        `
        SELECT id, variant_id, quantity, price, total_price, is_complimentary
        FROM order_items
        WHERE order_id = $1
          AND COALESCE(status, 'active') = 'active'
        `,
        [id]
      );
      if (items.rowCount === 0) {
        const err = new Error("Order has no items.");
        err.statusCode = 400;
        throw err;
      }

      let subtotal = 0;
      let totalCost = 0;

      for (const it of items.rows) {
        const qty = Number(it.quantity);
        const totalPrice = Number(it.total_price);
        if (!Boolean(it.is_complimentary)) {
          subtotal += totalPrice;
        }

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

        // Snapshot consumption in consumption unit for correction flow
        for (const ing of recipe.rows) {
          const consumptionQty = toConsumptionQty({
            recipeQty: ing.recipe_quantity,
            recipeUnitId: ing.recipe_unit_id,
            qtyMultiplier: qty,
            consumptionUnitId: ing.consumption_unit_id,
            purchaseUnitId: ing.purchase_unit_id,
            conversionFactor: ing.conversion_factor,
            rawMaterialName: ing.raw_material_name,
          });

          if (consumptionQty > 0) {
            if (!ing.consumption_unit_id) {
              const err = new Error(`Consumption unit not configured for ${ing.raw_material_name}`);
              err.statusCode = 400;
              throw err;
            }
            await client.query(
              `
              INSERT INTO order_item_consumptions (
                id, order_id, order_item_id, raw_material_id, quantity_used, created_at
              )
              VALUES ($1, $2, $3, $4, $5, NOW())
              `,
              [randomUUID(), id, it.id, ing.raw_material_id, consumptionQty]
            );
          }
        }

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

      let taxPercentage = Number(ord.rows[0]?.tax_percentage || 0);
      let selectedTaxIds = normalizeTaxIds(ord.rows[0]?.selected_tax_ids);
      let taxBreakup = {};
      let totalTaxAmount = 0;
      let taxAmount = 0;
      let total = subtotal;
      if (selectedTaxIds.length > 0) {
        const tx = await computeTaxesFromSelection(client, subtotal, selectedTaxIds);
        selectedTaxIds = tx.selectedTaxIds;
        taxBreakup = tx.taxBreakup;
        totalTaxAmount = Number(tx.totalTaxAmount || 0);
        taxPercentage = Number(tx.taxPercentage || 0);
        taxAmount = totalTaxAmount;
        total = subtotal + taxAmount;
      } else {
        const c = computeTax(subtotal, taxPercentage);
        taxAmount = Number(c.taxAmount || 0);
        total = Number(c.total || 0);
        taxBreakup = taxPercentage > 0 ? { Tax: taxAmount } : {};
        totalTaxAmount = taxAmount;
      }
      // Profit should reflect net revenue (discount reduces profit, tip does not affect profit)
      const discountAmount = Number(ord.rows[0]?.discount_amount || 0);
      const netRevenue = total - Math.max(0, discountAmount);
      const totalProfit = netRevenue - totalCost;

      const updated = await client.query(
        `
        UPDATE orders
        SET status = 'served',
            total_amount = $1,
            tax_amount = $2,
            selected_tax_ids = $3::jsonb,
            tax_breakup = $4::jsonb,
            total_tax_amount = $5,
            tax_percentage = $6,
            total_cost = $7,
            total_profit = $8,
            payment_status = 'unpaid',
            served_at = COALESCE(served_at, NOW()),
            updated_at = NOW()
        WHERE id = $9
        RETURNING id, order_number, status, kot_sent_at, served_at, completed_at, tax_amount, total_amount, total_cost, total_profit, payment_status, selected_tax_ids, tax_breakup, total_tax_amount, updated_at
        `,
        [
          total,
          taxAmount,
          JSON.stringify(selectedTaxIds || []),
          JSON.stringify(taxBreakup || {}),
          totalTaxAmount,
          taxPercentage,
          totalCost,
          totalProfit,
          id,
        ]
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
  updateOrderGuest,
  cancelOrder,
  voidOrderItem,
  replaceOrderItem,
  correctOrder,
  listOrders,
  listSelectableOrders,
  listLiveOrders,
  getOrder,
  getActiveOrderByTable,
  updateOrderStatus,
};

