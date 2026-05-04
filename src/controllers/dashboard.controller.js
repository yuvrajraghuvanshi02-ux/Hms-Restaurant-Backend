const { logError } = require("../utils/logError");

const isIsoDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || "").trim());

const todayIso = () => {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
};

const nextIsoDate = (iso) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
};

const getDashboard = async (req, res) => {
  const startDate = isIsoDate(req.query?.start_date) ? String(req.query.start_date) : todayIso();
  const endDate = isIsoDate(req.query?.end_date) ? String(req.query.end_date) : startDate;
  if (startDate > endDate) {
    return res.status(400).json({ message: "start_date cannot be greater than end_date." });
  }

  const endExclusive = nextIsoDate(endDate);

  try {
    const ordersQ = await req.tenantDB.query(
      `
      SELECT
        COUNT(*)::int AS total_orders,
        COUNT(*) FILTER (WHERE LOWER(COALESCE(status, '')) = 'completed')::int AS completed_orders,
        COUNT(*) FILTER (WHERE LOWER(COALESCE(status, '')) = 'cancelled')::int AS cancelled_orders,
        COUNT(*) FILTER (WHERE LOWER(COALESCE(status, '')) NOT IN ('completed', 'cancelled'))::int AS pending_orders,
        COUNT(*) FILTER (WHERE LOWER(COALESCE(order_type, '')) = 'dine_in')::int AS dine_in_count,
        COUNT(*) FILTER (WHERE LOWER(COALESCE(order_type, '')) = 'takeaway')::int AS takeaway_count,
        COUNT(*) FILTER (WHERE LOWER(COALESCE(order_type, '')) = 'delivery')::int AS delivery_count
      FROM orders
      WHERE created_at >= $1::date
        AND created_at < $2::date
      `,
      [startDate, endExclusive]
    );

    const financialQ = await req.tenantDB.query(
      `
      SELECT
        COALESCE(SUM(p.paid_amount), 0)::numeric AS total_revenue,
        COALESCE(SUM(o.total_profit), 0)::numeric AS total_profit,
        COALESCE(SUM(o.total_cost), 0)::numeric AS total_cost,
        COALESCE(
          SUM(
            CASE
              WHEN o.total_tax_amount IS NOT NULL THEN o.total_tax_amount
              ELSE o.tax_amount
            END
          ),
          0
        )::numeric AS total_tax
      FROM orders o
      LEFT JOIN payments p ON p.order_id = o.id
      WHERE o.created_at >= $1::date
        AND o.created_at < $2::date
        AND (LOWER(COALESCE(o.status, '')) = 'completed' OR LOWER(COALESCE(o.payment_status, '')) = 'paid')
      `,
      [startDate, endExclusive]
    );

    const lossesQ = await req.tenantDB.query(
      `
      WITH filtered_orders AS (
        SELECT id
        FROM orders
        WHERE created_at >= $1::date
          AND created_at < $2::date
      )
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
      FROM order_items oi
      JOIN filtered_orders fo ON fo.id = oi.order_id
      `,
      [startDate, endExclusive]
    );

    const replacementLossQ = await req.tenantDB.query(
      `
      SELECT COALESCE(SUM(a.cost_impact), 0)::numeric AS replacement_loss
      FROM order_adjustments a
      JOIN orders o ON o.id = a.order_id
      WHERE o.created_at >= $1::date
        AND o.created_at < $2::date
        AND LOWER(COALESCE(a.type, '')) = 'replacement'
      `,
      [startDate, endExclusive]
    );

    const paymentsQ = await req.tenantDB.query(
      `
      SELECT
        COALESCE(SUM(pi.amount) FILTER (WHERE LOWER(pi.mode) = 'cash'), 0)::numeric AS cash_total,
        COALESCE(SUM(pi.amount) FILTER (WHERE LOWER(pi.mode) = 'upi'), 0)::numeric AS upi_total,
        COALESCE(SUM(pi.amount) FILTER (WHERE LOWER(pi.mode) = 'card'), 0)::numeric AS card_total
      FROM payment_items pi
      JOIN payments p ON p.id = pi.payment_id
      JOIN orders o ON o.id = p.order_id
      WHERE o.created_at >= $1::date
        AND o.created_at < $2::date
      `,
      [startDate, endExclusive]
    );

    const staffQ = await req.tenantDB.query(
      `
      SELECT
        su.id AS staff_id,
        su.name AS staff_name,
        COALESCE(COUNT(o.id), 0)::int AS orders_count,
        COALESCE(SUM(o.tip_amount), 0)::numeric AS tips_total
      FROM staff_users su
      LEFT JOIN orders o
        ON o.assigned_staff_id = su.id
       AND o.created_at >= $1::date
       AND o.created_at < $2::date
      GROUP BY su.id, su.name
      ORDER BY su.name ASC
      `,
      [startDate, endExclusive]
    );

    const gstQ = await req.tenantDB.query(
      `
      WITH output_gst AS (
        SELECT
          COALESCE(
            SUM(
              CASE
                WHEN o.total_tax_amount IS NOT NULL THEN o.total_tax_amount
                ELSE o.tax_amount
              END
            ),
            0
          )::numeric AS amount
        FROM orders o
        WHERE o.created_at >= $1::date
          AND o.created_at < $2::date
          AND (LOWER(COALESCE(o.status, '')) = 'completed' OR LOWER(COALESCE(o.payment_status, '')) = 'paid')
      ),
      input_gst AS (
        SELECT COALESCE(SUM(po.gst_amount), 0)::numeric AS amount
        FROM purchase_orders po
        WHERE po.created_at >= $1::date
          AND po.created_at < $2::date
      )
      SELECT
        (SELECT amount FROM output_gst) AS output_gst,
        (SELECT amount FROM input_gst) AS input_gst
      `,
      [startDate, endExclusive]
    );

    const chartQ = await req.tenantDB.query(
      `
      SELECT
        DATE(o.created_at)::text AS day,
        COUNT(*)::int AS orders_count,
        COALESCE(SUM(p.paid_amount), 0)::numeric AS revenue,
        COALESCE(SUM(o.total_profit), 0)::numeric AS profit
      FROM orders o
      LEFT JOIN payments p ON p.order_id = o.id
      WHERE o.created_at >= $1::date
        AND o.created_at < $2::date
      GROUP BY DATE(o.created_at)
      ORDER BY DATE(o.created_at) ASC
      `,
      [startDate, endExclusive]
    );

    const orders = ordersQ.rows[0] || {};
    const financial = financialQ.rows[0] || {};
    const losses = lossesQ.rows[0] || {};
    const replacementLoss = replacementLossQ.rows[0] || {};
    const payments = paymentsQ.rows[0] || {};
    const gst = gstQ.rows[0] || {};
    const chartRows = chartQ.rows || [];

    const outputGst = Number(gst.output_gst || 0);
    const inputGst = Number(gst.input_gst || 0);

    return res.status(200).json({
      start_date: startDate,
      end_date: endDate,
      orders: {
        total_orders: Number(orders.total_orders || 0),
        completed_orders: Number(orders.completed_orders || 0),
        cancelled_orders: Number(orders.cancelled_orders || 0),
        pending_orders: Number(orders.pending_orders || 0),
        dine_in_count: Number(orders.dine_in_count || 0),
        takeaway_count: Number(orders.takeaway_count || 0),
        delivery_count: Number(orders.delivery_count || 0),
      },
      financial: {
        total_revenue: Number(financial.total_revenue || 0),
        total_profit: Number(financial.total_profit || 0),
        total_cost: Number(financial.total_cost || 0),
        total_tax: Number(financial.total_tax || 0),
      },
      loss: {
        void_loss: Number(losses.void_loss || 0),
        complimentary_loss: Number(losses.complimentary_loss || 0),
        replacement_loss: Number(replacementLoss.replacement_loss || 0),
      },
      payments: {
        cash_total: Number(payments.cash_total || 0),
        upi_total: Number(payments.upi_total || 0),
        card_total: Number(payments.card_total || 0),
      },
      staff: (staffQ.rows || []).map((r) => ({
        staff_id: r.staff_id,
        staff_name: r.staff_name,
        orders_count: Number(r.orders_count || 0),
        tips_total: Number(r.tips_total || 0),
      })),
      gst: {
        output_gst: outputGst,
        input_gst: inputGst,
        net_gst: outputGst - inputGst,
      },
      charts: {
        revenue_over_time: chartRows.map((r) => ({ date: r.day, value: Number(r.revenue || 0) })),
        profit_over_time: chartRows.map((r) => ({ date: r.day, value: Number(r.profit || 0) })),
        orders_over_time: chartRows.map((r) => ({ date: r.day, value: Number(r.orders_count || 0) })),
      },
    });
  } catch (error) {
    logError("GET /api/dashboard", error);
    return res.status(500).json({ message: "Failed to fetch dashboard analytics." });
  }
};

module.exports = { getDashboard };

