const { logError } = require("../utils/logError");

const toIsoDate = (value) => {
  const raw = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const d = new Date(`${raw}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  return raw;
};

const todayIso = () => {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
};

const getDayEndAudit = async (req, res) => {
  const date = toIsoDate(req.query?.date) || todayIso();

  try {
    const summaryQ = await req.tenantDB.query(
      `
      SELECT
        COUNT(*)::int AS total_orders,
        COUNT(*) FILTER (WHERE LOWER(COALESCE(o.status, '')) = 'completed')::int AS completed_orders,
        COUNT(*) FILTER (
          WHERE LOWER(COALESCE(o.payment_status, 'unpaid')) <> 'paid'
            AND LOWER(COALESCE(o.status, '')) <> 'cancelled'
        )::int AS pending_orders,
        COUNT(*) FILTER (WHERE LOWER(COALESCE(o.status, '')) = 'cancelled')::int AS cancelled_orders,
        COUNT(*) FILTER (WHERE LOWER(COALESCE(o.order_type, '')) = 'dine_in')::int AS dine_in_orders,
        COUNT(*) FILTER (WHERE LOWER(COALESCE(o.order_type, '')) = 'delivery')::int AS delivery_orders,
        COUNT(*) FILTER (WHERE LOWER(COALESCE(o.order_type, '')) = 'takeaway')::int AS takeaway_orders,
        COUNT(DISTINCT o.table_id) FILTER (
          WHERE LOWER(COALESCE(o.order_type, '')) = 'dine_in'
            AND o.table_id IS NOT NULL
        )::int AS tables_used
      FROM orders o
      WHERE DATE(o.created_at) = $1::date
      `,
      [date]
    );

    const financialsQ = await req.tenantDB.query(
      `
      SELECT
        COALESCE(SUM(oi.total_price), 0)::numeric AS subtotal_total,
        COALESCE(
          SUM(
            CASE
              WHEN o.total_tax_amount IS NOT NULL THEN o.total_tax_amount
              ELSE o.tax_amount
            END
          ),
          0
        )::numeric AS total_tax_collected,
        COALESCE(SUM(o.discount_amount), 0)::numeric AS total_discount,
        COALESCE(SUM(o.tip_amount), 0)::numeric AS total_tip,
        COALESCE(SUM(p.paid_amount), 0)::numeric AS final_collection
      FROM orders o
      LEFT JOIN payments p ON p.order_id = o.id
      LEFT JOIN order_items oi ON oi.order_id = o.id
        AND COALESCE(oi.status, 'active') IN ('active', 'replaced')
        AND COALESCE(oi.is_voided, FALSE) = FALSE
        AND COALESCE(oi.is_complimentary, FALSE) = FALSE
      WHERE DATE(o.created_at) = $1::date
        AND LOWER(COALESCE(o.status, '')) = 'completed'
      `,
      [date]
    );

    const profitQ = await req.tenantDB.query(
      `
      SELECT
        COALESCE(SUM(o.total_cost), 0)::numeric AS total_cost,
        COALESCE(SUM(o.total_profit), 0)::numeric AS total_profit
      FROM orders o
      WHERE DATE(o.created_at) = $1::date
        AND LOWER(COALESCE(o.status, '')) = 'completed'
      `,
      [date]
    );

    const lossesQ = await req.tenantDB.query(
      `
      SELECT
        COALESCE(
          SUM(oi.cost_price) FILTER (
            WHERE COALESCE(oi.status, 'active') = 'voided'
              OR COALESCE(oi.is_voided, FALSE) = TRUE
          ),
          0
        )::numeric AS void_loss,
        COALESCE(
          SUM(oi.cost_price) FILTER (
            WHERE COALESCE(oi.is_complimentary, FALSE) = TRUE
              AND COALESCE(oi.status, 'active') IN ('active', 'replaced')
              AND COALESCE(oi.is_voided, FALSE) = FALSE
          ),
          0
        )::numeric AS complimentary_loss
      FROM orders o
      JOIN order_items oi ON oi.order_id = o.id
      WHERE DATE(o.created_at) = $1::date
      `,
      [date]
    );

    const replacementQ = await req.tenantDB.query(
      `
      SELECT COALESCE(SUM(a.cost_impact), 0)::numeric AS replacement_impact
      FROM order_adjustments a
      JOIN orders o ON o.id = a.order_id
      WHERE DATE(o.created_at) = $1::date
        AND LOWER(COALESCE(a.type, '')) = 'replacement'
      `,
      [date]
    );

    const itemsQ = await req.tenantDB.query(
      `
      SELECT
        COALESCE(
          SUM(oi.quantity) FILTER (
            WHERE LOWER(COALESCE(o.status, '')) = 'completed'
              AND COALESCE(oi.status, 'active') IN ('active', 'replaced')
              AND COALESCE(oi.is_voided, FALSE) = FALSE
              AND COALESCE(oi.is_complimentary, FALSE) = FALSE
          ),
          0
        )::numeric AS total_items_sold,
        COALESCE(
          SUM(oi.quantity) FILTER (
            WHERE COALESCE(oi.status, 'active') = 'voided'
              OR COALESCE(oi.is_voided, FALSE) = TRUE
          ),
          0
        )::numeric AS total_items_voided,
        COALESCE(
          SUM(oi.quantity) FILTER (
            WHERE COALESCE(oi.is_complimentary, FALSE) = TRUE
              AND COALESCE(oi.status, 'active') IN ('active', 'replaced')
              AND COALESCE(oi.is_voided, FALSE) = FALSE
          ),
          0
        )::numeric AS total_items_complimentary
      FROM orders o
      JOIN order_items oi ON oi.order_id = o.id
      WHERE DATE(o.created_at) = $1::date
      `,
      [date]
    );

    const inputGstQ = await req.tenantDB.query(
      `
      SELECT COALESCE(SUM(po.gst_amount), 0)::numeric AS input_gst
      FROM purchase_orders po
      WHERE DATE(po.created_at) = $1::date
      `,
      [date]
    );

    const unpaidQ = await req.tenantDB.query(
      `
      SELECT
        o.id AS order_id,
        o.order_number,
        o.order_type,
        o.status,
        o.payment_status,
        o.total_amount,
        o.guest_name,
        o.guest_phone,
        t.name AS table_name,
        o.created_at
      FROM orders o
      LEFT JOIN tables t ON t.id = o.table_id
      WHERE DATE(o.created_at) = $1::date
        AND LOWER(COALESCE(o.payment_status, 'unpaid')) <> 'paid'
        AND LOWER(COALESCE(o.status, '')) <> 'cancelled'
      ORDER BY o.created_at DESC
      `,
      [date]
    );

    const summary = summaryQ.rows[0] || {};
    const financials = financialsQ.rows[0] || {};
    const profit = profitQ.rows[0] || {};
    const losses = lossesQ.rows[0] || {};
    const replacement = replacementQ.rows[0] || {};
    const items = itemsQ.rows[0] || {};

    const outputGst = Number(financials.total_tax_collected || 0);
    const inputGst = Number(inputGstQ.rows[0]?.input_gst || 0);
    const netGst = outputGst - inputGst;

    const voidLoss = Number(losses.void_loss || 0);
    const complimentaryLoss = Number(losses.complimentary_loss || 0);
    const replacementImpact = Number(replacement.replacement_impact || 0);

    return res.status(200).json({
      date,
      summary: {
        total_orders: Number(summary.total_orders || 0),
        completed_orders: Number(summary.completed_orders || 0),
        pending_orders: Number(summary.pending_orders || 0),
        cancelled_orders: Number(summary.cancelled_orders || 0),
        dine_in_orders: Number(summary.dine_in_orders || 0),
        delivery_orders: Number(summary.delivery_orders || 0),
        takeaway_orders: Number(summary.takeaway_orders || 0),
        tables_used: Number(summary.tables_used || 0),
      },
      financials: {
        subtotal_total: Number(financials.subtotal_total || 0),
        total_tax_collected: outputGst,
        total_discount: Number(financials.total_discount || 0),
        total_tip: Number(financials.total_tip || 0),
        final_collection: Number(financials.final_collection || 0),
      },
      profit: {
        total_cost: Number(profit.total_cost || 0),
        total_profit: Number(profit.total_profit || 0),
      },
      losses: {
        void_loss: voidLoss,
        complimentary_loss: complimentaryLoss,
        replacement_impact: replacementImpact,
        total_loss: voidLoss + complimentaryLoss + replacementImpact,
      },
      gst: {
        output_gst: outputGst,
        input_gst: inputGst,
        net_gst: netGst,
        status: netGst >= 0 ? "payable" : "credit",
      },
      items: {
        total_items_sold: Number(items.total_items_sold || 0),
        total_items_voided: Number(items.total_items_voided || 0),
        total_items_complimentary: Number(items.total_items_complimentary || 0),
      },
      unpaid_orders: unpaidQ.rows || [],
    });
  } catch (error) {
    logError("GET /api/audit/day-end", error);
    return res.status(500).json({ message: "Failed to run day-end audit." });
  }
};

module.exports = { getDayEndAudit };
