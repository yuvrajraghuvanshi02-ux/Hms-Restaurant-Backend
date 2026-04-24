const { logError } = require("../utils/logError");

const kitchenStatuses = ["kot_sent", "preparing", "ready", "served"];

const listKitchenOrders = async (req, res) => {
  try {
    const ordersQ = await req.tenantDB.query(
      `
      SELECT
        o.id AS order_id,
        o.order_number,
        o.status,
        o.kot_sent_at,
        o.served_at,
        o.completed_at,
        o.payment_status,
        o.created_at,
        t.name AS table_name
      FROM orders o
      LEFT JOIN tables t ON t.id = o.table_id
      WHERE o.status = ANY($1::text[])
      ORDER BY o.kot_sent_at ASC NULLS LAST, o.created_at ASC
      `,
      [kitchenStatuses]
    );

    const orders = ordersQ.rows || [];
    if (orders.length === 0) return res.status(200).json({ data: [] });

    const orderIds = orders.map((o) => o.order_id);

    const itemsQ = await req.tenantDB.query(
      `
      SELECT
        oi.order_id,
        oi.variant_id,
        i.name AS item_name,
        v.name AS variant_name,
        oi.quantity
      FROM order_items oi
      JOIN menu_item_variants v ON v.id = oi.variant_id
      JOIN menu_items i ON i.id = v.item_id
      WHERE oi.order_id = ANY($1::uuid[])
      ORDER BY oi.order_id ASC, i.name ASC, v.name ASC
      `,
      [orderIds]
    );

    const items = itemsQ.rows || [];
    const variantIds = Array.from(new Set(items.map((it) => it.variant_id).filter(Boolean)));

    const recipeItemsQ =
      variantIds.length === 0
        ? { rows: [] }
        : await req.tenantDB.query(
            `
            SELECT
              ri.menu_item_variant_id AS variant_id,
              rm.name AS raw_material_name,
              ri.quantity,
              u.short_name AS unit_short_name,
              u.name AS unit_name
            FROM recipe_items ri
            JOIN raw_materials rm ON rm.id = ri.raw_material_id
            LEFT JOIN units u ON u.id = ri.unit_id
            WHERE ri.menu_item_variant_id = ANY($1::uuid[])
            ORDER BY rm.name ASC
            `,
            [variantIds]
          );

    const stepsQ =
      variantIds.length === 0
        ? { rows: [] }
        : await req.tenantDB.query(
            `
            SELECT
              menu_item_variant_id AS variant_id,
              step_title AS step_name,
              step_description AS description,
              step_order
            FROM recipe_steps
            WHERE menu_item_variant_id = ANY($1::uuid[])
            ORDER BY step_order ASC
            `,
            [variantIds]
          );

    const materialsByVariant = new Map();
    for (const r of recipeItemsQ.rows || []) {
      const arr = materialsByVariant.get(r.variant_id) || [];
      arr.push({
        raw_material_name: r.raw_material_name,
        quantity: r.quantity,
        unit_short_name: r.unit_short_name,
        unit_name: r.unit_name,
      });
      materialsByVariant.set(r.variant_id, arr);
    }

    const stepsByVariant = new Map();
    for (const s of stepsQ.rows || []) {
      const arr = stepsByVariant.get(s.variant_id) || [];
      arr.push({ step_name: s.step_name, description: s.description, step_order: s.step_order });
      stepsByVariant.set(s.variant_id, arr);
    }

    const itemsByOrder = new Map();
    for (const it of items) {
      const arr = itemsByOrder.get(it.order_id) || [];
      arr.push({
        variant_id: it.variant_id,
        item_name: it.item_name,
        variant_name: it.variant_name,
        quantity: it.quantity,
        recipe: materialsByVariant.get(it.variant_id) || [],
        steps: stepsByVariant.get(it.variant_id) || [],
      });
      itemsByOrder.set(it.order_id, arr);
    }

    return res.status(200).json({
      data: orders.map((o) => ({
        order_id: o.order_id,
        order_number: o.order_number,
        status: o.status,
        table_name: o.table_name,
        kot_sent_at: o.kot_sent_at,
        served_at: o.served_at,
        completed_at: o.completed_at,
        payment_status: o.payment_status,
        created_at: o.created_at,
        items: itemsByOrder.get(o.order_id) || [],
      })),
    });
  } catch (error) {
    logError("GET /api/kitchen/orders", error);
    return res.status(500).json({ message: "Failed to fetch kitchen orders." });
  }
};

module.exports = { listKitchenOrders };

