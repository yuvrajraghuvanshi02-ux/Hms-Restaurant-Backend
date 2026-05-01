const { randomUUID } = require("crypto");
const { logError } = require("../utils/logError");

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
    if (!UUID_REGEX.test(variantId)) {
      const err = new Error(`items[${idx}].variant_id is invalid.`);
      err.statusCode = 400;
      throw err;
    }
    return {
      variant_id: variantId,
      quantity: toPositiveNumber(it?.quantity, `items[${idx}].quantity`),
    };
  });
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
  return `ORD-${String(maxNo + 1).padStart(4, "0")}`;
};

const getPublicMenu = async (req, res) => {
  try {
    const categoriesQ = await req.tenantDB.query(
      `
      SELECT c.id, c.name
      FROM menu_categories c
      WHERE EXISTS (
        SELECT 1
        FROM menu_items i
        WHERE i.category_id = c.id
          AND COALESCE(i.is_active, TRUE) = TRUE
      )
      ORDER BY c.name ASC
      `
    );

    const itemsQ = await req.tenantDB.query(
      `
      SELECT
        i.id AS item_id,
        i.name AS item_name,
        i.image_url,
        i.is_veg,
        i.category_id,
        c.name AS category_name,
        v.id AS variant_id,
        v.name AS variant_name,
        v.price AS variant_price
      FROM menu_items i
      JOIN menu_categories c ON c.id = i.category_id
      LEFT JOIN menu_item_variants v ON v.item_id = i.id
      WHERE COALESCE(i.is_active, TRUE) = TRUE
      ORDER BY c.name ASC, i.name ASC, v.name ASC
      `
    );

    const byItem = new Map();
    for (const row of itemsQ.rows || []) {
      if (!byItem.has(row.item_id)) {
        byItem.set(row.item_id, {
          id: row.item_id,
          name: row.item_name,
          image_url: row.image_url,
          is_veg: row.is_veg,
          category_id: row.category_id,
          category_name: row.category_name,
          variants: [],
        });
      }
      if (row.variant_id) {
        byItem.get(row.item_id).variants.push({
          id: row.variant_id,
          name: row.variant_name,
          price: Number(row.variant_price || 0),
        });
      }
    }

    const tableId = String(req.query?.table_id || "").trim();
    let table = null;
    if (tableId) {
      if (!UUID_REGEX.test(tableId)) {
        return res.status(400).json({ message: "table_id is invalid." });
      }
      const tableQ = await req.tenantDB.query(
        `
        SELECT id, name, is_active
        FROM tables
        WHERE id = $1
        LIMIT 1
        `,
        [tableId]
      );
      if (tableQ.rowCount === 0) {
        return res.status(400).json({ message: "Selected table does not exist." });
      }
      if (!Boolean(tableQ.rows[0].is_active)) {
        return res.status(400).json({ message: "Selected table is inactive." });
      }
      table = tableQ.rows[0];
    }

    return res.status(200).json({
      data: {
        restaurant: {
          id: req.restaurant.id,
          name: req.restaurant.name,
        },
        table,
        categories: categoriesQ.rows || [],
        items: Array.from(byItem.values()),
      },
    });
  } catch (error) {
    logError("GET /api/public/menu", error);
    return res.status(500).json({ message: "Failed to fetch public menu." });
  }
};

const createPublicOrder = async (req, res) => {
  const { table_id, guest_name, guest_phone, items } = req.body || {};
  const tableId = String(table_id || "").trim();
  const guestName = String(guest_name || "").trim();
  const guestPhone = String(guest_phone || "").trim();

  if (!tableId) return res.status(400).json({ message: "table_id is required." });
  if (!UUID_REGEX.test(tableId)) return res.status(400).json({ message: "table_id is invalid." });
  if (!guestName) return res.status(400).json({ message: "guest_name is required." });
  if (!guestPhone) return res.status(400).json({ message: "guest_phone is required." });

  let normalizedItems;
  try {
    normalizedItems = normalizeItems(items);
  } catch (error) {
    return res.status(error.statusCode || 400).json({ message: error.message });
  }

  try {
    const created = await withTenantTx(req.tenantDB, async (client) => {
      const tableQ = await client.query(
        `
        SELECT id, name, is_active
        FROM tables
        WHERE id = $1
        LIMIT 1
        FOR UPDATE
        `,
        [tableId]
      );
      if (tableQ.rowCount === 0) {
        const err = new Error("Selected table does not exist.");
        err.statusCode = 400;
        throw err;
      }
      if (!Boolean(tableQ.rows[0].is_active)) {
        const err = new Error("Selected table is inactive.");
        err.statusCode = 400;
        throw err;
      }

      const variantIds = Array.from(new Set(normalizedItems.map((it) => it.variant_id)));
      const variantsQ = await client.query(
        `
        SELECT
          v.id AS variant_id,
          v.price,
          i.id AS item_id,
          COALESCE(i.is_active, TRUE) AS item_is_active
        FROM menu_item_variants v
        JOIN menu_items i ON i.id = v.item_id
        WHERE v.id = ANY($1::uuid[])
        `,
        [variantIds]
      );
      const variantsMap = new Map(variantsQ.rows.map((r) => [r.variant_id, r]));
      for (const vid of variantIds) {
        const row = variantsMap.get(vid);
        if (!row || !Boolean(row.item_is_active)) {
          const err = new Error("One or more variants do not exist.");
          err.statusCode = 400;
          throw err;
        }
      }

      const preparedItems = normalizedItems.map((it) => {
        const row = variantsMap.get(it.variant_id);
        const price = Number(row?.price || 0);
        return {
          variant_id: it.variant_id,
          quantity: it.quantity,
          price,
          total_price: price * Number(it.quantity || 0),
        };
      });

      const subtotal = preparedItems.reduce((sum, it) => sum + Number(it.total_price || 0), 0);
      const taxAmount = 0;
      const total = subtotal + taxAmount;

      const orderId = randomUUID();
      const orderNumber = await nextOrderNumber(client);

      await client.query(
        `
        INSERT INTO orders (
          id, order_number, order_type, status, table_id,
          guest_name, guest_phone, payment_status,
          subtotal, tax_percentage, tax_amount, total_amount, selected_tax_ids, tax_breakup, total_tax_amount,
          kot_sent_at
        )
        VALUES (
          $1, $2, 'dine_in', 'kot_sent', $3,
          $4, $5, 'unpaid',
          $6, 0, $7, $8, '[]'::jsonb, '{}'::jsonb, $9,
          NOW()
        )
        `,
        [
          orderId,
          orderNumber,
          tableId,
          guestName.slice(0, 160),
          guestPhone.slice(0, 40),
          subtotal,
          taxAmount,
          total,
          taxAmount,
        ]
      );

      for (const it of preparedItems) {
        await client.query(
          `
          INSERT INTO order_items (
            id, order_id, variant_id, quantity, price, total_price, cost_price, profit, is_complimentary, status
          )
          VALUES ($1, $2, $3, $4, $5, $6, 0, 0, FALSE, 'active')
          `,
          [randomUUID(), orderId, it.variant_id, it.quantity, it.price, it.total_price]
        );
      }

      return {
        order_id: orderId,
        order_number: orderNumber,
        table_name: tableQ.rows[0].name,
      };
    });

    return res.status(201).json({
      message: "Order placed successfully!",
      data: created,
    });
  } catch (error) {
    logError("POST /api/public/order", error);
    return res.status(error.statusCode || 500).json({
      message: error?.message || "Failed to place order.",
    });
  }
};

module.exports = {
  getPublicMenu,
  createPublicOrder,
};
