const { logError } = require("../utils/logError");
const { parseListParams, buildPagination } = require("../utils/listQuery");

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
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d;
};

const parseYmdDate = (value) => {
  const raw = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const [y, m, d] = raw.split("-").map((x) => Number(x));
  const dt = new Date(y, m - 1, d, 0, 0, 0, 0);
  if (
    Number.isNaN(dt.getTime()) ||
    dt.getFullYear() !== y ||
    dt.getMonth() !== m - 1 ||
    dt.getDate() !== d
  ) {
    return null;
  }
  return dt;
};

const toYmd = (dateObj) => {
  const yyyy = dateObj.getFullYear();
  const mm = String(dateObj.getMonth() + 1).padStart(2, "0");
  const dd = String(dateObj.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
};

const addDays = (dateObj, days) => {
  const d = new Date(dateObj);
  d.setDate(d.getDate() + days);
  return d;
};

const getSalesDateRange = (query = {}) => {
  const startRaw = query.start_date;
  const endRaw = query.end_date;

  if (!startRaw && !endRaw) {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    return {
      startDate: today,
      endDate: today,
      startDateExclusiveEnd: addDays(today, 1),
      startDateIso: toYmd(today),
      endDateIso: toYmd(today),
    };
  }

  const parsedStart = startRaw ? parseYmdDate(startRaw) : null;
  const parsedEnd = endRaw ? parseYmdDate(endRaw) : null;
  if ((startRaw && !parsedStart) || (endRaw && !parsedEnd)) return null;

  const startDate = parsedStart || parsedEnd;
  const endDate = parsedEnd || parsedStart;
  if (!startDate || !endDate) return null;
  if (startDate.getTime() > endDate.getTime()) return null;

  return {
    startDate,
    endDate,
    startDateExclusiveEnd: addDays(endDate, 1),
    startDateIso: toYmd(startDate),
    endDateIso: toYmd(endDate),
  };
};

const getSalesReport = async (req, res) => {
  try {
    const params = parseListParams(req.query, { defaultSortBy: "created_at", defaultOrder: "DESC" });
    const dateRange = getSalesDateRange(req.query);
    if (!dateRange) {
      return res.status(400).json({ message: "Invalid date range. Use YYYY-MM-DD and ensure start_date <= end_date." });
    }

    const { startDate, startDateExclusiveEnd, startDateIso, endDateIso } = dateRange;

    const summaryQ = await req.tenantDB.query(
      `
      WITH payment_totals AS (
        SELECT p.order_id, COALESCE(SUM(p.paid_amount), 0)::numeric AS paid_amount
        FROM payments p
        GROUP BY p.order_id
      )
      SELECT
        COUNT(*)::int AS total_orders,
        COALESCE(SUM(pt.paid_amount), 0)::numeric AS total_revenue,
        COALESCE(SUM(o.total_amount), 0)::numeric AS total_subtotal,
        COALESCE(SUM(o.tax_amount), 0)::numeric AS total_tax,
        COALESCE(SUM(o.discount_amount), 0)::numeric AS total_discount,
        COALESCE(SUM(o.tip_amount), 0)::numeric AS total_tip
      FROM orders o
      LEFT JOIN payment_totals pt ON pt.order_id = o.id
      WHERE LOWER(COALESCE(o.status, '')) = 'completed'
        AND o.created_at >= $1
        AND o.created_at < $2
      `,
      [startDate, startDateExclusiveEnd]
    );

    const statusCountsQ = await req.tenantDB.query(
      `
      SELECT
        COUNT(*) FILTER (WHERE LOWER(COALESCE(o.status, '')) = 'completed')::int AS completed_orders,
        COUNT(*) FILTER (WHERE LOWER(COALESCE(o.status, '')) = 'cancelled')::int AS cancelled_orders,
        COUNT(*) FILTER (
          WHERE LOWER(COALESCE(o.status, '')) NOT IN ('completed', 'cancelled')
        )::int AS pending_orders
      FROM orders o
      WHERE o.created_at >= $1
        AND o.created_at < $2
      `,
      [startDate, startDateExclusiveEnd]
    );

    const trendQ = await req.tenantDB.query(
      `
      WITH payment_totals AS (
        SELECT p.order_id, COALESCE(SUM(p.paid_amount), 0)::numeric AS paid_amount
        FROM payments p
        GROUP BY p.order_id
      )
      SELECT
        TO_CHAR(o.created_at::date, 'YYYY-MM-DD') AS date,
        COALESCE(SUM(pt.paid_amount), 0)::numeric AS revenue
      FROM orders o
      LEFT JOIN payment_totals pt ON pt.order_id = o.id
      WHERE LOWER(COALESCE(o.status, '')) = 'completed'
        AND o.created_at >= $1
        AND o.created_at < $2
      GROUP BY o.created_at::date
      ORDER BY o.created_at::date ASC
      `,
      [startDate, startDateExclusiveEnd]
    );

    const totalOrdersForPaginationQ = await req.tenantDB.query(
      `
      SELECT COUNT(*)::int AS total
      FROM orders o
      WHERE LOWER(COALESCE(o.status, '')) = 'completed'
        AND o.created_at >= $1
        AND o.created_at < $2
      `,
      [startDate, startDateExclusiveEnd]
    );
    const totalForPagination = Number(totalOrdersForPaginationQ.rows[0]?.total || 0);

    const ordersQ = await req.tenantDB.query(
      `
      WITH payment_totals AS (
        SELECT p.order_id, COALESCE(SUM(p.paid_amount), 0)::numeric AS paid_amount
        FROM payments p
        GROUP BY p.order_id
      )
      SELECT
        o.id AS order_id,
        o.order_number,
        o.created_at,
        t.name AS table_name,
        s.name AS assigned_staff_name,
        o.status,
        COALESCE(o.total_amount, 0)::numeric AS total_amount,
        COALESCE(o.discount_amount, 0)::numeric AS discount_amount,
        COALESCE(o.tip_amount, 0)::numeric AS tip_amount,
        COALESCE(o.tax_amount, 0)::numeric AS tax_amount,
        COALESCE(pt.paid_amount, 0)::numeric AS paid_amount
      FROM orders o
      LEFT JOIN tables t ON t.id = o.table_id
      LEFT JOIN staff_users s ON s.id = o.assigned_staff_id
      LEFT JOIN payment_totals pt ON pt.order_id = o.id
      WHERE LOWER(COALESCE(o.status, '')) = 'completed'
        AND o.created_at >= $1
        AND o.created_at < $2
      ORDER BY o.created_at DESC
      LIMIT $3 OFFSET $4
      `,
      [startDate, startDateExclusiveEnd, params.limit, params.offset]
    );

    const summaryRow = summaryQ.rows[0] || {};
    const statusRow = statusCountsQ.rows[0] || {};

    return res.status(200).json({
      filters: {
        start_date: startDateIso,
        end_date: endDateIso,
      },
      summary: {
        total_orders: Number(summaryRow.total_orders || 0),
        total_revenue: Number(summaryRow.total_revenue || 0),
        total_subtotal: Number(summaryRow.total_subtotal || 0),
        total_tax: Number(summaryRow.total_tax || 0),
        total_discount: Number(summaryRow.total_discount || 0),
        total_tip: Number(summaryRow.total_tip || 0),
      },
      status_counts: {
        completed_orders: Number(statusRow.completed_orders || 0),
        cancelled_orders: Number(statusRow.cancelled_orders || 0),
        pending_orders: Number(statusRow.pending_orders || 0),
      },
      chart: (trendQ.rows || []).map((row) => ({
        date: row.date,
        revenue: Number(row.revenue || 0),
      })),
      orders: (ordersQ.rows || []).map((row) => ({
        ...row,
        total_amount: Number(row.total_amount || 0),
        discount_amount: Number(row.discount_amount || 0),
        tip_amount: Number(row.tip_amount || 0),
        tax_amount: Number(row.tax_amount || 0),
        paid_amount: Number(row.paid_amount || 0),
      })),
      pagination: buildPagination({ total: totalForPagination, page: params.page, limit: params.limit }),
    });
  } catch (error) {
    logError("GET /api/reports/sales", error);
    return res.status(500).json({ message: "Failed to fetch sales report." });
  }
};

const getProfitLossReport = async (req, res) => {
  try {
    const params = parseListParams(req.query, { defaultSortBy: "created_at", defaultOrder: "DESC" });
    const dateRange = getSalesDateRange(req.query);
    if (!dateRange) {
      return res.status(400).json({ message: "Invalid date range. Use YYYY-MM-DD and ensure start_date <= end_date." });
    }

    const { startDate, startDateExclusiveEnd, startDateIso, endDateIso } = dateRange;

    const summaryQ = await req.tenantDB.query(
      `
      WITH payment_totals AS (
        SELECT p.order_id, COALESCE(SUM(p.paid_amount), 0)::numeric AS paid_amount
        FROM payments p
        GROUP BY p.order_id
      )
      SELECT
        COALESCE(SUM(pt.paid_amount), 0)::numeric AS revenue,
        COALESCE(SUM(o.total_cost), 0)::numeric AS cost,
        COALESCE(SUM(o.total_profit), 0)::numeric AS profit,
        COALESCE(SUM(o.tip_amount), 0)::numeric AS tip
      FROM orders o
      LEFT JOIN payment_totals pt ON pt.order_id = o.id
      WHERE LOWER(COALESCE(o.status, '')) = 'completed'
        AND o.created_at >= $1
        AND o.created_at < $2
      `,
      [startDate, startDateExclusiveEnd]
    );

    const trendQ = await req.tenantDB.query(
      `
      SELECT
        TO_CHAR(o.created_at::date, 'YYYY-MM-DD') AS date,
        COALESCE(SUM(o.total_profit), 0)::numeric AS profit,
        COALESCE(SUM(o.total_cost), 0)::numeric AS cost
      FROM orders o
      WHERE LOWER(COALESCE(o.status, '')) = 'completed'
        AND o.created_at >= $1
        AND o.created_at < $2
      GROUP BY o.created_at::date
      ORDER BY o.created_at::date ASC
      `,
      [startDate, startDateExclusiveEnd]
    );

    const totalOrdersQ = await req.tenantDB.query(
      `
      SELECT COUNT(*)::int AS total
      FROM orders o
      WHERE LOWER(COALESCE(o.status, '')) = 'completed'
        AND o.created_at >= $1
        AND o.created_at < $2
      `,
      [startDate, startDateExclusiveEnd]
    );
    const totalForPagination = Number(totalOrdersQ.rows[0]?.total || 0);

    const ordersQ = await req.tenantDB.query(
      `
      WITH payment_totals AS (
        SELECT p.order_id, COALESCE(SUM(p.paid_amount), 0)::numeric AS paid_amount
        FROM payments p
        GROUP BY p.order_id
      )
      SELECT
        o.id AS order_id,
        o.order_number,
        o.created_at AS date,
        COALESCE(pt.paid_amount, 0)::numeric AS revenue,
        COALESCE(o.total_cost, 0)::numeric AS cost,
        COALESCE(o.total_profit, 0)::numeric AS profit,
        COALESCE(o.tip_amount, 0)::numeric AS tip,
        (COALESCE(o.total_profit, 0) + COALESCE(o.tip_amount, 0))::numeric AS net_collection
      FROM orders o
      LEFT JOIN payment_totals pt ON pt.order_id = o.id
      WHERE LOWER(COALESCE(o.status, '')) = 'completed'
        AND o.created_at >= $1
        AND o.created_at < $2
      ORDER BY o.created_at DESC
      LIMIT $3 OFFSET $4
      `,
      [startDate, startDateExclusiveEnd, params.limit, params.offset]
    );

    const row = summaryQ.rows[0] || {};
    const revenue = Number(row.revenue || 0);
    const cost = Number(row.cost || 0);
    const profit = Number(row.profit || 0);
    const tip = Number(row.tip || 0);
    const totalCollection = profit + tip;
    const profitMargin = revenue > 0 ? (profit / revenue) * 100 : 0;

    return res.status(200).json({
      filters: {
        start_date: startDateIso,
        end_date: endDateIso,
      },
      summary: {
        revenue,
        cost,
        profit,
        tip,
        total_collection: totalCollection,
        profit_margin: profitMargin,
      },
      chart: (trendQ.rows || []).map((r) => ({
        date: r.date,
        profit: Number(r.profit || 0),
        cost: Number(r.cost || 0),
      })),
      orders: (ordersQ.rows || []).map((r) => ({
        ...r,
        revenue: Number(r.revenue || 0),
        cost: Number(r.cost || 0),
        profit: Number(r.profit || 0),
        tip: Number(r.tip || 0),
        net_collection: Number(r.net_collection || 0),
      })),
      pagination: buildPagination({ total: totalForPagination, page: params.page, limit: params.limit }),
    });
  } catch (error) {
    logError("GET /api/reports/profit-loss", error);
    return res.status(500).json({ message: "Failed to fetch profit & loss report." });
  }
};

const getPaymentsReport = async (req, res) => {
  try {
    const dateRange = getSalesDateRange(req.query);
    if (!dateRange) {
      return res.status(400).json({ message: "Invalid date range. Use YYYY-MM-DD and ensure start_date <= end_date." });
    }
    const { startDate, startDateExclusiveEnd, startDateIso, endDateIso } = dateRange;

    const summaryQ = await req.tenantDB.query(
      `
      SELECT
        COALESCE(SUM(pi.amount), 0)::numeric AS total_collection,
        COALESCE(SUM(pi.amount) FILTER (WHERE LOWER(COALESCE(pi.mode, '')) = 'cash'), 0)::numeric AS cash_total,
        COALESCE(SUM(pi.amount) FILTER (WHERE LOWER(COALESCE(pi.mode, '')) = 'upi'), 0)::numeric AS upi_total,
        COALESCE(SUM(pi.amount) FILTER (WHERE LOWER(COALESCE(pi.mode, '')) = 'card'), 0)::numeric AS card_total,
        COALESCE(
          SUM(pi.amount) FILTER (
            WHERE LOWER(COALESCE(pi.mode, '')) NOT IN ('cash', 'upi', 'card')
          ),
          0
        )::numeric AS other_total
      FROM payment_items pi
      JOIN payments p ON p.id = pi.payment_id
      JOIN orders o ON o.id = p.order_id
      WHERE LOWER(COALESCE(o.status, '')) = 'completed'
        AND o.created_at >= $1
        AND o.created_at < $2
      `,
      [startDate, startDateExclusiveEnd]
    );

    const ordersQ = await req.tenantDB.query(
      `
      SELECT
        o.id AS order_id,
        o.order_number,
        o.created_at AS date,
        CASE
          WHEN LOWER(COALESCE(pi.mode, '')) = 'cash' THEN 'Cash'
          WHEN LOWER(COALESCE(pi.mode, '')) = 'upi' THEN 'UPI'
          WHEN LOWER(COALESCE(pi.mode, '')) = 'card' THEN 'Card'
          ELSE 'Other'
        END AS payment_method,
        COALESCE(pi.amount, 0)::numeric AS paid_amount
      FROM payment_items pi
      JOIN payments p ON p.id = pi.payment_id
      JOIN orders o ON o.id = p.order_id
      WHERE LOWER(COALESCE(o.status, '')) = 'completed'
        AND o.created_at >= $1
        AND o.created_at < $2
      ORDER BY o.created_at DESC, o.order_number DESC
      `,
      [startDate, startDateExclusiveEnd]
    );

    const row = summaryQ.rows[0] || {};
    const totalCollection = Number(row.total_collection || 0);
    const cashTotal = Number(row.cash_total || 0);
    const upiTotal = Number(row.upi_total || 0);
    const cardTotal = Number(row.card_total || 0);
    const otherTotal = Number(row.other_total || 0);

    const asPct = (amount) => (totalCollection > 0 ? (Number(amount || 0) / totalCollection) * 100 : 0);

    return res.status(200).json({
      filters: {
        start_date: startDateIso,
        end_date: endDateIso,
      },
      summary: {
        total_collection: totalCollection,
        cash_total: cashTotal,
        upi_total: upiTotal,
        card_total: cardTotal,
        other_total: otherTotal,
        cash_percentage: asPct(cashTotal),
        upi_percentage: asPct(upiTotal),
        card_percentage: asPct(cardTotal),
        other_percentage: asPct(otherTotal),
      },
      chart: [
        { method: "Cash", amount: cashTotal, percentage: asPct(cashTotal) },
        { method: "UPI", amount: upiTotal, percentage: asPct(upiTotal) },
        { method: "Card", amount: cardTotal, percentage: asPct(cardTotal) },
        { method: "Other", amount: otherTotal, percentage: asPct(otherTotal) },
      ],
      orders: (ordersQ.rows || []).map((r) => ({
        ...r,
        paid_amount: Number(r.paid_amount || 0),
      })),
    });
  } catch (error) {
    logError("GET /api/reports/payments", error);
    return res.status(500).json({ message: "Failed to fetch payment report." });
  }
};

const normalizeOrdersStatusFilter = (statusRaw) => {
  const status = String(statusRaw || "").trim().toLowerCase();
  if (!status) return null;
  if (status === "pending") return ["created", "kot_sent", "ready", "pending"];
  if (status === "preparing") return ["preparing"];
  if (status === "served") return ["served"];
  if (status === "completed") return ["completed"];
  if (status === "cancelled") return ["cancelled"];
  return null;
};

const getAllOrdersReport = async (req, res) => {
  try {
    const params = parseListParams(req.query, { defaultSortBy: "created_at", defaultOrder: "DESC" });
    const dateRange = getSalesDateRange(req.query);
    if (!dateRange) {
      return res.status(400).json({ message: "Invalid date range. Use YYYY-MM-DD and ensure start_date <= end_date." });
    }
    const { startDate, startDateExclusiveEnd, startDateIso, endDateIso } = dateRange;

    const statusSet = normalizeOrdersStatusFilter(req.query?.status);

    const summaryQ = await req.tenantDB.query(
      `
      SELECT
        COUNT(*)::int AS total_orders,
        COUNT(*) FILTER (
          WHERE LOWER(COALESCE(o.status, '')) IN ('created', 'kot_sent', 'ready', 'pending')
        )::int AS pending_orders,
        COUNT(*) FILTER (WHERE LOWER(COALESCE(o.status, '')) = 'preparing')::int AS preparing_orders,
        COUNT(*) FILTER (WHERE LOWER(COALESCE(o.status, '')) = 'served')::int AS served_orders,
        COUNT(*) FILTER (WHERE LOWER(COALESCE(o.status, '')) = 'completed')::int AS completed_orders,
        COUNT(*) FILTER (WHERE LOWER(COALESCE(o.status, '')) = 'cancelled')::int AS cancelled_orders
      FROM orders o
      WHERE o.created_at >= $1
        AND o.created_at < $2
      `,
      [startDate, startDateExclusiveEnd]
    );

    const totalQ = await req.tenantDB.query(
      `
      SELECT COUNT(*)::int AS total
      FROM orders o
      WHERE o.created_at >= $1
        AND o.created_at < $2
        AND ($3::text[] IS NULL OR LOWER(COALESCE(o.status, '')) = ANY($3::text[]))
      `,
      [startDate, startDateExclusiveEnd, statusSet]
    );
    const totalForPagination = Number(totalQ.rows[0]?.total || 0);

    const ordersQ = await req.tenantDB.query(
      `
      WITH payment_totals AS (
        SELECT p.order_id, COALESCE(SUM(p.paid_amount), 0)::numeric AS paid_amount
        FROM payments p
        GROUP BY p.order_id
      )
      SELECT
        o.id AS order_id,
        o.order_number,
        o.created_at,
        t.name AS table_name,
        s.name AS assigned_staff,
        o.order_type,
        o.status,
        COALESCE(o.total_amount, 0)::numeric AS total_amount,
        COALESCE(pt.paid_amount, 0)::numeric AS paid_amount,
        o.payment_status,
        o.kot_sent_at,
        o.served_at,
        o.completed_at
      FROM orders o
      LEFT JOIN tables t ON t.id = o.table_id
      LEFT JOIN staff_users s ON s.id = o.assigned_staff_id
      LEFT JOIN payment_totals pt ON pt.order_id = o.id
      WHERE o.created_at >= $1
        AND o.created_at < $2
        AND ($3::text[] IS NULL OR LOWER(COALESCE(o.status, '')) = ANY($3::text[]))
      ORDER BY o.created_at DESC
      LIMIT $4 OFFSET $5
      `,
      [startDate, startDateExclusiveEnd, statusSet, params.limit, params.offset]
    );

    return res.status(200).json({
      filters: {
        start_date: startDateIso,
        end_date: endDateIso,
        status: String(req.query?.status || "").trim().toLowerCase() || null,
      },
      summary: {
        total_orders: Number(summaryQ.rows[0]?.total_orders || 0),
        pending_orders: Number(summaryQ.rows[0]?.pending_orders || 0),
        preparing_orders: Number(summaryQ.rows[0]?.preparing_orders || 0),
        served_orders: Number(summaryQ.rows[0]?.served_orders || 0),
        completed_orders: Number(summaryQ.rows[0]?.completed_orders || 0),
        cancelled_orders: Number(summaryQ.rows[0]?.cancelled_orders || 0),
      },
      orders: (ordersQ.rows || []).map((r) => ({
        ...r,
        total_amount: Number(r.total_amount || 0),
        paid_amount: Number(r.paid_amount || 0),
      })),
      pagination: buildPagination({ total: totalForPagination, page: params.page, limit: params.limit }),
    });
  } catch (error) {
    logError("GET /api/reports/orders", error);
    return res.status(500).json({ message: "Failed to fetch orders report." });
  }
};

const getCancelledOrdersReport = async (req, res) => {
  try {
    const params = parseListParams(req.query, { defaultSortBy: "created_at", defaultOrder: "DESC" });
    const dateRange = getSalesDateRange(req.query);
    if (!dateRange) {
      return res.status(400).json({ message: "Invalid date range. Use YYYY-MM-DD and ensure start_date <= end_date." });
    }
    const { startDate, startDateExclusiveEnd, startDateIso, endDateIso } = dateRange;

    const summaryQ = await req.tenantDB.query(
      `
      SELECT
        COUNT(*)::int AS total_cancelled_orders,
        COALESCE(SUM(o.total_amount), 0)::numeric AS total_loss_amount
      FROM orders o
      WHERE LOWER(COALESCE(o.status, '')) = 'cancelled'
        AND o.created_at >= $1
        AND o.created_at < $2
      `,
      [startDate, startDateExclusiveEnd]
    );

    const chartQ = await req.tenantDB.query(
      `
      SELECT
        TO_CHAR(o.created_at::date, 'YYYY-MM-DD') AS date,
        COUNT(*)::int AS cancelled_orders
      FROM orders o
      WHERE LOWER(COALESCE(o.status, '')) = 'cancelled'
        AND o.created_at >= $1
        AND o.created_at < $2
      GROUP BY o.created_at::date
      ORDER BY o.created_at::date ASC
      `,
      [startDate, startDateExclusiveEnd]
    );

    const totalQ = await req.tenantDB.query(
      `
      SELECT COUNT(*)::int AS total
      FROM orders o
      WHERE LOWER(COALESCE(o.status, '')) = 'cancelled'
        AND o.created_at >= $1
        AND o.created_at < $2
      `,
      [startDate, startDateExclusiveEnd]
    );
    const totalForPagination = Number(totalQ.rows[0]?.total || 0);

    const ordersQ = await req.tenantDB.query(
      `
      SELECT
        o.id AS order_id,
        o.order_number,
        o.created_at,
        t.name AS table_name,
        s.name AS assigned_staff,
        o.order_type,
        o.total_amount,
        o.updated_at AS cancellation_time,
        o.payment_status
      FROM orders o
      LEFT JOIN tables t ON t.id = o.table_id
      LEFT JOIN staff_users s ON s.id = o.assigned_staff_id
      WHERE LOWER(COALESCE(o.status, '')) = 'cancelled'
        AND o.created_at >= $1
        AND o.created_at < $2
      ORDER BY o.created_at DESC
      LIMIT $3 OFFSET $4
      `,
      [startDate, startDateExclusiveEnd, params.limit, params.offset]
    );

    const summary = summaryQ.rows[0] || {};

    return res.status(200).json({
      filters: {
        start_date: startDateIso,
        end_date: endDateIso,
      },
      summary: {
        total_cancelled_orders: Number(summary.total_cancelled_orders || 0),
        total_loss_amount: Number(summary.total_loss_amount || 0),
      },
      chart: (chartQ.rows || []).map((r) => ({
        date: r.date,
        cancelled_orders: Number(r.cancelled_orders || 0),
      })),
      orders: (ordersQ.rows || []).map((r) => ({
        ...r,
        total_amount: Number(r.total_amount || 0),
      })),
      pagination: buildPagination({ total: totalForPagination, page: params.page, limit: params.limit }),
    });
  } catch (error) {
    logError("GET /api/reports/orders/cancelled", error);
    return res.status(500).json({ message: "Failed to fetch cancelled orders report." });
  }
};

const getVoidItemsReport = async (req, res) => {
  try {
    const params = parseListParams(req.query, { defaultSortBy: "created_at", defaultOrder: "DESC" });
    const dateRange = getSalesDateRange(req.query);
    if (!dateRange) {
      return res.status(400).json({ message: "Invalid date range. Use YYYY-MM-DD and ensure start_date <= end_date." });
    }
    const { startDate, startDateExclusiveEnd, startDateIso, endDateIso } = dateRange;

    const summaryQ = await req.tenantDB.query(
      `
      SELECT
        COUNT(*)::int AS total_void_items,
        COALESCE(SUM(a.quantity), 0)::numeric AS total_void_quantity,
        COALESCE(
          SUM(
            COALESCE(
              a.amount_impact,
              COALESCE(oi.price, 0) * COALESCE(a.quantity, 0)
            )
          ),
          0
        )::numeric AS revenue_loss,
        COALESCE(
          SUM(
            COALESCE(
              a.cost_impact,
              (COALESCE(oi.cost_price, 0) / NULLIF(COALESCE(oi.quantity, 0), 0)) * COALESCE(a.quantity, 0)
            )
          ),
          0
        )::numeric AS cost_loss
      FROM order_adjustments a
      JOIN orders o ON o.id = a.order_id
      LEFT JOIN order_items oi ON oi.id = a.order_item_id
      WHERE LOWER(COALESCE(a.type, '')) LIKE 'void%'
        AND o.created_at >= $1
        AND o.created_at < $2
      `,
      [startDate, startDateExclusiveEnd]
    );

    const itemAnalysisQ = await req.tenantDB.query(
      `
      SELECT
        COALESCE(i.name || ' - ' || v.name, i.name, v.name, 'Unknown Item') AS item_name,
        COALESCE(SUM(a.quantity), 0)::numeric AS total_void_quantity,
        COALESCE(
          SUM(
            COALESCE(
              a.cost_impact,
              (COALESCE(oi.cost_price, 0) / NULLIF(COALESCE(oi.quantity, 0), 0)) * COALESCE(a.quantity, 0)
            )
          ),
          0
        )::numeric AS total_loss
      FROM order_adjustments a
      JOIN orders o ON o.id = a.order_id
      LEFT JOIN order_items oi ON oi.id = a.order_item_id
      LEFT JOIN menu_item_variants v ON v.id = oi.variant_id
      LEFT JOIN menu_items i ON i.id = v.item_id
      WHERE LOWER(COALESCE(a.type, '')) LIKE 'void%'
        AND o.created_at >= $1
        AND o.created_at < $2
      GROUP BY COALESCE(i.name || ' - ' || v.name, i.name, v.name, 'Unknown Item')
      ORDER BY total_loss DESC, total_void_quantity DESC
      `,
      [startDate, startDateExclusiveEnd]
    );

    const totalQ = await req.tenantDB.query(
      `
      SELECT COUNT(*)::int AS total
      FROM order_adjustments a
      JOIN orders o ON o.id = a.order_id
      WHERE LOWER(COALESCE(a.type, '')) LIKE 'void%'
        AND o.created_at >= $1
        AND o.created_at < $2
      `,
      [startDate, startDateExclusiveEnd]
    );
    const totalForPagination = Number(totalQ.rows[0]?.total || 0);

    const detailsQ = await req.tenantDB.query(
      `
      SELECT
        a.id AS adjustment_id,
        o.id AS order_id,
        o.order_number,
        o.created_at AS date,
        COALESCE(i.name || ' - ' || v.name, i.name, v.name, 'Unknown Item') AS item_name,
        COALESCE(a.quantity, 0)::numeric AS quantity,
        COALESCE(oi.price, 0)::numeric AS item_price,
        COALESCE(
          (COALESCE(oi.cost_price, 0) / NULLIF(COALESCE(oi.quantity, 0), 0)),
          0
        )::numeric AS item_cost,
        COALESCE(
          a.amount_impact,
          COALESCE(oi.price, 0) * COALESCE(a.quantity, 0)
        )::numeric AS revenue_loss,
        COALESCE(
          a.cost_impact,
          (COALESCE(oi.cost_price, 0) / NULLIF(COALESCE(oi.quantity, 0), 0)) * COALESCE(a.quantity, 0)
        )::numeric AS cost_loss,
        su.name AS staff_name
      FROM order_adjustments a
      JOIN orders o ON o.id = a.order_id
      LEFT JOIN order_items oi ON oi.id = a.order_item_id
      LEFT JOIN menu_item_variants v ON v.id = oi.variant_id
      LEFT JOIN menu_items i ON i.id = v.item_id
      LEFT JOIN staff_users su ON su.id = o.assigned_staff_id
      WHERE LOWER(COALESCE(a.type, '')) LIKE 'void%'
        AND o.created_at >= $1
        AND o.created_at < $2
      ORDER BY
        COALESCE(
          a.cost_impact,
          (COALESCE(oi.cost_price, 0) / NULLIF(COALESCE(oi.quantity, 0), 0)) * COALESCE(a.quantity, 0)
        ) DESC,
        o.created_at DESC
      LIMIT $3 OFFSET $4
      `,
      [startDate, startDateExclusiveEnd, params.limit, params.offset]
    );

    const s = summaryQ.rows[0] || {};
    return res.status(200).json({
      filters: {
        start_date: startDateIso,
        end_date: endDateIso,
      },
      summary: {
        total_void_items: Number(s.total_void_items || 0),
        total_void_quantity: Number(s.total_void_quantity || 0),
        revenue_loss: Number(s.revenue_loss || 0),
        cost_loss: Number(s.cost_loss || 0),
      },
      item_analysis: (itemAnalysisQ.rows || []).map((r) => ({
        item_name: r.item_name,
        total_void_quantity: Number(r.total_void_quantity || 0),
        total_loss: Number(r.total_loss || 0),
      })),
      void_items: (detailsQ.rows || []).map((r) => ({
        ...r,
        quantity: Number(r.quantity || 0),
        item_price: Number(r.item_price || 0),
        item_cost: Number(r.item_cost || 0),
        revenue_loss: Number(r.revenue_loss || 0),
        cost_loss: Number(r.cost_loss || 0),
      })),
      pagination: buildPagination({ total: totalForPagination, page: params.page, limit: params.limit }),
    });
  } catch (error) {
    logError("GET /api/reports/orders/void-items", error);
    return res.status(500).json({ message: "Failed to fetch void items report." });
  }
};

const getReplacementsReport = async (req, res) => {
  try {
    const params = parseListParams(req.query, { defaultSortBy: "created_at", defaultOrder: "DESC" });
    const dateRange = getSalesDateRange(req.query);
    if (!dateRange) {
      return res.status(400).json({ message: "Invalid date range. Use YYYY-MM-DD and ensure start_date <= end_date." });
    }
    const { startDate, startDateExclusiveEnd, startDateIso, endDateIso } = dateRange;

    const baseCte = `
      WITH replacements_base AS (
        SELECT
          a.id AS adjustment_id,
          a.order_id,
          a.order_item_id AS old_order_item_id,
          COALESCE(a.quantity, 0)::numeric AS replacement_qty,
          a.created_at AS replacement_at,
          o.order_number,
          o.created_at AS order_date,
          COALESCE(oi_old.quantity, 0)::numeric AS old_qty,
          COALESCE(oi_old.price, 0)::numeric AS old_unit_price,
          COALESCE(oi_old.cost_price, 0)::numeric AS old_total_cost,
          COALESCE(a.amount_impact, 0)::numeric AS new_total_price,
          COALESCE(a.cost_impact, 0)::numeric AS new_total_cost,
          COALESCE(mi_old.name || ' - ' || mv_old.name, mi_old.name, mv_old.name, 'Unknown Item') AS original_item_name,
          COALESCE(mi_new.name || ' - ' || mv_new.name, mi_new.name, mv_new.name, 'Unknown Item') AS replacement_item_name,
          COALESCE(oi_new.price, 0)::numeric AS new_unit_price,
          COALESCE(oi_new.quantity, 0)::numeric AS new_qty,
          COALESCE(st_creator.name, st_assigned.name, '—') AS staff_name
        FROM order_adjustments a
        JOIN orders o ON o.id = a.order_id
        LEFT JOIN order_items oi_old ON oi_old.id = a.order_item_id
        LEFT JOIN menu_item_variants mv_old ON mv_old.id = oi_old.variant_id
        LEFT JOIN menu_items mi_old ON mi_old.id = mv_old.item_id
        LEFT JOIN LATERAL (
          SELECT oi2.*
          FROM order_items oi2
          WHERE oi2.order_id = a.order_id
            AND COALESCE(oi2.status, '') = 'replaced'
            AND (a.order_item_id IS NULL OR oi2.id <> a.order_item_id)
          ORDER BY
            CASE
              WHEN COALESCE(oi2.quantity, 0) = COALESCE(a.quantity, 0) THEN 0
              ELSE 1
            END ASC,
            ABS(COALESCE(oi2.quantity, 0) - COALESCE(a.quantity, 0)) ASC,
            oi2.id DESC
          LIMIT 1
        ) oi_new ON TRUE
        LEFT JOIN menu_item_variants mv_new ON mv_new.id = oi_new.variant_id
        LEFT JOIN menu_items mi_new ON mi_new.id = mv_new.item_id
        LEFT JOIN staff_users st_creator ON st_creator.id::text = a.created_by
        LEFT JOIN staff_users st_assigned ON st_assigned.id = o.assigned_staff_id
        WHERE LOWER(COALESCE(a.type, '')) = 'replacement'
          AND o.created_at >= $1
          AND o.created_at < $2
      )
    `;

    const summaryQ = await req.tenantDB.query(
      `
      ${baseCte}
      SELECT
        COUNT(*)::int AS total_replacements,
        COALESCE(SUM(old_unit_price * replacement_qty), 0)::numeric AS total_old_item_value,
        COALESCE(SUM(new_total_price), 0)::numeric AS total_new_item_value,
        COALESCE(
          SUM(
            new_total_cost -
            ((old_total_cost / NULLIF(old_qty, 0)) * replacement_qty)
          ),
          0
        )::numeric AS replacement_cost_impact
      FROM replacements_base
      `,
      [startDate, startDateExclusiveEnd]
    );

    const analysisQ = await req.tenantDB.query(
      `
      ${baseCte}
      SELECT
        original_item_name,
        replacement_item_name,
        COUNT(*)::int AS replacement_count,
        COALESCE(
          SUM(
            new_total_cost -
            ((old_total_cost / NULLIF(old_qty, 0)) * replacement_qty)
          ),
          0
        )::numeric AS total_cost_impact
      FROM replacements_base
      GROUP BY original_item_name, replacement_item_name
      ORDER BY total_cost_impact DESC, replacement_count DESC
      `,
      [startDate, startDateExclusiveEnd]
    );

    const totalQ = await req.tenantDB.query(
      `
      ${baseCte}
      SELECT COUNT(*)::int AS total
      FROM replacements_base
      `,
      [startDate, startDateExclusiveEnd]
    );
    const totalForPagination = Number(totalQ.rows[0]?.total || 0);

    const detailsQ = await req.tenantDB.query(
      `
      ${baseCte}
      SELECT
        adjustment_id,
        order_id,
        order_number,
        order_date AS date,
        original_item_name AS original_item,
        replacement_item_name AS replacement_item,
        old_unit_price AS old_price,
        new_unit_price AS new_price,
        COALESCE((old_total_cost / NULLIF(old_qty, 0)), 0)::numeric AS old_cost,
        COALESCE((new_total_cost / NULLIF(new_qty, 0)), 0)::numeric AS new_cost,
        staff_name
      FROM replacements_base
      ORDER BY
        (new_total_cost - ((old_total_cost / NULLIF(old_qty, 0)) * replacement_qty)) DESC,
        replacement_at DESC
      LIMIT $3 OFFSET $4
      `,
      [startDate, startDateExclusiveEnd, params.limit, params.offset]
    );

    const s = summaryQ.rows[0] || {};
    return res.status(200).json({
      filters: {
        start_date: startDateIso,
        end_date: endDateIso,
      },
      summary: {
        total_replacements: Number(s.total_replacements || 0),
        total_old_item_value: Number(s.total_old_item_value || 0),
        total_new_item_value: Number(s.total_new_item_value || 0),
        replacement_cost_impact: Number(s.replacement_cost_impact || 0),
      },
      item_analysis: (analysisQ.rows || []).map((r) => ({
        original_item_name: r.original_item_name || "Unknown Item",
        replacement_item_name: r.replacement_item_name || "Unknown Item",
        replacement_count: Number(r.replacement_count || 0),
        total_cost_impact: Number(r.total_cost_impact || 0),
      })),
      replacements: (detailsQ.rows || []).map((r) => ({
        ...r,
        old_price: Number(r.old_price || 0),
        new_price: Number(r.new_price || 0),
        old_cost: Number(r.old_cost || 0),
        new_cost: Number(r.new_cost || 0),
      })),
      pagination: buildPagination({ total: totalForPagination, page: params.page, limit: params.limit }),
    });
  } catch (error) {
    logError("GET /api/reports/orders/replacements", error);
    return res.status(500).json({ message: "Failed to fetch replacements report." });
  }
};

const getComplimentaryItemsReport = async (req, res) => {
  try {
    const params = parseListParams(req.query, { defaultSortBy: "created_at", defaultOrder: "DESC" });
    const dateRange = getSalesDateRange(req.query);
    if (!dateRange) {
      return res.status(400).json({ message: "Invalid date range. Use YYYY-MM-DD and ensure start_date <= end_date." });
    }
    const { startDate, startDateExclusiveEnd, startDateIso, endDateIso } = dateRange;

    const summaryQ = await req.tenantDB.query(
      `
      SELECT
        COUNT(*)::int AS total_complimentary_items,
        COALESCE(SUM(oi.quantity), 0)::numeric AS total_quantity,
        COALESCE(SUM(COALESCE(oi.price, 0) * COALESCE(oi.quantity, 0)), 0)::numeric AS total_menu_value,
        COALESCE(SUM(COALESCE(oi.cost_price, 0)), 0)::numeric AS total_cost_impact
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      WHERE COALESCE(oi.is_complimentary, FALSE) = TRUE
        AND o.created_at >= $1
        AND o.created_at < $2
      `,
      [startDate, startDateExclusiveEnd]
    );

    const itemAnalysisQ = await req.tenantDB.query(
      `
      SELECT
        COALESCE(mi.name || ' - ' || mv.name, mi.name, mv.name, 'Unknown Item') AS item_name,
        COALESCE(SUM(oi.quantity), 0)::numeric AS total_quantity,
        COALESCE(SUM(COALESCE(oi.price, 0) * COALESCE(oi.quantity, 0)), 0)::numeric AS total_menu_value,
        COALESCE(SUM(COALESCE(oi.cost_price, 0)), 0)::numeric AS total_cost_impact
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      LEFT JOIN menu_item_variants mv ON mv.id = oi.variant_id
      LEFT JOIN menu_items mi ON mi.id = mv.item_id
      WHERE COALESCE(oi.is_complimentary, FALSE) = TRUE
        AND o.created_at >= $1
        AND o.created_at < $2
      GROUP BY COALESCE(mi.name || ' - ' || mv.name, mi.name, mv.name, 'Unknown Item')
      ORDER BY total_quantity DESC, total_cost_impact DESC
      `,
      [startDate, startDateExclusiveEnd]
    );

    const totalQ = await req.tenantDB.query(
      `
      SELECT COUNT(*)::int AS total
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      WHERE COALESCE(oi.is_complimentary, FALSE) = TRUE
        AND o.created_at >= $1
        AND o.created_at < $2
      `,
      [startDate, startDateExclusiveEnd]
    );
    const totalForPagination = Number(totalQ.rows[0]?.total || 0);

    const detailsQ = await req.tenantDB.query(
      `
      SELECT
        oi.id AS order_item_id,
        o.id AS order_id,
        o.order_number,
        o.created_at AS date,
        t.name AS table_name,
        COALESCE(mi.name || ' - ' || mv.name, mi.name, mv.name, 'Unknown Item') AS item_name,
        COALESCE(oi.quantity, 0)::numeric AS quantity,
        COALESCE(oi.price, 0)::numeric AS menu_price,
        COALESCE((COALESCE(oi.cost_price, 0) / NULLIF(COALESCE(oi.quantity, 0), 0)), 0)::numeric AS cost_price,
        COALESCE(COALESCE(oi.price, 0) * COALESCE(oi.quantity, 0), 0)::numeric AS menu_value,
        COALESCE(oi.cost_price, 0)::numeric AS cost_impact,
        su.name AS assigned_staff
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      LEFT JOIN tables t ON t.id = o.table_id
      LEFT JOIN menu_item_variants mv ON mv.id = oi.variant_id
      LEFT JOIN menu_items mi ON mi.id = mv.item_id
      LEFT JOIN staff_users su ON su.id = o.assigned_staff_id
      WHERE COALESCE(oi.is_complimentary, FALSE) = TRUE
        AND o.created_at >= $1
        AND o.created_at < $2
      ORDER BY oi.quantity DESC, o.created_at DESC
      LIMIT $3 OFFSET $4
      `,
      [startDate, startDateExclusiveEnd, params.limit, params.offset]
    );

    const s = summaryQ.rows[0] || {};
    return res.status(200).json({
      filters: {
        start_date: startDateIso,
        end_date: endDateIso,
      },
      summary: {
        total_complimentary_items: Number(s.total_complimentary_items || 0),
        total_quantity: Number(s.total_quantity || 0),
        total_menu_value: Number(s.total_menu_value || 0),
        total_cost_impact: Number(s.total_cost_impact || 0),
      },
      item_analysis: (itemAnalysisQ.rows || []).map((r) => ({
        item_name: r.item_name || "Unknown Item",
        total_quantity: Number(r.total_quantity || 0),
        total_menu_value: Number(r.total_menu_value || 0),
        total_cost_impact: Number(r.total_cost_impact || 0),
      })),
      complimentary_items: (detailsQ.rows || []).map((r) => ({
        ...r,
        quantity: Number(r.quantity || 0),
        menu_price: Number(r.menu_price || 0),
        cost_price: Number(r.cost_price || 0),
        menu_value: Number(r.menu_value || 0),
        cost_impact: Number(r.cost_impact || 0),
      })),
      pagination: buildPagination({ total: totalForPagination, page: params.page, limit: params.limit }),
    });
  } catch (error) {
    logError("GET /api/reports/orders/complimentary", error);
    return res.status(500).json({ message: "Failed to fetch complimentary items report." });
  }
};

const listTipsReport = async (req, res) => {
  try {
    const params = parseListParams(req.query, { defaultSortBy: "created_at", defaultOrder: "DESC" });
    const range = String(req.query?.range || "day").trim().toLowerCase();
    const allowedRanges = new Set(["day", "week", "month"]);
    const rangeStart = startOfRange(allowedRanges.has(range) ? range : "day");

    const totalQ = await req.tenantDB.query(
      `
      SELECT
        COUNT(*)::int AS total,
        COALESCE(SUM(o.tip_amount), 0)::numeric AS total_tip
      FROM orders o
      WHERE o.created_at >= $1
        AND o.tip_amount > 0
      `,
      [rangeStart]
    );

    const total = totalQ.rows[0]?.total ?? 0;
    const totalTip = Number(totalQ.rows[0]?.total_tip || 0);

    const dataQ = await req.tenantDB.query(
      `
      SELECT
        o.id AS order_id,
        o.order_number,
        o.created_at,
        o.order_type,
        t.name AS table_name,
        o.guest_name,
        o.total_amount,
        o.tip_amount
      FROM orders o
      LEFT JOIN tables t ON t.id = o.table_id
      WHERE o.created_at >= $1
        AND o.tip_amount > 0
      ORDER BY o.created_at DESC
      LIMIT $2 OFFSET $3
      `,
      [rangeStart, params.limit, params.offset]
    );

    return res.status(200).json({
      orders: dataQ.rows || [],
      total_tip: totalTip,
      pagination: buildPagination({ total, page: params.page, limit: params.limit }),
    });
  } catch (error) {
    logError("GET /api/reports/tips", error);
    return res.status(500).json({ message: "Failed to fetch tips report." });
  }
};

const listDiscountsReport = async (req, res) => {
  try {
    const params = parseListParams(req.query, { defaultSortBy: "created_at", defaultOrder: "DESC" });
    const range = String(req.query?.range || "day").trim().toLowerCase();
    const allowedRanges = new Set(["day", "week", "month"]);
    const rangeStart = startOfRange(allowedRanges.has(range) ? range : "day");

    const totalQ = await req.tenantDB.query(
      `
      SELECT
        COUNT(*)::int AS total,
        COALESCE(SUM(o.discount_amount), 0)::numeric AS total_discount
      FROM orders o
      WHERE o.created_at >= $1
        AND o.discount_amount > 0
      `,
      [rangeStart]
    );

    const total = totalQ.rows[0]?.total ?? 0;
    const totalDiscount = Number(totalQ.rows[0]?.total_discount || 0);

    const dataQ = await req.tenantDB.query(
      `
      SELECT
        o.id AS order_id,
        o.order_number,
        o.created_at,
        o.order_type,
        t.name AS table_name,
        o.guest_name,
        o.total_amount,
        o.discount_amount
      FROM orders o
      LEFT JOIN tables t ON t.id = o.table_id
      WHERE o.created_at >= $1
        AND o.discount_amount > 0
      ORDER BY o.created_at DESC
      LIMIT $2 OFFSET $3
      `,
      [rangeStart, params.limit, params.offset]
    );

    return res.status(200).json({
      orders: dataQ.rows || [],
      total_discount: totalDiscount,
      pagination: buildPagination({ total, page: params.page, limit: params.limit }),
    });
  } catch (error) {
    logError("GET /api/reports/discounts", error);
    return res.status(500).json({ message: "Failed to fetch discounts report." });
  }
};

const listStaffReport = async (req, res) => {
  try {
    const params = parseListParams(req.query, { defaultSortBy: "name", defaultOrder: "ASC" });
    const search = String(params.search || "").trim();

    const whereParts = [];
    const args = [];
    if (search) {
      args.push(`%${search}%`);
      whereParts.push(`(s.name ILIKE $${args.length} OR s.email ILIKE $${args.length} OR s.phone ILIKE $${args.length})`);
    }
    const where = whereParts.length ? `WHERE ${whereParts.join(" AND ")}` : "";

    const totalQ = await req.tenantDB.query(
      `
      SELECT COUNT(*)::int AS total
      FROM staff_users s
      ${where}
      `,
      args
    );
    const total = totalQ.rows[0]?.total ?? 0;

    const dataArgs = [...args, params.limit, params.offset];
    const limitIdx = dataArgs.length - 1;
    const offsetIdx = dataArgs.length;
    const q = await req.tenantDB.query(
      `
      SELECT
        s.id,
        s.name,
        s.email,
        s.phone,
        s.is_active,
        COALESCE(agg.orders_count, 0)::int AS orders_count,
        COALESCE(agg.completed_orders_count, 0)::int AS completed_orders_count,
        COALESCE(agg.total_tip, 0)::numeric AS total_tip
      FROM staff_users s
      LEFT JOIN (
        SELECT
          o.assigned_staff_id,
          COUNT(*) AS orders_count,
          COUNT(*) FILTER (WHERE LOWER(COALESCE(o.status, '')) = 'completed') AS completed_orders_count,
          COALESCE(SUM(o.tip_amount), 0)::numeric AS total_tip
        FROM orders o
        WHERE o.assigned_staff_id IS NOT NULL
        GROUP BY o.assigned_staff_id
      ) agg ON agg.assigned_staff_id = s.id
      ${where}
      ORDER BY s.name ASC
      LIMIT $${limitIdx} OFFSET $${offsetIdx}
      `,
      dataArgs
    );

    return res.status(200).json({
      staff: q.rows || [],
      pagination: buildPagination({ total, page: params.page, limit: params.limit }),
    });
  } catch (error) {
    logError("GET /api/reports/staff", error);
    return res.status(500).json({ message: "Failed to fetch staff report." });
  }
};

const listStaffOrdersReport = async (req, res) => {
  const staffId = String(req.params?.staff_id || "").trim();
  if (!staffId) return res.status(400).json({ message: "staff_id is required." });

  try {
    const params = parseListParams(req.query, { defaultSortBy: "created_at", defaultOrder: "DESC" });
    const range = String(req.query?.range || "month").trim().toLowerCase();
    const allowedRanges = new Set(["day", "week", "month", "all"]);
    const finalRange = allowedRanges.has(range) ? range : "month";

    const staffQ = await req.tenantDB.query(
      `
      SELECT id, name, email, phone, is_active
      FROM staff_users
      WHERE id = $1
      LIMIT 1
      `,
      [staffId]
    );
    if (staffQ.rowCount === 0) return res.status(404).json({ message: "Staff not found." });

    const whereParts = ["o.assigned_staff_id = $1"];
    const args = [staffId];
    if (finalRange !== "all") {
      args.push(startOfRange(finalRange));
      whereParts.push(`o.created_at >= $${args.length}`);
    }
    if (params.search) {
      args.push(`%${params.search}%`);
      whereParts.push(`(o.order_number ILIKE $${args.length} OR t.name ILIKE $${args.length})`);
    }
    const where = `WHERE ${whereParts.join(" AND ")}`;

    const summaryQ = await req.tenantDB.query(
      `
      SELECT
        COUNT(*)::int AS total_orders,
        COALESCE(SUM(o.total_amount), 0)::numeric AS total_amount,
        COALESCE(SUM(o.tip_amount), 0)::numeric AS total_tip
      FROM orders o
      LEFT JOIN tables t ON t.id = o.table_id
      ${where}
      `,
      args
    );

    const total = Number(summaryQ.rows[0]?.total_orders || 0);
    const totalAmount = Number(summaryQ.rows[0]?.total_amount || 0);
    const totalTip = Number(summaryQ.rows[0]?.total_tip || 0);

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
        o.payment_status,
        o.created_at,
        o.completed_at,
        o.guest_name,
        t.name AS table_name,
        o.total_amount,
        o.tip_amount
      FROM orders o
      LEFT JOIN tables t ON t.id = o.table_id
      ${where}
      ORDER BY o.created_at DESC
      LIMIT $${limitIdx} OFFSET $${offsetIdx}
      `,
      dataArgs
    );

    return res.status(200).json({
      staff: staffQ.rows[0],
      summary: {
        total_orders: total,
        total_amount: totalAmount,
        total_tip: totalTip,
      },
      orders: ordersQ.rows || [],
      pagination: buildPagination({ total, page: params.page, limit: params.limit }),
    });
  } catch (error) {
    logError("GET /api/reports/staff/:staff_id/orders", error);
    return res.status(500).json({ message: "Failed to fetch staff orders report." });
  }
};

const getStaffPerformanceReport = async (req, res) => {
  try {
    const dateRange = getSalesDateRange(req.query);
    if (!dateRange) {
      return res.status(400).json({ message: "Invalid date range. Use YYYY-MM-DD and ensure start_date <= end_date." });
    }
    const { startDate, startDateExclusiveEnd, startDateIso, endDateIso } = dateRange;

    const staffIdRaw = String(req.query?.staff_id || "").trim();
    if (staffIdRaw && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(staffIdRaw)) {
      return res.status(400).json({ message: "Invalid staff_id." });
    }
    const staffId = staffIdRaw || null;
    const sortByRaw = String(req.query?.sort_by || "revenue").trim().toLowerCase();
    const sortBy = sortByRaw === "completed_orders" ? "completed_orders" : "revenue";

    const reportQ = await req.tenantDB.query(
      `
      WITH payment_totals AS (
        SELECT p.order_id, COALESCE(SUM(p.paid_amount), 0)::numeric AS paid_amount
        FROM payments p
        GROUP BY p.order_id
      ),
      base_orders AS (
        SELECT
          o.id AS order_id,
          o.assigned_staff_id,
          LOWER(COALESCE(o.status, '')) AS status,
          COALESCE(pt.paid_amount, 0)::numeric AS paid_amount,
          COALESCE(o.tip_amount, 0)::numeric AS tip_amount,
          COALESCE(o.total_profit, 0)::numeric AS total_profit
        FROM orders o
        LEFT JOIN payment_totals pt ON pt.order_id = o.id
        WHERE o.assigned_staff_id IS NOT NULL
          AND o.created_at >= $1
          AND o.created_at < $2
          AND ($3::uuid IS NULL OR o.assigned_staff_id = $3::uuid)
      ),
      staff_perf AS (
        SELECT
          bo.assigned_staff_id AS staff_id,
          COUNT(*)::int AS total_orders_handled,
          COUNT(*) FILTER (WHERE bo.status = 'completed')::int AS completed_orders,
          COUNT(*) FILTER (WHERE bo.status = 'cancelled')::int AS cancelled_orders,
          COALESCE(SUM(bo.paid_amount), 0)::numeric AS total_revenue_generated,
          COALESCE(SUM(bo.tip_amount), 0)::numeric AS total_tip_earned,
          COALESCE(SUM(bo.total_profit), 0)::numeric AS total_profit_generated
        FROM base_orders bo
        GROUP BY bo.assigned_staff_id
      )
      SELECT
        sp.staff_id,
        COALESCE(su.name, 'Deleted Staff') AS staff_name,
        COALESCE(su.is_active, FALSE) AS is_active,
        sp.total_orders_handled,
        sp.completed_orders,
        sp.cancelled_orders,
        sp.total_revenue_generated,
        sp.total_tip_earned,
        sp.total_profit_generated,
        CASE
          WHEN sp.total_orders_handled > 0 THEN (sp.total_revenue_generated / sp.total_orders_handled)::numeric
          ELSE 0::numeric
        END AS average_order_value,
        CASE
          WHEN sp.total_orders_handled > 0 THEN (sp.total_tip_earned / sp.total_orders_handled)::numeric
          ELSE 0::numeric
        END AS average_tip_per_order
      FROM staff_perf sp
      LEFT JOIN staff_users su ON su.id = sp.staff_id
      ORDER BY
        CASE WHEN $4::text = 'completed_orders' THEN sp.completed_orders ELSE 0 END DESC,
        CASE WHEN $4::text <> 'completed_orders' THEN sp.total_revenue_generated ELSE 0 END DESC,
        sp.completed_orders DESC,
        sp.total_orders_handled DESC
      `,
      [startDate, startDateExclusiveEnd, staffId, sortBy]
    );

    const rows = (reportQ.rows || []).map((row, idx) => ({
      rank: idx + 1,
      staff_id: row.staff_id,
      staff_name: row.staff_name || "Deleted Staff",
      is_active: Boolean(row.is_active),
      total_orders_handled: Number(row.total_orders_handled || 0),
      completed_orders: Number(row.completed_orders || 0),
      cancelled_orders: Number(row.cancelled_orders || 0),
      total_revenue_generated: Number(row.total_revenue_generated || 0),
      total_tip_earned: Number(row.total_tip_earned || 0),
      total_profit_generated: Number(row.total_profit_generated || 0),
      average_order_value: Number(row.average_order_value || 0),
      average_tip_per_order: Number(row.average_tip_per_order || 0),
    }));

    const topStaffId = rows[0]?.staff_id || null;
    const decoratedRows = rows.map((row) => ({
      ...row,
      top_performer: Boolean(topStaffId && row.staff_id === topStaffId),
    }));

    const summary = decoratedRows.reduce(
      (acc, row) => {
        acc.total_staff += 1;
        acc.total_orders += row.total_orders_handled;
        acc.total_revenue += row.total_revenue_generated;
        acc.total_tips += row.total_tip_earned;
        acc.total_profit += row.total_profit_generated;
        return acc;
      },
      { total_staff: 0, total_orders: 0, total_revenue: 0, total_tips: 0, total_profit: 0 }
    );

    return res.status(200).json({
      filters: {
        start_date: startDateIso,
        end_date: endDateIso,
        staff_id: staffId,
        sort_by: sortBy,
      },
      summary,
      chart: decoratedRows.map((row) => ({
        staff_id: row.staff_id,
        staff_name: row.staff_name,
        revenue: row.total_revenue_generated,
        orders: row.total_orders_handled,
      })),
      staff: decoratedRows,
      staff_options: decoratedRows.map((row) => ({
        id: row.staff_id,
        name: row.staff_name,
      })),
    });
  } catch (error) {
    logError("GET /api/reports/staff/performance", error);
    return res.status(500).json({ message: "Failed to fetch staff performance report." });
  }
};

const getStaffTipsReport = async (req, res) => {
  try {
    const dateRange = getSalesDateRange(req.query);
    if (!dateRange) {
      return res.status(400).json({ message: "Invalid date range. Use YYYY-MM-DD and ensure start_date <= end_date." });
    }
    const { startDate, startDateExclusiveEnd, startDateIso, endDateIso } = dateRange;

    const staffIdRaw = String(req.query?.staff_id || "").trim();
    if (staffIdRaw && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(staffIdRaw)) {
      return res.status(400).json({ message: "Invalid staff_id." });
    }
    const staffId = staffIdRaw || null;

    const summaryQ = await req.tenantDB.query(
      `
      SELECT
        COALESCE(SUM(COALESCE(o.tip_amount, 0)), 0)::numeric AS total_tips_collected,
        COUNT(*)::int AS total_tipped_orders
      FROM orders o
      WHERE LOWER(COALESCE(o.status, '')) = 'completed'
        AND COALESCE(o.tip_amount, 0) > 0
        AND o.created_at >= $1
        AND o.created_at < $2
        AND ($3::uuid IS NULL OR o.assigned_staff_id = $3::uuid)
      `,
      [startDate, startDateExclusiveEnd, staffId]
    );

    const staffQ = await req.tenantDB.query(
      `
      SELECT
        o.assigned_staff_id AS staff_id,
        COALESCE(su.name, 'Unassigned') AS staff_name,
        COALESCE(su.is_active, FALSE) AS is_active,
        COALESCE(SUM(COALESCE(o.tip_amount, 0)), 0)::numeric AS total_tips,
        COUNT(*)::int AS tipped_orders,
        COALESCE(AVG(COALESCE(o.tip_amount, 0)), 0)::numeric AS average_tip,
        COALESCE(MAX(COALESCE(o.tip_amount, 0)), 0)::numeric AS highest_single_tip
      FROM orders o
      LEFT JOIN staff_users su ON su.id = o.assigned_staff_id
      WHERE LOWER(COALESCE(o.status, '')) = 'completed'
        AND COALESCE(o.tip_amount, 0) > 0
        AND o.created_at >= $1
        AND o.created_at < $2
        AND ($3::uuid IS NULL OR o.assigned_staff_id = $3::uuid)
      GROUP BY o.assigned_staff_id, su.name, su.is_active
      ORDER BY total_tips DESC, tipped_orders DESC, average_tip DESC
      `,
      [startDate, startDateExclusiveEnd, staffId]
    );

    const trendQ = await req.tenantDB.query(
      `
      SELECT
        TO_CHAR(o.created_at::date, 'YYYY-MM-DD') AS date,
        COALESCE(SUM(COALESCE(o.tip_amount, 0)), 0)::numeric AS total_tips
      FROM orders o
      WHERE LOWER(COALESCE(o.status, '')) = 'completed'
        AND COALESCE(o.tip_amount, 0) > 0
        AND o.created_at >= $1
        AND o.created_at < $2
        AND ($3::uuid IS NULL OR o.assigned_staff_id = $3::uuid)
      GROUP BY o.created_at::date
      ORDER BY o.created_at::date ASC
      `,
      [startDate, startDateExclusiveEnd, staffId]
    );

    const summaryRow = summaryQ.rows[0] || {};
    const totalTipsCollected = Number(summaryRow.total_tips_collected || 0);
    const totalTippedOrders = Number(summaryRow.total_tipped_orders || 0);
    const averageTipPerOrder = totalTippedOrders > 0 ? totalTipsCollected / totalTippedOrders : 0;

    const staffTips = (staffQ.rows || []).map((row, idx) => ({
      rank: idx + 1,
      staff_id: row.staff_id,
      staff_name: row.staff_name || "Unassigned",
      is_active: Boolean(row.is_active),
      total_tips: Number(row.total_tips || 0),
      tipped_orders: Number(row.tipped_orders || 0),
      average_tip: Number(row.average_tip || 0),
      highest_single_tip: Number(row.highest_single_tip || 0),
      top_earner: idx === 0,
    }));

    return res.status(200).json({
      filters: {
        start_date: startDateIso,
        end_date: endDateIso,
        staff_id: staffId,
      },
      summary: {
        total_tips_collected: totalTipsCollected,
        total_tipped_orders: totalTippedOrders,
        average_tip_per_order: averageTipPerOrder,
      },
      chart: [
        {
          key: "tips_by_staff",
          data: staffTips.map((row) => ({
            staff_id: row.staff_id,
            staff_name: row.staff_name,
            total_tips: row.total_tips,
            tipped_orders: row.tipped_orders,
          })),
        },
        {
          key: "tips_over_time",
          data: (trendQ.rows || []).map((row) => ({
            date: row.date,
            total_tips: Number(row.total_tips || 0),
          })),
        },
      ],
      staff_tips: staffTips,
      staff_options: staffTips
        .filter((row) => row.staff_id)
        .map((row) => ({
          id: row.staff_id,
          name: row.staff_name,
        })),
    });
  } catch (error) {
    logError("GET /api/reports/staff/tips", error);
    return res.status(500).json({ message: "Failed to fetch staff tips report." });
  }
};

const getInventoryConsumptionReport = async (req, res) => {
  try {
    const dateRange = getSalesDateRange(req.query);
    if (!dateRange) {
      return res.status(400).json({ message: "Invalid date range. Use YYYY-MM-DD and ensure start_date <= end_date." });
    }
    const { startDate, startDateExclusiveEnd, startDateIso, endDateIso } = dateRange;

    const ingredientIdRaw = String(req.query?.ingredient_id || "").trim();
    if (ingredientIdRaw && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(ingredientIdRaw)) {
      return res.status(400).json({ message: "Invalid ingredient_id." });
    }
    const ingredientId = ingredientIdRaw || null;

    const baseCte = `
      WITH consumption_base AS (
        SELECT
          c.order_id,
          c.order_item_id,
          c.raw_material_id AS ingredient_id,
          COALESCE(c.quantity_used, 0)::numeric AS quantity_used,
          COALESCE(rm.purchase_price, 0)::numeric AS purchase_price,
          COALESCE(NULLIF(rm.conversion_factor, 0), 1)::numeric AS conversion_factor,
          COALESCE(rm.name, 'Deleted Ingredient') AS ingredient_name,
          COALESCE(u.name, 'Unit') AS unit_name
        FROM order_item_consumptions c
        JOIN orders o ON o.id = c.order_id
        LEFT JOIN raw_materials rm ON rm.id = c.raw_material_id
        LEFT JOIN units u ON u.id = rm.consumption_unit_id
        WHERE LOWER(COALESCE(o.status, '')) IN ('served', 'completed')
          AND o.created_at >= $1
          AND o.created_at < $2
          AND ($3::uuid IS NULL OR c.raw_material_id = $3::uuid)
      )
    `;

    const summaryQ = await req.tenantDB.query(
      `
      ${baseCte}
      SELECT
        COUNT(DISTINCT ingredient_id)::int AS total_items_consumed,
        COALESCE(SUM(quantity_used), 0)::numeric AS total_quantity_consumed,
        COALESCE(SUM((quantity_used / conversion_factor) * purchase_price), 0)::numeric AS total_inventory_cost
      FROM consumption_base
      `,
      [startDate, startDateExclusiveEnd, ingredientId]
    );

    const ingredientsQ = await req.tenantDB.query(
      `
      ${baseCte}
      SELECT
        ingredient_id,
        ingredient_name,
        unit_name,
        COALESCE(SUM(quantity_used), 0)::numeric AS total_quantity_used,
        COALESCE(SUM((quantity_used / conversion_factor) * purchase_price), 0)::numeric AS total_cost_used,
        COUNT(DISTINCT order_id)::int AS related_orders_count
      FROM consumption_base
      GROUP BY ingredient_id, ingredient_name, unit_name
      ORDER BY total_quantity_used DESC, total_cost_used DESC
      `,
      [startDate, startDateExclusiveEnd, ingredientId]
    );

    const topQtyQ = await req.tenantDB.query(
      `
      ${baseCte}
      SELECT
        ingredient_id,
        ingredient_name,
        unit_name,
        COALESCE(SUM(quantity_used), 0)::numeric AS total_quantity_used,
        COALESCE(SUM((quantity_used / conversion_factor) * purchase_price), 0)::numeric AS total_cost_used
      FROM consumption_base
      GROUP BY ingredient_id, ingredient_name, unit_name
      ORDER BY total_quantity_used DESC, total_cost_used DESC
      LIMIT 10
      `,
      [startDate, startDateExclusiveEnd, ingredientId]
    );

    const topCostQ = await req.tenantDB.query(
      `
      ${baseCte}
      SELECT
        ingredient_id,
        ingredient_name,
        unit_name,
        COALESCE(SUM(quantity_used), 0)::numeric AS total_quantity_used,
        COALESCE(SUM((quantity_used / conversion_factor) * purchase_price), 0)::numeric AS total_cost_used
      FROM consumption_base
      GROUP BY ingredient_id, ingredient_name, unit_name
      ORDER BY total_cost_used DESC, total_quantity_used DESC
      LIMIT 10
      `,
      [startDate, startDateExclusiveEnd, ingredientId]
    );

    const summaryRow = summaryQ.rows[0] || {};
    return res.status(200).json({
      filters: {
        start_date: startDateIso,
        end_date: endDateIso,
        ingredient_id: ingredientId,
      },
      summary: {
        total_items_consumed: Number(summaryRow.total_items_consumed || 0),
        total_quantity_consumed: Number(summaryRow.total_quantity_consumed || 0),
        total_inventory_cost: Number(summaryRow.total_inventory_cost || 0),
      },
      top_consumed: {
        by_quantity: (topQtyQ.rows || []).map((row, idx) => ({
          rank: idx + 1,
          ingredient_id: row.ingredient_id,
          ingredient_name: row.ingredient_name || "Deleted Ingredient",
          unit_name: row.unit_name || "Unit",
          total_quantity_used: Number(row.total_quantity_used || 0),
          total_cost_used: Number(row.total_cost_used || 0),
        })),
        by_cost: (topCostQ.rows || []).map((row, idx) => ({
          rank: idx + 1,
          ingredient_id: row.ingredient_id,
          ingredient_name: row.ingredient_name || "Deleted Ingredient",
          unit_name: row.unit_name || "Unit",
          total_quantity_used: Number(row.total_quantity_used || 0),
          total_cost_used: Number(row.total_cost_used || 0),
        })),
      },
      ingredients: (ingredientsQ.rows || []).map((row) => ({
        ingredient_id: row.ingredient_id,
        ingredient_name: row.ingredient_name || "Deleted Ingredient",
        unit_name: row.unit_name || "Unit",
        total_quantity_used: Number(row.total_quantity_used || 0),
        total_cost_used: Number(row.total_cost_used || 0),
        related_orders_count: Number(row.related_orders_count || 0),
      })),
      ingredient_options: (ingredientsQ.rows || []).map((row) => ({
        id: row.ingredient_id,
        name: row.ingredient_name || "Deleted Ingredient",
      })),
    });
  } catch (error) {
    logError("GET /api/reports/inventory/consumption", error);
    return res.status(500).json({ message: "Failed to fetch inventory consumption report." });
  }
};

const getInventoryPurchasesReport = async (req, res) => {
  try {
    const params = parseListParams(req.query, { defaultSortBy: "created_at", defaultOrder: "DESC" });
    const dateRange = getSalesDateRange(req.query);
    if (!dateRange) {
      return res.status(400).json({ message: "Invalid date range. Use YYYY-MM-DD and ensure start_date <= end_date." });
    }
    const { startDate, startDateExclusiveEnd, startDateIso, endDateIso } = dateRange;

    const supplierIdRaw = String(req.query?.supplier_id || "").trim();
    if (supplierIdRaw && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(supplierIdRaw)) {
      return res.status(400).json({ message: "Invalid supplier_id." });
    }
    const supplierId = supplierIdRaw || null;

    const summaryQ = await req.tenantDB.query(
      `
      SELECT
        COUNT(*)::int AS total_purchase_orders,
        COALESCE(SUM(COALESCE(po.purchase_total, 0)), 0)::numeric AS total_purchase_amount,
        COALESCE(SUM(COALESCE(po.gst_amount, 0)), 0)::numeric AS total_gst_paid
      FROM purchase_orders po
      WHERE po.created_at >= $1
        AND po.created_at < $2
        AND ($3::uuid IS NULL OR po.supplier_id = $3::uuid)
      `,
      [startDate, startDateExclusiveEnd, supplierId]
    );

    const totalItemsQ = await req.tenantDB.query(
      `
      SELECT
        COALESCE(SUM(COALESCE(poi.ordered_quantity, 0)), 0)::numeric AS total_items_purchased
      FROM purchase_order_items poi
      JOIN purchase_orders po ON po.id = poi.purchase_order_id
      WHERE po.created_at >= $1
        AND po.created_at < $2
        AND ($3::uuid IS NULL OR po.supplier_id = $3::uuid)
      `,
      [startDate, startDateExclusiveEnd, supplierId]
    );

    const suppliersQ = await req.tenantDB.query(
      `
      SELECT
        po.supplier_id,
        COALESCE(s.name, 'Unknown Supplier') AS supplier_name,
        COUNT(*)::int AS total_orders,
        COALESCE(SUM(COALESCE(po.purchase_total, 0)), 0)::numeric AS total_spent,
        COALESCE(SUM(COALESCE(po.gst_amount, 0)), 0)::numeric AS gst_paid
      FROM purchase_orders po
      LEFT JOIN suppliers s ON s.id = po.supplier_id
      WHERE po.created_at >= $1
        AND po.created_at < $2
        AND ($3::uuid IS NULL OR po.supplier_id = $3::uuid)
      GROUP BY po.supplier_id, s.name
      ORDER BY total_spent DESC, total_orders DESC
      `,
      [startDate, startDateExclusiveEnd, supplierId]
    );

    const itemsQ = await req.tenantDB.query(
      `
      SELECT
        poi.raw_material_id AS item_id,
        COALESCE(rm.name, 'Deleted Item') AS item_name,
        COALESCE(u.name, 'Unit') AS purchase_unit_name,
        COALESCE(SUM(COALESCE(poi.ordered_quantity, 0)), 0)::numeric AS quantity_purchased,
        COALESCE(SUM(COALESCE(poi.ordered_quantity, 0) * COALESCE(rm.purchase_price, 0)), 0)::numeric AS purchase_cost
      FROM purchase_order_items poi
      JOIN purchase_orders po ON po.id = poi.purchase_order_id
      LEFT JOIN raw_materials rm ON rm.id = poi.raw_material_id
      LEFT JOIN units u ON u.id = rm.purchase_unit_id
      WHERE po.created_at >= $1
        AND po.created_at < $2
        AND ($3::uuid IS NULL OR po.supplier_id = $3::uuid)
      GROUP BY poi.raw_material_id, rm.name, u.name
      ORDER BY quantity_purchased DESC, purchase_cost DESC
      `,
      [startDate, startDateExclusiveEnd, supplierId]
    );

    const totalPurchasesQ = await req.tenantDB.query(
      `
      SELECT COUNT(*)::int AS total
      FROM purchase_orders po
      WHERE po.created_at >= $1
        AND po.created_at < $2
        AND ($3::uuid IS NULL OR po.supplier_id = $3::uuid)
      `,
      [startDate, startDateExclusiveEnd, supplierId]
    );
    const totalForPagination = Number(totalPurchasesQ.rows[0]?.total || 0);

    const purchasesQ = await req.tenantDB.query(
      `
      SELECT
        po.id AS purchase_id,
        po.po_number AS purchase_number,
        po.created_at AS date,
        COALESCE(s.name, 'Unknown Supplier') AS supplier_name,
        COALESCE(po.purchase_total, 0)::numeric AS total_amount,
        COALESCE(po.gst_amount, 0)::numeric AS gst_amount,
        (COALESCE(po.purchase_total, 0) + COALESCE(po.gst_amount, 0))::numeric AS final_amount,
        COALESCE(ic.items_count, 0)::int AS items_count
      FROM purchase_orders po
      LEFT JOIN suppliers s ON s.id = po.supplier_id
      LEFT JOIN (
        SELECT purchase_order_id, COUNT(*)::int AS items_count
        FROM purchase_order_items
        GROUP BY purchase_order_id
      ) ic ON ic.purchase_order_id = po.id
      WHERE po.created_at >= $1
        AND po.created_at < $2
        AND ($3::uuid IS NULL OR po.supplier_id = $3::uuid)
      ORDER BY po.created_at DESC
      LIMIT $4 OFFSET $5
      `,
      [startDate, startDateExclusiveEnd, supplierId, params.limit, params.offset]
    );

    const summaryRow = summaryQ.rows[0] || {};
    const totalItemsRow = totalItemsQ.rows[0] || {};

    return res.status(200).json({
      filters: {
        start_date: startDateIso,
        end_date: endDateIso,
        supplier_id: supplierId,
      },
      summary: {
        total_purchase_orders: Number(summaryRow.total_purchase_orders || 0),
        total_purchase_amount: Number(summaryRow.total_purchase_amount || 0),
        total_gst_paid: Number(summaryRow.total_gst_paid || 0),
        total_items_purchased: Number(totalItemsRow.total_items_purchased || 0),
      },
      suppliers: (suppliersQ.rows || []).map((row) => ({
        supplier_id: row.supplier_id,
        supplier_name: row.supplier_name || "Unknown Supplier",
        total_orders: Number(row.total_orders || 0),
        total_spent: Number(row.total_spent || 0),
        gst_paid: Number(row.gst_paid || 0),
      })),
      items: (itemsQ.rows || []).map((row) => ({
        item_id: row.item_id,
        item_name: row.item_name || "Deleted Item",
        purchase_unit_name: row.purchase_unit_name || "Unit",
        quantity_purchased: Number(row.quantity_purchased || 0),
        purchase_cost: Number(row.purchase_cost || 0),
      })),
      purchases: (purchasesQ.rows || []).map((row) => ({
        purchase_id: row.purchase_id,
        purchase_number: row.purchase_number,
        date: row.date,
        supplier_name: row.supplier_name || "Unknown Supplier",
        total_amount: Number(row.total_amount || 0),
        gst_amount: Number(row.gst_amount || 0),
        final_amount: Number(row.final_amount || 0),
        items_count: Number(row.items_count || 0),
      })),
      pagination: buildPagination({ total: totalForPagination, page: params.page, limit: params.limit }),
      supplier_options: (suppliersQ.rows || []).map((row) => ({
        id: row.supplier_id,
        name: row.supplier_name || "Unknown Supplier",
      })),
    });
  } catch (error) {
    logError("GET /api/reports/inventory/purchases", error);
    return res.status(500).json({ message: "Failed to fetch inventory purchases report." });
  }
};

const getGstSummaryReport = async (req, res) => {
  try {
    const hasExplicitDates = Boolean(req.query?.start_date || req.query?.end_date);
    const explicitRange = hasExplicitDates ? getSalesDateRange(req.query) : null;
    if (hasExplicitDates && !explicitRange) {
      return res.status(400).json({ message: "Invalid date range. Use YYYY-MM-DD and ensure start_date <= end_date." });
    }

    const range = String(req.query?.range || "month").trim().toLowerCase();
    const allowedRanges = new Set(["day", "week", "month"]);
    const fallbackRange = allowedRanges.has(range) ? range : "month";
    const fallbackStart = startOfRange(fallbackRange);
    const fallbackEnd = new Date();
    fallbackEnd.setHours(0, 0, 0, 0);

    const startDate = explicitRange ? explicitRange.startDate : fallbackStart;
    const endDate = explicitRange ? explicitRange.endDate : fallbackEnd;
    const endExclusive = explicitRange ? explicitRange.startDateExclusiveEnd : addDays(fallbackEnd, 1);
    const startDateIso = explicitRange ? explicitRange.startDateIso : toYmd(fallbackStart);
    const endDateIso = explicitRange ? explicitRange.endDateIso : toYmd(fallbackEnd);

    const outputQ = await req.tenantDB.query(
      `
      SELECT
        COALESCE(SUM(COALESCE(o.tax_amount, 0)), 0)::numeric AS output_gst
      FROM orders o
      WHERE LOWER(COALESCE(o.status, '')) = 'completed'
        AND o.created_at >= $1
        AND o.created_at < $2
      `,
      [startDate, endExclusive]
    );

    const inputQ = await req.tenantDB.query(
      `
      SELECT
        COALESCE(SUM(COALESCE(po.gst_amount, 0)), 0)::numeric AS input_gst
      FROM purchase_orders po
      WHERE po.created_at >= $1
        AND po.created_at < $2
      `,
      [startDate, endExclusive]
    );

    const chartQ = await req.tenantDB.query(
      `
      WITH days AS (
        SELECT generate_series($1::date, $2::date, interval '1 day')::date AS d
      ),
      output_daily AS (
        SELECT o.created_at::date AS d, COALESCE(SUM(COALESCE(o.tax_amount, 0)), 0)::numeric AS gst_collected
        FROM orders o
        WHERE LOWER(COALESCE(o.status, '')) = 'completed'
          AND o.created_at >= $1
          AND o.created_at < $3
        GROUP BY o.created_at::date
      ),
      input_daily AS (
        SELECT po.created_at::date AS d, COALESCE(SUM(COALESCE(po.gst_amount, 0)), 0)::numeric AS gst_paid
        FROM purchase_orders po
        WHERE po.created_at >= $1
          AND po.created_at < $3
        GROUP BY po.created_at::date
      )
      SELECT
        TO_CHAR(days.d, 'YYYY-MM-DD') AS date,
        COALESCE(od.gst_collected, 0)::numeric AS gst_collected,
        COALESCE(id.gst_paid, 0)::numeric AS gst_paid,
        (COALESCE(od.gst_collected, 0) - COALESCE(id.gst_paid, 0))::numeric AS gst_payable
      FROM days
      LEFT JOIN output_daily od ON od.d = days.d
      LEFT JOIN input_daily id ON id.d = days.d
      ORDER BY days.d ASC
      `,
      [startDate, endDate, endExclusive]
    );

    const outputBreakdownQ = await req.tenantDB.query(
      `
      SELECT
        CASE
          WHEN LOWER(COALESCE(e.key, '')) LIKE '%cgst%' THEN 'CGST'
          WHEN LOWER(COALESCE(e.key, '')) LIKE '%sgst%' THEN 'SGST'
          WHEN LOWER(COALESCE(e.key, '')) LIKE '%igst%' THEN 'IGST'
          ELSE 'OTHER'
        END AS gst_type,
        COALESCE(
          SUM(
            CASE
              WHEN COALESCE(e.value, '') ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN e.value::numeric
              ELSE 0
            END
          ),
          0
        )::numeric AS output_gst
      FROM orders o
      LEFT JOIN LATERAL jsonb_each_text(COALESCE(o.tax_breakup, '{}'::jsonb)) e ON TRUE
      WHERE LOWER(COALESCE(o.status, '')) = 'completed'
        AND o.created_at >= $1
        AND o.created_at < $2
      GROUP BY gst_type
      `,
      [startDate, endExclusive]
    );

    const inputBreakdownQ = await req.tenantDB.query(
      `
      WITH purchase_tax_lines AS (
        SELECT
          po.id AS purchase_id,
          po.purchase_total,
          CASE
            WHEN LOWER(COALESCE(t.name, '')) LIKE '%cgst%' THEN 'CGST'
            WHEN LOWER(COALESCE(t.name, '')) LIKE '%sgst%' THEN 'SGST'
            WHEN LOWER(COALESCE(t.name, '')) LIKE '%igst%' THEN 'IGST'
            ELSE 'OTHER'
          END AS gst_type,
          COALESCE(t.percentage, 0)::numeric AS percentage
        FROM purchase_orders po
        LEFT JOIN LATERAL jsonb_array_elements_text(COALESCE(po.selected_tax_ids, '[]'::jsonb)) tx(tax_id) ON TRUE
        LEFT JOIN taxes t ON tx.tax_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' AND t.id = tx.tax_id::uuid
        WHERE po.created_at >= $1
          AND po.created_at < $2
      )
      SELECT
        gst_type,
        COALESCE(SUM(COALESCE(purchase_total, 0) * (COALESCE(percentage, 0) / 100.0)), 0)::numeric AS input_gst
      FROM purchase_tax_lines
      GROUP BY gst_type
      `,
      [startDate, endExclusive]
    );

    const outputGst = Number(outputQ.rows[0]?.output_gst || 0);
    const inputGst = Number(inputQ.rows[0]?.input_gst || 0);
    const rawPayable = outputGst - inputGst;
    const gstPayable = rawPayable > 0 ? rawPayable : 0;
    const gstCredit = rawPayable < 0 ? Math.abs(rawPayable) : 0;

    const byType = new Map();
    for (const row of outputBreakdownQ.rows || []) {
      const key = row.gst_type || "OTHER";
      byType.set(key, {
        gst_type: key,
        output_gst: Number(row.output_gst || 0),
        input_gst: 0,
      });
    }
    for (const row of inputBreakdownQ.rows || []) {
      const key = row.gst_type || "OTHER";
      const prev = byType.get(key) || { gst_type: key, output_gst: 0, input_gst: 0 };
      byType.set(key, {
        ...prev,
        input_gst: Number(row.input_gst || 0),
      });
    }
    const gstBreakdown = Array.from(byType.values()).map((row) => ({
      ...row,
      net_gst: Number(row.output_gst || 0) - Number(row.input_gst || 0),
    }));

    const records = (chartQ.rows || []).map((row) => ({
      date: row.date,
      gst_collected: Number(row.gst_collected || 0),
      gst_paid: Number(row.gst_paid || 0),
      gst_payable: Number(row.gst_payable || 0),
    }));

    return res.status(200).json({
      filters: {
        start_date: startDateIso,
        end_date: endDateIso,
        range: hasExplicitDates ? null : fallbackRange,
      },
      summary: {
        output_gst: outputGst,
        input_gst: inputGst,
        gst_payable: gstPayable,
        gst_credit: gstCredit,
      },
      chart: records,
      gst_breakdown: gstBreakdown,
      records,

      // Backward-compatible fields used by existing GST settings page
      total_output_gst: outputGst,
      total_input_gst: inputGst,
      net_gst: Math.abs(rawPayable),
      gst_status: rawPayable >= 0 ? "payable" : "credit",
    });
  } catch (error) {
    logError("GET /api/reports/gst/summary", error);
    return res.status(500).json({ message: "Failed to fetch GST summary report." });
  }
};

const formatHourRangeLabel = (hour24) => {
  const start = Number(hour24 || 0);
  const end = (start + 1) % 24;
  const to12 = (h) => {
    const suffix = h >= 12 ? "PM" : "AM";
    const hh = h % 12 || 12;
    return `${hh} ${suffix}`;
  };
  return `${to12(start)} - ${to12(end)}`;
};

const getPeakHoursReport = async (req, res) => {
  try {
    const dateRange = getSalesDateRange(req.query);
    if (!dateRange) {
      return res.status(400).json({ message: "Invalid date range. Use YYYY-MM-DD and ensure start_date <= end_date." });
    }
    const { startDateIso, endDateIso } = dateRange;

    const hourlyQ = await req.tenantDB.query(
      `
      WITH hours AS (
        SELECT generate_series(0, 23)::int AS hour_24
      ),
      aggregated AS (
        SELECT
          EXTRACT(HOUR FROM timezone('Asia/Kolkata', o.created_at))::int AS hour_24,
          COUNT(*)::int AS total_orders,
          COALESCE(SUM(COALESCE(o.total_amount, 0)), 0)::numeric AS total_revenue
        FROM orders o
        WHERE LOWER(COALESCE(o.status, '')) IN ('pending', 'preparing', 'served', 'completed')
          AND timezone('Asia/Kolkata', o.created_at)::date >= $1::date
          AND timezone('Asia/Kolkata', o.created_at)::date <= $2::date
        GROUP BY EXTRACT(HOUR FROM timezone('Asia/Kolkata', o.created_at))
      )
      SELECT
        h.hour_24,
        COALESCE(a.total_orders, 0)::int AS total_orders,
        COALESCE(a.total_revenue, 0)::numeric AS total_revenue
      FROM hours h
      LEFT JOIN aggregated a ON a.hour_24 = h.hour_24
      ORDER BY h.hour_24 ASC
      `,
      [startDateIso, endDateIso]
    );

    const hourlyData = (hourlyQ.rows || []).map((row) => {
      const totalOrders = Number(row.total_orders || 0);
      const totalRevenue = Number(row.total_revenue || 0);
      const averageOrderValue = totalOrders > 0 ? totalRevenue / totalOrders : 0;
      return {
        hour_24: Number(row.hour_24 || 0),
        hour: formatHourRangeLabel(Number(row.hour_24 || 0)),
        orders: totalOrders,
        revenue: totalRevenue,
        average_order_value: averageOrderValue,
      };
    });

    const peakOrdersHour = hourlyData.reduce(
      (best, row) => (row.orders > best.orders ? row : best),
      { hour: "N/A", hour_24: 0, orders: 0, revenue: 0, average_order_value: 0 }
    );
    const peakRevenueHour = hourlyData.reduce(
      (best, row) => (row.revenue > best.revenue ? row : best),
      { hour: "N/A", hour_24: 0, orders: 0, revenue: 0, average_order_value: 0 }
    );

    return res.status(200).json({
      filters: {
        start_date: startDateIso,
        end_date: endDateIso,
        timezone: "Asia/Kolkata",
      },
      summary: {
        peak_orders_hour: {
          hour: peakOrdersHour.hour,
          hour_24: peakOrdersHour.hour_24,
          total_orders: peakOrdersHour.orders,
          total_revenue: peakOrdersHour.revenue,
          average_order_value: peakOrdersHour.average_order_value,
        },
        peak_revenue_hour: {
          hour: peakRevenueHour.hour,
          hour_24: peakRevenueHour.hour_24,
          total_orders: peakRevenueHour.orders,
          total_revenue: peakRevenueHour.revenue,
          average_order_value: peakRevenueHour.average_order_value,
        },
      },
      hourly_data: hourlyData,
    });
  } catch (error) {
    logError("GET /api/reports/insights/peak-hours", error);
    return res.status(500).json({ message: "Failed to fetch peak hours report." });
  }
};

const getCustomerInsightsReport = async (req, res) => {
  try {
    const dateRange = getSalesDateRange(req.query);
    if (!dateRange) {
      return res.status(400).json({ message: "Invalid date range. Use YYYY-MM-DD and ensure start_date <= end_date." });
    }
    const { startDate, startDateExclusiveEnd, startDateIso, endDateIso } = dateRange;
    const searchRaw = String(req.query?.customer_phone || "").trim();
    const hasSearch = searchRaw.length > 0;
    const searchLike = `%${searchRaw}%`;

    const customersQ = await req.tenantDB.query(
      `
      WITH base_orders AS (
        SELECT
          o.id,
          o.created_at,
          COALESCE(NULLIF(BTRIM(o.guest_name), ''), 'Guest') AS customer_name,
          NULLIF(BTRIM(o.guest_phone), '') AS customer_phone,
          COALESCE(o.total_amount, 0)::numeric AS total_amount,
          COALESCE(o.tip_amount, 0)::numeric AS tip_amount
        FROM orders o
        WHERE LOWER(COALESCE(o.status, '')) <> 'cancelled'
          AND o.created_at >= $1
          AND o.created_at < $2
          AND (
            NULLIF(BTRIM(o.guest_name), '') IS NOT NULL
            OR NULLIF(BTRIM(o.guest_phone), '') IS NOT NULL
          )
          AND (
            $3::boolean = FALSE
            OR COALESCE(o.guest_phone, '') ILIKE $4
            OR COALESCE(o.guest_name, '') ILIKE $4
          )
      ),
      grouped AS (
        SELECT
          COALESCE(customer_phone, CONCAT('NO_PHONE::', LOWER(customer_name))) AS customer_key,
          MAX(customer_name) AS customer_name,
          MAX(customer_phone) AS customer_phone,
          COUNT(*)::int AS total_orders,
          COALESCE(SUM(total_amount), 0)::numeric AS total_spent,
          COALESCE(SUM(tip_amount), 0)::numeric AS total_tips_given,
          MIN(created_at) AS first_visit,
          MAX(created_at) AS last_visit
        FROM base_orders
        GROUP BY COALESCE(customer_phone, CONCAT('NO_PHONE::', LOWER(customer_name)))
      )
      SELECT
        g.customer_key,
        g.customer_name,
        g.customer_phone,
        g.total_orders,
        g.total_spent,
        g.total_tips_given,
        (CASE WHEN g.total_orders > 0 THEN g.total_spent / g.total_orders ELSE 0 END)::numeric AS average_order_value,
        g.first_visit,
        g.last_visit,
        (g.total_orders > 1) AS is_repeat,
        ROW_NUMBER() OVER (ORDER BY g.total_spent DESC, g.total_orders DESC, g.last_visit DESC) AS rank_by_spent,
        ROW_NUMBER() OVER (ORDER BY g.total_orders DESC, g.total_spent DESC, g.last_visit DESC) AS rank_by_orders
      FROM grouped g
      ORDER BY g.total_spent DESC, g.total_orders DESC, g.last_visit DESC
      `,
      [startDate, startDateExclusiveEnd, hasSearch, searchLike]
    );

    const visitsOverTimeQ = await req.tenantDB.query(
      `
      WITH base_orders AS (
        SELECT
          o.created_at::date AS visit_date,
          COALESCE(NULLIF(BTRIM(o.guest_name), ''), 'Guest') AS customer_name,
          NULLIF(BTRIM(o.guest_phone), '') AS customer_phone
        FROM orders o
        WHERE LOWER(COALESCE(o.status, '')) <> 'cancelled'
          AND o.created_at >= $1
          AND o.created_at < $2
          AND (
            NULLIF(BTRIM(o.guest_name), '') IS NOT NULL
            OR NULLIF(BTRIM(o.guest_phone), '') IS NOT NULL
          )
          AND (
            $3::boolean = FALSE
            OR COALESCE(o.guest_phone, '') ILIKE $4
            OR COALESCE(o.guest_name, '') ILIKE $4
          )
      )
      SELECT
        TO_CHAR(visit_date, 'YYYY-MM-DD') AS date,
        COUNT(*)::int AS total_visits,
        COUNT(DISTINCT COALESCE(customer_phone, CONCAT('NO_PHONE::', LOWER(customer_name))))::int AS unique_customers
      FROM base_orders
      GROUP BY visit_date
      ORDER BY visit_date ASC
      `,
      [startDate, startDateExclusiveEnd, hasSearch, searchLike]
    );

    const customers = (customersQ.rows || []).map((row) => ({
      customer_name: row.customer_name || "Guest",
      phone: row.customer_phone || null,
      total_orders: Number(row.total_orders || 0),
      total_spent: Number(row.total_spent || 0),
      total_tips: Number(row.total_tips_given || 0),
      avg_order_value: Number(row.average_order_value || 0),
      first_visit: row.first_visit,
      last_visit: row.last_visit,
      is_repeat: Boolean(row.is_repeat),
      rank_by_spent: Number(row.rank_by_spent || 0),
      rank_by_orders: Number(row.rank_by_orders || 0),
    }));

    const totalCustomers = customers.length;
    const repeatCustomersCount = customers.filter((c) => c.total_orders > 1).length;
    const newCustomersCount = Math.max(0, totalCustomers - repeatCustomersCount);
    const totalSpent = customers.reduce((sum, c) => sum + Number(c.total_spent || 0), 0);
    const avgSpendPerCustomer = totalCustomers > 0 ? totalSpent / totalCustomers : 0;
    const highestSpendingCustomer = customers[0] || null;
    const mostFrequentCustomer =
      [...customers].sort((a, b) => b.total_orders - a.total_orders || b.total_spent - a.total_spent)[0] || null;

    const highestSpendingCustomers = [...customers]
      .sort((a, b) => b.total_spent - a.total_spent || b.total_orders - a.total_orders)
      .slice(0, 10);
    const mostFrequentCustomers = [...customers]
      .sort((a, b) => b.total_orders - a.total_orders || b.total_spent - a.total_spent)
      .slice(0, 10);

    return res.status(200).json({
      filters: {
        start_date: startDateIso,
        end_date: endDateIso,
        customer_phone: searchRaw || null,
      },
      summary: {
        total_customers: totalCustomers,
        repeat_customers_count: repeatCustomersCount,
        new_customers_count: newCustomersCount,
        avg_spend_per_customer: avgSpendPerCustomer,
        highest_spender: highestSpendingCustomer
          ? {
              customer_name: highestSpendingCustomer.customer_name,
              phone: highestSpendingCustomer.phone,
              total_spent: highestSpendingCustomer.total_spent,
              total_orders: highestSpendingCustomer.total_orders,
            }
          : null,
        most_frequent_customer: mostFrequentCustomer
          ? {
              customer_name: mostFrequentCustomer.customer_name,
              phone: mostFrequentCustomer.phone,
              total_orders: mostFrequentCustomer.total_orders,
              total_spent: mostFrequentCustomer.total_spent,
            }
          : null,
      },
      chart: {
        repeat_vs_new: {
          repeat_customers_count: repeatCustomersCount,
          new_customers_count: newCustomersCount,
        },
        customer_visits_over_time: (visitsOverTimeQ.rows || []).map((row) => ({
          date: row.date,
          total_visits: Number(row.total_visits || 0),
          unique_customers: Number(row.unique_customers || 0),
        })),
        top_spenders: highestSpendingCustomers.map((c) => ({
          customer_name: c.customer_name,
          phone: c.phone,
          total_spent: c.total_spent,
          total_orders: c.total_orders,
        })),
      },
      top_customers: {
        highest_spending_customers: highestSpendingCustomers,
        most_frequent_customers: mostFrequentCustomers,
      },
      customers,
    });
  } catch (error) {
    logError("GET /api/reports/insights/customer-insights", error);
    return res.status(500).json({ message: "Failed to fetch customer insights report." });
  }
};

const formatDurationFromSeconds = (secondsValue) => {
  const total = Number(secondsValue);
  if (!Number.isFinite(total) || total < 0) return null;
  const rounded = Math.floor(total);
  const hrs = Math.floor(rounded / 3600);
  const mins = Math.floor((rounded % 3600) / 60);
  const secs = rounded % 60;
  const parts = [];
  if (hrs > 0) parts.push(`${hrs} Hr`);
  if (mins > 0 || hrs > 0) parts.push(`${mins} Min`);
  parts.push(`${secs} Sec`);
  return parts.join(" ");
};

const toDurationPayload = (secondsValue) => ({
  seconds: Number.isFinite(Number(secondsValue)) && Number(secondsValue) >= 0 ? Number(secondsValue) : null,
  readable: formatDurationFromSeconds(secondsValue),
});

const getTimeEfficiencyReport = async (req, res) => {
  try {
    const dateRange = getSalesDateRange(req.query);
    if (!dateRange) {
      return res.status(400).json({ message: "Invalid date range. Use YYYY-MM-DD and ensure start_date <= end_date." });
    }
    const { startDate, startDateExclusiveEnd, startDateIso, endDateIso } = dateRange;

    const ordersQ = await req.tenantDB.query(
      `
      SELECT
        o.id AS order_id,
        o.order_number,
        o.created_at,
        o.kot_sent_at,
        o.served_at,
        o.completed_at,
        t.name AS table_name,
        s.id AS assigned_staff_id,
        s.name AS assigned_staff_name,
        CASE
          WHEN o.kot_sent_at IS NOT NULL AND o.kot_sent_at >= o.created_at
          THEN EXTRACT(EPOCH FROM (o.kot_sent_at - o.created_at))
          ELSE NULL
        END AS prep_seconds,
        CASE
          WHEN o.served_at IS NOT NULL AND o.kot_sent_at IS NOT NULL AND o.served_at >= o.kot_sent_at
          THEN EXTRACT(EPOCH FROM (o.served_at - o.kot_sent_at))
          ELSE NULL
        END AS serve_seconds,
        CASE
          WHEN o.completed_at IS NOT NULL AND o.served_at IS NOT NULL AND o.completed_at >= o.served_at
          THEN EXTRACT(EPOCH FROM (o.completed_at - o.served_at))
          ELSE NULL
        END AS completion_seconds,
        CASE
          WHEN o.completed_at IS NOT NULL AND o.completed_at >= o.created_at
          THEN EXTRACT(EPOCH FROM (o.completed_at - o.created_at))
          ELSE NULL
        END AS total_seconds
      FROM orders o
      LEFT JOIN tables t ON t.id = o.table_id
      LEFT JOIN staff_users s ON s.id = o.assigned_staff_id
      WHERE LOWER(COALESCE(o.status, '')) <> 'cancelled'
        AND o.created_at >= $1
        AND o.created_at < $2
      ORDER BY o.created_at DESC
      `,
      [startDate, startDateExclusiveEnd]
    );

    const durationTrendQ = await req.tenantDB.query(
      `
      SELECT
        TO_CHAR(o.created_at::date, 'YYYY-MM-DD') AS date,
        AVG(
          CASE
            WHEN o.completed_at IS NOT NULL AND o.completed_at >= o.created_at
            THEN EXTRACT(EPOCH FROM (o.completed_at - o.created_at))
            ELSE NULL
          END
        )::numeric AS avg_total_seconds,
        AVG(
          CASE
            WHEN o.kot_sent_at IS NOT NULL AND o.kot_sent_at >= o.created_at
            THEN EXTRACT(EPOCH FROM (o.kot_sent_at - o.created_at))
            ELSE NULL
          END
        )::numeric AS avg_prep_seconds,
        AVG(
          CASE
            WHEN o.served_at IS NOT NULL AND o.kot_sent_at IS NOT NULL AND o.served_at >= o.kot_sent_at
            THEN EXTRACT(EPOCH FROM (o.served_at - o.kot_sent_at))
            ELSE NULL
          END
        )::numeric AS avg_serve_seconds
      FROM orders o
      WHERE LOWER(COALESCE(o.status, '')) <> 'cancelled'
        AND o.created_at >= $1
        AND o.created_at < $2
      GROUP BY o.created_at::date
      ORDER BY o.created_at::date ASC
      `,
      [startDate, startDateExclusiveEnd]
    );

    const rows = (ordersQ.rows || []).map((row) => ({
      order_id: row.order_id,
      order_number: row.order_number,
      table_name: row.table_name || null,
      assigned_staff_id: row.assigned_staff_id || null,
      assigned_staff: row.assigned_staff_name || "Unassigned",
      created_at: row.created_at,
      kot_sent_at: row.kot_sent_at,
      served_at: row.served_at,
      completed_at: row.completed_at,
      prep_time: toDurationPayload(Number(row.prep_seconds)),
      serve_time: toDurationPayload(Number(row.serve_seconds)),
      completion_time: toDurationPayload(Number(row.completion_seconds)),
      total_duration: toDurationPayload(Number(row.total_seconds)),
    }));

    const avgSeconds = (values) => {
      const valid = values.filter((v) => Number.isFinite(v) && v >= 0);
      if (valid.length === 0) return null;
      return valid.reduce((s, v) => s + v, 0) / valid.length;
    };

    const avgPrep = avgSeconds(rows.map((r) => r.prep_time.seconds));
    const avgServe = avgSeconds(rows.map((r) => r.serve_time.seconds));
    const avgCompletion = avgSeconds(rows.map((r) => r.completion_time.seconds));
    const avgTotal = avgSeconds(rows.map((r) => r.total_duration.seconds));

    const totalDurationRows = rows
      .filter((r) => Number.isFinite(r.total_duration.seconds) && r.total_duration.seconds >= 0)
      .sort((a, b) => Number(b.total_duration.seconds) - Number(a.total_duration.seconds));
    const slowestOrders = totalDurationRows.slice(0, 10);
    const fastestOrders = [...totalDurationRows].reverse().slice(0, 10);

    const staffMap = new Map();
    for (const row of rows) {
      const key = row.assigned_staff_id || `UNASSIGNED::${row.assigned_staff}`;
      if (!staffMap.has(key)) {
        staffMap.set(key, {
          assigned_staff_id: row.assigned_staff_id,
          assigned_staff: row.assigned_staff,
          total_orders_handled: 0,
          serviceSeconds: [],
          totalSeconds: [],
        });
      }
      const acc = staffMap.get(key);
      acc.total_orders_handled += 1;
      if (Number.isFinite(row.serve_time.seconds) && row.serve_time.seconds >= 0) acc.serviceSeconds.push(row.serve_time.seconds);
      if (Number.isFinite(row.total_duration.seconds) && row.total_duration.seconds >= 0) acc.totalSeconds.push(row.total_duration.seconds);
    }
    const staff_efficiency = Array.from(staffMap.values())
      .map((s) => {
        const avgServiceSeconds = avgSeconds(s.serviceSeconds);
        const avgTotalSeconds = avgSeconds(s.totalSeconds);
        return {
          assigned_staff_id: s.assigned_staff_id,
          assigned_staff: s.assigned_staff,
          total_orders_handled: s.total_orders_handled,
          avg_service_time: toDurationPayload(avgServiceSeconds),
          avg_total_duration: toDurationPayload(avgTotalSeconds),
        };
      })
      .sort((a, b) => b.total_orders_handled - a.total_orders_handled);

    return res.status(200).json({
      filters: {
        start_date: startDateIso,
        end_date: endDateIso,
      },
      summary: {
        avg_preparation_time: toDurationPayload(avgPrep),
        avg_serving_time: toDurationPayload(avgServe),
        avg_completion_time: toDurationPayload(avgCompletion),
        avg_total_duration: toDurationPayload(avgTotal),
      },
      delays: {
        slowest_orders: slowestOrders,
        fastest_orders: fastestOrders,
      },
      chart: {
        duration_over_time: (durationTrendQ.rows || []).map((row) => ({
          date: row.date,
          avg_total_duration: toDurationPayload(Number(row.avg_total_seconds)),
          avg_prep_time: toDurationPayload(Number(row.avg_prep_seconds)),
          avg_serve_time: toDurationPayload(Number(row.avg_serve_seconds)),
        })),
        prep_vs_serve_comparison: (durationTrendQ.rows || []).map((row) => ({
          date: row.date,
          avg_prep_time: toDurationPayload(Number(row.avg_prep_seconds)),
          avg_serve_time: toDurationPayload(Number(row.avg_serve_seconds)),
        })),
      },
      staff_efficiency,
      orders: rows,
    });
  } catch (error) {
    logError("GET /api/reports/insights/time-efficiency", error);
    return res.status(500).json({ message: "Failed to fetch time efficiency report." });
  }
};

const getItemProfitabilityReport = async (req, res) => {
  try {
    const dateRange = getSalesDateRange(req.query);
    if (!dateRange) {
      return res.status(400).json({ message: "Invalid date range. Use YYYY-MM-DD and ensure start_date <= end_date." });
    }
    const { startDate, startDateExclusiveEnd, startDateIso, endDateIso } = dateRange;

    const menuItemIdRaw = String(req.query?.menu_item_id || "").trim();
    if (menuItemIdRaw && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(menuItemIdRaw)) {
      return res.status(400).json({ message: "Invalid menu_item_id." });
    }
    const menuItemId = menuItemIdRaw || null;

    const itemsQ = await req.tenantDB.query(
      `
      WITH base_items AS (
        SELECT
          mi.id AS menu_item_id,
          COALESCE(mi.name || ' - ' || mv.name, mi.name, mv.name, 'Unknown Item') AS item_name,
          COALESCE(oi.quantity, 0)::numeric AS quantity,
          COALESCE(oi.total_price, 0)::numeric AS revenue,
          COALESCE(oi.cost_price, 0)::numeric AS cost,
          COALESCE(oi.is_complimentary, FALSE) AS is_complimentary
        FROM order_items oi
        JOIN orders o ON o.id = oi.order_id
        LEFT JOIN menu_item_variants mv ON mv.id = oi.variant_id
        LEFT JOIN menu_items mi ON mi.id = mv.item_id
        WHERE LOWER(COALESCE(o.status, '')) IN ('served', 'completed')
          AND o.created_at >= $1
          AND o.created_at < $2
          AND COALESCE(oi.status, 'active') <> 'cancelled'
          AND COALESCE(oi.status, 'active') <> 'voided'
          AND COALESCE(oi.is_voided, FALSE) = FALSE
          AND ($3::uuid IS NULL OR mi.id = $3::uuid)
      ),
      base_agg AS (
        SELECT
          menu_item_id,
          item_name,
          COALESCE(SUM(quantity), 0)::numeric AS quantity_sold,
          COALESCE(SUM(revenue), 0)::numeric AS total_revenue,
          COALESCE(SUM(cost), 0)::numeric AS total_cost,
          COALESCE(SUM(CASE WHEN is_complimentary THEN cost ELSE 0 END), 0)::numeric AS complimentary_loss
        FROM base_items
        GROUP BY menu_item_id, item_name
      ),
      void_agg AS (
        SELECT
          mi.id AS menu_item_id,
          COALESCE(SUM(COALESCE(a.cost_impact, 0)), 0)::numeric AS void_loss
        FROM order_adjustments a
        JOIN orders o ON o.id = a.order_id
        LEFT JOIN order_items oi ON oi.id = a.order_item_id
        LEFT JOIN menu_item_variants mv ON mv.id = oi.variant_id
        LEFT JOIN menu_items mi ON mi.id = mv.item_id
        WHERE LOWER(COALESCE(o.status, '')) IN ('served', 'completed')
          AND o.created_at >= $1
          AND o.created_at < $2
          AND LOWER(COALESCE(a.type, '')) LIKE 'void%'
          AND ($3::uuid IS NULL OR mi.id = $3::uuid)
        GROUP BY mi.id
      ),
      replacement_agg AS (
        SELECT
          mi.id AS menu_item_id,
          COALESCE(SUM(COALESCE(a.cost_impact, 0)), 0)::numeric AS replacement_impact
        FROM order_adjustments a
        JOIN orders o ON o.id = a.order_id
        LEFT JOIN order_items oi ON oi.id = a.order_item_id
        LEFT JOIN menu_item_variants mv ON mv.id = oi.variant_id
        LEFT JOIN menu_items mi ON mi.id = mv.item_id
        WHERE LOWER(COALESCE(o.status, '')) IN ('served', 'completed')
          AND o.created_at >= $1
          AND o.created_at < $2
          AND LOWER(COALESCE(a.type, '')) = 'replacement'
          AND ($3::uuid IS NULL OR mi.id = $3::uuid)
        GROUP BY mi.id
      )
      SELECT
        b.menu_item_id,
        b.item_name,
        b.quantity_sold,
        b.total_revenue,
        b.total_cost,
        (b.total_revenue - b.total_cost)::numeric AS total_profit,
        CASE
          WHEN b.total_revenue > 0
          THEN ((b.total_revenue - b.total_cost) / b.total_revenue) * 100
          ELSE 0::numeric
        END AS profit_margin,
        b.complimentary_loss,
        COALESCE(v.void_loss, 0)::numeric AS void_loss,
        COALESCE(r.replacement_impact, 0)::numeric AS replacement_impact
      FROM base_agg b
      LEFT JOIN void_agg v ON v.menu_item_id = b.menu_item_id
      LEFT JOIN replacement_agg r ON r.menu_item_id = b.menu_item_id
      ORDER BY (b.total_revenue - b.total_cost) DESC, b.total_revenue DESC
      `,
      [startDate, startDateExclusiveEnd, menuItemId]
    );

    const optionsQ = await req.tenantDB.query(
      `
      SELECT mi.id, mi.name
      FROM menu_items mi
      WHERE COALESCE(mi.is_active, TRUE) = TRUE
      ORDER BY mi.name ASC
      `
    );

    const items = (itemsQ.rows || []).map((row) => ({
      menu_item_id: row.menu_item_id,
      item_name: row.item_name || "Unknown Item",
      quantity_sold: Number(row.quantity_sold || 0),
      revenue: Number(row.total_revenue || 0),
      cost: Number(row.total_cost || 0),
      profit: Number(row.total_profit || 0),
      profit_margin: Number(row.profit_margin || 0),
      complimentary_loss: Number(row.complimentary_loss || 0),
      void_loss: Number(row.void_loss || 0),
      replacement_impact: Number(row.replacement_impact || 0),
    }));

    const totalRevenue = items.reduce((s, i) => s + i.revenue, 0);
    const totalCost = items.reduce((s, i) => s + i.cost, 0);
    const totalProfit = totalRevenue - totalCost;
    const avgMargin = totalRevenue > 0 ? (totalProfit / totalRevenue) * 100 : 0;
    const totalComplimentaryLoss = items.reduce((s, i) => s + i.complimentary_loss, 0);
    const totalVoidLoss = items.reduce((s, i) => s + i.void_loss, 0);
    const totalReplacementImpact = items.reduce((s, i) => s + i.replacement_impact, 0);

    const highestProfitItems = [...items].sort((a, b) => b.profit - a.profit).slice(0, 10);
    const highestMarginItems = [...items].sort((a, b) => b.profit_margin - a.profit_margin).slice(0, 10);
    const lowestMarginItems = [...items].sort((a, b) => a.profit_margin - b.profit_margin).slice(0, 10);
    const lossMakingItems = [...items].filter((i) => i.profit < 0).sort((a, b) => a.profit - b.profit);

    return res.status(200).json({
      filters: {
        start_date: startDateIso,
        end_date: endDateIso,
        menu_item_id: menuItemId,
      },
      summary: {
        total_revenue: totalRevenue,
        total_cost: totalCost,
        total_profit: totalProfit,
        avg_margin: avgMargin,
        total_items: items.length,
        complimentary_loss: totalComplimentaryLoss,
        void_loss: totalVoidLoss,
        replacement_impact: totalReplacementImpact,
      },
      chart: {
        profit_by_item: highestProfitItems.map((i) => ({
          menu_item_id: i.menu_item_id,
          item_name: i.item_name,
          profit: i.profit,
          revenue: i.revenue,
        })),
        margin_by_item: highestMarginItems.map((i) => ({
          menu_item_id: i.menu_item_id,
          item_name: i.item_name,
          profit_margin: i.profit_margin,
        })),
      },
      top_profit_items: highestProfitItems,
      top_margin_items: highestMarginItems,
      low_margin_items: lowestMarginItems,
      loss_making_items: lossMakingItems,
      items,
      menu_item_options: (optionsQ.rows || []).map((row) => ({ id: row.id, name: row.name })),
    });
  } catch (error) {
    logError("GET /api/reports/insights/item-profitability", error);
    return res.status(500).json({ message: "Failed to fetch item profitability report." });
  }
};

const getStockWastageReport = async (req, res) => {
  try {
    const dateRange = getSalesDateRange(req.query);
    if (!dateRange) {
      return res.status(400).json({ message: "Invalid date range. Use YYYY-MM-DD and ensure start_date <= end_date." });
    }
    const { startDate, startDateExclusiveEnd, startDateIso, endDateIso } = dateRange;

    const ingredientIdRaw = String(req.query?.ingredient_id || "").trim();
    if (ingredientIdRaw && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(ingredientIdRaw)) {
      return res.status(400).json({ message: "Invalid ingredient_id." });
    }
    const ingredientId = ingredientIdRaw || null;

    const baseCte = `
      WITH base_consumption AS (
        SELECT
          c.id,
          c.order_id,
          c.order_item_id,
          c.raw_material_id AS ingredient_id,
          COALESCE(c.quantity_used, 0)::numeric AS quantity_used,
          c.created_at,
          LOWER(COALESCE(o.status, '')) AS order_status,
          COALESCE(oi.is_complimentary, FALSE) AS is_complimentary,
          LOWER(COALESCE(oi.status, 'active')) AS order_item_status,
          COALESCE(oi.is_voided, FALSE) AS is_voided,
          COALESCE(mi.id, NULL) AS menu_item_id,
          COALESCE(mi.name || ' - ' || mv.name, mi.name, mv.name, 'Unknown Item') AS menu_item_name,
          COALESCE(rm.name, 'Deleted Ingredient') AS ingredient_name,
          COALESCE(u.name, 'Unit') AS unit_name,
          COALESCE(rm.purchase_price, 0)::numeric AS purchase_price,
          COALESCE(NULLIF(rm.conversion_factor, 0), 1)::numeric AS conversion_factor,
          EXISTS (
            SELECT 1
            FROM order_adjustments a
            WHERE a.order_item_id = c.order_item_id
              AND LOWER(COALESCE(a.type, '')) LIKE 'void%'
          ) AS has_void_adjustment,
          EXISTS (
            SELECT 1
            FROM order_adjustments a
            WHERE a.order_item_id = c.order_item_id
              AND LOWER(COALESCE(a.type, '')) = 'replacement'
          ) AS has_replacement_adjustment
        FROM order_item_consumptions c
        JOIN orders o ON o.id = c.order_id
        LEFT JOIN order_items oi ON oi.id = c.order_item_id
        LEFT JOIN menu_item_variants mv ON mv.id = oi.variant_id
        LEFT JOIN menu_items mi ON mi.id = mv.item_id
        LEFT JOIN raw_materials rm ON rm.id = c.raw_material_id
        LEFT JOIN units u ON u.id = rm.consumption_unit_id
        WHERE c.created_at >= $1
          AND c.created_at < $2
          AND ($3::uuid IS NULL OR c.raw_material_id = $3::uuid)
      ),
      wastage_base AS (
        SELECT
          bc.*,
          COALESCE((bc.quantity_used / bc.conversion_factor) * bc.purchase_price, 0)::numeric AS wasted_cost,
          CASE
            WHEN bc.is_complimentary THEN 'complimentary_loss'
            WHEN bc.has_replacement_adjustment THEN 'replacement_loss'
            WHEN bc.has_void_adjustment OR bc.order_item_status = 'voided' OR bc.is_voided THEN 'void_loss'
            WHEN bc.order_status = 'cancelled' THEN 'cancellation_loss'
            ELSE 'none'
          END AS wastage_source
        FROM base_consumption bc
      ),
      filtered_wastage AS (
        SELECT *
        FROM wastage_base
        WHERE wastage_source IN ('void_loss', 'complimentary_loss', 'replacement_loss', 'cancellation_loss')
      )
    `;

    const summaryQ = await req.tenantDB.query(
      `
      ${baseCte}
      SELECT
        COALESCE(SUM(quantity_used), 0)::numeric AS total_wastage_quantity,
        COALESCE(SUM(wasted_cost), 0)::numeric AS total_wastage_cost
      FROM filtered_wastage
      `,
      [startDate, startDateExclusiveEnd, ingredientId]
    );

    const sourceQ = await req.tenantDB.query(
      `
      ${baseCte}
      SELECT
        wastage_source AS source,
        COALESCE(SUM(quantity_used), 0)::numeric AS wasted_quantity,
        COALESCE(SUM(wasted_cost), 0)::numeric AS wasted_cost
      FROM filtered_wastage
      GROUP BY wastage_source
      ORDER BY wasted_cost DESC, wasted_quantity DESC
      `,
      [startDate, startDateExclusiveEnd, ingredientId]
    );

    const ingredientsQ = await req.tenantDB.query(
      `
      ${baseCte}
      SELECT
        ingredient_id,
        ingredient_name,
        unit_name,
        COALESCE(SUM(quantity_used), 0)::numeric AS wasted_quantity,
        COALESCE(SUM(wasted_cost), 0)::numeric AS wasted_cost,
        COALESCE(SUM(CASE WHEN wastage_source = 'void_loss' THEN wasted_cost ELSE 0 END), 0)::numeric AS void_loss,
        COALESCE(SUM(CASE WHEN wastage_source = 'complimentary_loss' THEN wasted_cost ELSE 0 END), 0)::numeric AS complimentary_loss,
        COALESCE(SUM(CASE WHEN wastage_source = 'replacement_loss' THEN wasted_cost ELSE 0 END), 0)::numeric AS replacement_loss,
        COALESCE(SUM(CASE WHEN wastage_source = 'cancellation_loss' THEN wasted_cost ELSE 0 END), 0)::numeric AS cancellation_loss
      FROM filtered_wastage
      GROUP BY ingredient_id, ingredient_name, unit_name
      ORDER BY wasted_cost DESC, wasted_quantity DESC
      `,
      [startDate, startDateExclusiveEnd, ingredientId]
    );

    const menuItemsQ = await req.tenantDB.query(
      `
      ${baseCte}
      SELECT
        menu_item_id,
        menu_item_name,
        COALESCE(SUM(quantity_used), 0)::numeric AS wastage_quantity,
        COALESCE(SUM(wasted_cost), 0)::numeric AS wastage_cost
      FROM filtered_wastage
      GROUP BY menu_item_id, menu_item_name
      ORDER BY wastage_cost DESC, wastage_quantity DESC
      `,
      [startDate, startDateExclusiveEnd, ingredientId]
    );

    const trendQ = await req.tenantDB.query(
      `
      ${baseCte}
      SELECT
        TO_CHAR(created_at::date, 'YYYY-MM-DD') AS date,
        COALESCE(SUM(quantity_used), 0)::numeric AS wasted_quantity,
        COALESCE(SUM(wasted_cost), 0)::numeric AS wasted_cost
      FROM filtered_wastage
      GROUP BY created_at::date
      ORDER BY created_at::date ASC
      `,
      [startDate, startDateExclusiveEnd, ingredientId]
    );

    const sourceRows = (sourceQ.rows || []).map((row) => ({
      source: row.source,
      wasted_quantity: Number(row.wasted_quantity || 0),
      wasted_cost: Number(row.wasted_cost || 0),
    }));
    const highestWastageSource = sourceRows[0]?.source || null;
    const summaryRow = summaryQ.rows[0] || {};

    const ingredients = (ingredientsQ.rows || []).map((row) => {
      const voidLoss = Number(row.void_loss || 0);
      const complimentaryLoss = Number(row.complimentary_loss || 0);
      const replacementLoss = Number(row.replacement_loss || 0);
      const cancellationLoss = Number(row.cancellation_loss || 0);
      const maxLoss = Math.max(voidLoss, complimentaryLoss, replacementLoss, cancellationLoss);
      let primarySource = "void_loss";
      if (maxLoss === complimentaryLoss) primarySource = "complimentary_loss";
      if (maxLoss === replacementLoss) primarySource = "replacement_loss";
      if (maxLoss === cancellationLoss) primarySource = "cancellation_loss";

      return {
        ingredient_id: row.ingredient_id,
        ingredient_name: row.ingredient_name || "Deleted Ingredient",
        unit_name: row.unit_name || "Unit",
        quantity_wasted: Number(row.wasted_quantity || 0),
        cost_wasted: Number(row.wasted_cost || 0),
        wasted_quantity: Number(row.wasted_quantity || 0),
        wasted_cost: Number(row.wasted_cost || 0),
        void_loss: voidLoss,
        complimentary_loss: complimentaryLoss,
        replacement_loss: replacementLoss,
        cancellation_loss: cancellationLoss,
        primary_wastage_source: primarySource,
      };
    });

    const menu_items = (menuItemsQ.rows || []).map((row) => ({
      menu_item_id: row.menu_item_id,
      menu_item_name: row.menu_item_name || "Unknown Item",
      wastage_quantity: Number(row.wastage_quantity || 0),
      wastage_cost: Number(row.wastage_cost || 0),
    }));

    return res.status(200).json({
      filters: {
        start_date: startDateIso,
        end_date: endDateIso,
        ingredient_id: ingredientId,
      },
      summary: {
        total_wastage_cost: Number(summaryRow.total_wastage_cost || 0),
        total_wastage_quantity: Number(summaryRow.total_wastage_quantity || 0),
        highest_wastage_source: highestWastageSource,
      },
      source_analysis: sourceRows,
      ingredients,
      menu_items,
      chart: {
        wastage_by_source: sourceRows,
        wastage_by_ingredient: ingredients
          .slice()
          .sort((a, b) => b.cost_wasted - a.cost_wasted)
          .slice(0, 10)
          .map((row) => ({
            ingredient_id: row.ingredient_id,
            ingredient_name: row.ingredient_name,
            wasted_quantity: row.wasted_quantity,
            wasted_cost: row.wasted_cost,
          })),
        wastage_over_time: (trendQ.rows || []).map((row) => ({
          date: row.date,
          wasted_quantity: Number(row.wasted_quantity || 0),
          wasted_cost: Number(row.wasted_cost || 0),
        })),
      },
      ingredient_options: ingredients
        .map((row) => ({ id: row.ingredient_id, name: row.ingredient_name }))
        .filter((row) => Boolean(row.id)),
    });
  } catch (error) {
    logError("GET /api/reports/insights/stock-wastage", error);
    return res.status(500).json({ message: "Failed to fetch stock wastage report." });
  }
};

const getExecutiveMenuPerformanceReport = async (req, res) => {
  try {
    const dateRange = getSalesDateRange(req.query);
    if (!dateRange) {
      return res.status(400).json({ message: "Invalid date range. Use YYYY-MM-DD and ensure start_date <= end_date." });
    }
    const { startDate, startDateExclusiveEnd, startDateIso, endDateIso } = dateRange;

    const menuItemIdRaw = String(req.query?.menu_item_id || "").trim();
    if (menuItemIdRaw && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(menuItemIdRaw)) {
      return res.status(400).json({ message: "Invalid menu_item_id." });
    }
    const menuItemId = menuItemIdRaw || null;

    const performanceQ = await req.tenantDB.query(
      `
      WITH item_base AS (
        SELECT
          mi.id AS menu_item_id,
          COALESCE(mi.name || ' - ' || mv.name, mi.name, mv.name, 'Unknown Item') AS item_name,
          COALESCE(oi.quantity, 0)::numeric AS quantity,
          COALESCE(oi.total_price, 0)::numeric AS revenue,
          COALESCE(oi.cost_price, 0)::numeric AS cost
        FROM order_items oi
        JOIN orders o ON o.id = oi.order_id
        LEFT JOIN menu_item_variants mv ON mv.id = oi.variant_id
        LEFT JOIN menu_items mi ON mi.id = mv.item_id
        WHERE LOWER(COALESCE(o.status, '')) IN ('served', 'completed')
          AND o.created_at >= $1
          AND o.created_at < $2
          AND COALESCE(oi.status, 'active') NOT IN ('cancelled', 'voided', 'replaced')
          AND COALESCE(oi.is_voided, FALSE) = FALSE
          AND ($3::uuid IS NULL OR mi.id = $3::uuid)
      ),
      item_sales AS (
        SELECT
          menu_item_id,
          item_name,
          COALESCE(SUM(quantity), 0)::numeric AS quantity_sold,
          COALESCE(SUM(revenue), 0)::numeric AS revenue_generated,
          COALESCE(SUM(cost), 0)::numeric AS cost_consumed
        FROM item_base
        GROUP BY menu_item_id, item_name
      ),
      complimentary_agg AS (
        SELECT
          mi.id AS menu_item_id,
          COUNT(*)::int AS complimentary_count,
          COALESCE(SUM(COALESCE(oi.cost_price, 0)), 0)::numeric AS complimentary_loss
        FROM order_items oi
        JOIN orders o ON o.id = oi.order_id
        LEFT JOIN menu_item_variants mv ON mv.id = oi.variant_id
        LEFT JOIN menu_items mi ON mi.id = mv.item_id
        WHERE LOWER(COALESCE(o.status, '')) IN ('served', 'completed')
          AND o.created_at >= $1
          AND o.created_at < $2
          AND COALESCE(oi.is_complimentary, FALSE) = TRUE
          AND COALESCE(oi.status, 'active') <> 'cancelled'
          AND ($3::uuid IS NULL OR mi.id = $3::uuid)
        GROUP BY mi.id
      ),
      void_agg AS (
        SELECT
          mi.id AS menu_item_id,
          COUNT(*)::int AS void_count,
          COALESCE(SUM(COALESCE(a.cost_impact, 0)), 0)::numeric AS void_loss
        FROM order_adjustments a
        JOIN orders o ON o.id = a.order_id
        LEFT JOIN order_items oi ON oi.id = a.order_item_id
        LEFT JOIN menu_item_variants mv ON mv.id = oi.variant_id
        LEFT JOIN menu_items mi ON mi.id = mv.item_id
        WHERE LOWER(COALESCE(o.status, '')) IN ('served', 'completed')
          AND o.created_at >= $1
          AND o.created_at < $2
          AND LOWER(COALESCE(a.type, '')) LIKE 'void%'
          AND ($3::uuid IS NULL OR mi.id = $3::uuid)
        GROUP BY mi.id
      ),
      replacement_agg AS (
        SELECT
          mi.id AS menu_item_id,
          COUNT(*)::int AS replacement_count,
          COALESCE(SUM(COALESCE(a.cost_impact, 0)), 0)::numeric AS replacement_cost_impact
        FROM order_adjustments a
        JOIN orders o ON o.id = a.order_id
        LEFT JOIN order_items oi ON oi.id = a.order_item_id
        LEFT JOIN menu_item_variants mv ON mv.id = oi.variant_id
        LEFT JOIN menu_items mi ON mi.id = mv.item_id
        WHERE LOWER(COALESCE(o.status, '')) IN ('served', 'completed')
          AND o.created_at >= $1
          AND o.created_at < $2
          AND LOWER(COALESCE(a.type, '')) = 'replacement'
          AND ($3::uuid IS NULL OR mi.id = $3::uuid)
        GROUP BY mi.id
      ),
      wastage_base AS (
        SELECT
          mi.id AS menu_item_id,
          COALESCE(c.quantity_used, 0)::numeric AS wasted_qty,
          COALESCE((c.quantity_used / COALESCE(NULLIF(rm.conversion_factor, 0), 1)) * COALESCE(rm.purchase_price, 0), 0)::numeric AS wasted_cost,
          CASE
            WHEN COALESCE(oi.is_complimentary, FALSE) THEN 'complimentary_loss'
            WHEN EXISTS (
              SELECT 1 FROM order_adjustments a
              WHERE a.order_item_id = c.order_item_id
                AND LOWER(COALESCE(a.type, '')) = 'replacement'
            ) THEN 'replacement_loss'
            WHEN EXISTS (
              SELECT 1 FROM order_adjustments a
              WHERE a.order_item_id = c.order_item_id
                AND LOWER(COALESCE(a.type, '')) LIKE 'void%'
            ) OR LOWER(COALESCE(oi.status, 'active')) = 'voided' OR COALESCE(oi.is_voided, FALSE) THEN 'void_loss'
            WHEN LOWER(COALESCE(o.status, '')) = 'cancelled' THEN 'cancellation_loss'
            ELSE 'none'
          END AS wastage_source
        FROM order_item_consumptions c
        JOIN orders o ON o.id = c.order_id
        LEFT JOIN order_items oi ON oi.id = c.order_item_id
        LEFT JOIN menu_item_variants mv ON mv.id = oi.variant_id
        LEFT JOIN menu_items mi ON mi.id = mv.item_id
        LEFT JOIN raw_materials rm ON rm.id = c.raw_material_id
        WHERE c.created_at >= $1
          AND c.created_at < $2
          AND ($3::uuid IS NULL OR mi.id = $3::uuid)
      ),
      wastage_agg AS (
        SELECT
          menu_item_id,
          COALESCE(SUM(wasted_cost), 0)::numeric AS total_inventory_wastage_cost
        FROM wastage_base
        WHERE wastage_source IN ('void_loss', 'complimentary_loss', 'replacement_loss', 'cancellation_loss')
        GROUP BY menu_item_id
      )
      SELECT
        s.menu_item_id,
        s.item_name,
        s.quantity_sold,
        s.revenue_generated,
        s.cost_consumed,
        (s.revenue_generated - s.cost_consumed)::numeric AS profit_generated,
        CASE
          WHEN s.revenue_generated > 0
          THEN ((s.revenue_generated - s.cost_consumed) / s.revenue_generated) * 100
          ELSE 0::numeric
        END AS profit_margin,
        COALESCE(c.complimentary_count, 0)::int AS complimentary_count,
        COALESCE(c.complimentary_loss, 0)::numeric AS complimentary_loss,
        COALESCE(v.void_count, 0)::int AS void_count,
        COALESCE(v.void_loss, 0)::numeric AS void_loss,
        COALESCE(r.replacement_count, 0)::int AS replacement_count,
        COALESCE(r.replacement_cost_impact, 0)::numeric AS replacement_cost_impact,
        COALESCE(w.total_inventory_wastage_cost, 0)::numeric AS total_inventory_wastage_cost
      FROM item_sales s
      LEFT JOIN complimentary_agg c ON c.menu_item_id = s.menu_item_id
      LEFT JOIN void_agg v ON v.menu_item_id = s.menu_item_id
      LEFT JOIN replacement_agg r ON r.menu_item_id = s.menu_item_id
      LEFT JOIN wastage_agg w ON w.menu_item_id = s.menu_item_id
      ORDER BY profit_generated DESC, revenue_generated DESC
      `,
      [startDate, startDateExclusiveEnd, menuItemId]
    );

    const menuOptionsQ = await req.tenantDB.query(
      `
      SELECT mi.id, mi.name
      FROM menu_items mi
      WHERE COALESCE(mi.is_active, TRUE) = TRUE
      ORDER BY mi.name ASC
      `
    );

    const rows = (performanceQ.rows || []).map((row) => ({
      menu_item_id: row.menu_item_id,
      item_name: row.item_name || "Unknown Item",
      sold_quantity: Number(row.quantity_sold || 0),
      quantity_sold: Number(row.quantity_sold || 0),
      revenue: Number(row.revenue_generated || 0),
      revenue_generated: Number(row.revenue_generated || 0),
      cost_consumed: Number(row.cost_consumed || 0),
      profit: Number(row.profit_generated || 0),
      profit_generated: Number(row.profit_generated || 0),
      margin: Number(row.profit_margin || 0),
      profit_margin: Number(row.profit_margin || 0),
      complimentary_count: Number(row.complimentary_count || 0),
      complimentary_loss: Number(row.complimentary_loss || 0),
      void_count: Number(row.void_count || 0),
      void_loss: Number(row.void_loss || 0),
      replacement_count: Number(row.replacement_count || 0),
      replacement_cost_impact: Number(row.replacement_cost_impact || 0),
      wastage_cost: Number(row.total_inventory_wastage_cost || 0),
      total_inventory_wastage_cost: Number(row.total_inventory_wastage_cost || 0),
    }));

    const maxRevenue = Math.max(...rows.map((r) => r.revenue_generated), 0);
    const maxProfit = Math.max(...rows.map((r) => Math.max(r.profit_generated, 0)), 0);
    const maxMargin = Math.max(...rows.map((r) => Math.max(r.profit_margin, 0)), 0);

    const scoredItems = rows.map((item) => {
      const salesScore = maxRevenue > 0 ? (item.revenue_generated / maxRevenue) * 25 : 0;
      const profitScore = maxProfit > 0 ? (Math.max(item.profit_generated, 0) / maxProfit) * 35 : 0;
      const marginScore = maxMargin > 0 ? (Math.max(item.profit_margin, 0) / maxMargin) * 25 : 0;
      const opsLoss = item.wastage_cost + item.void_loss + item.replacement_cost_impact + item.complimentary_loss;
      const opsPenaltyPct = item.revenue_generated > 0 ? Math.min((opsLoss / item.revenue_generated) * 100, 100) : (opsLoss > 0 ? 100 : 0);
      const opsScore = ((100 - opsPenaltyPct) / 100) * 15;
      const performanceScore = Math.max(0, Math.min(100, salesScore + profitScore + marginScore + opsScore));
      return {
        ...item,
        performance_score: Number(performanceScore.toFixed(2)),
      };
    });

    const sortedByScore = [...scoredItems].sort((a, b) => b.performance_score - a.performance_score || b.profit_generated - a.profit_generated);
    const topPerformingItems = sortedByScore.slice(0, 10);
    const riskyItems = [...scoredItems]
      .filter((item) => item.performance_score < 35 || item.profit_generated < 0 || item.profit_margin < 10)
      .sort((a, b) => a.performance_score - b.performance_score || a.profit_generated - b.profit_generated)
      .slice(0, 10);
    const lowMarginItems = [...scoredItems]
      .filter((item) => item.profit_margin < 15)
      .sort((a, b) => a.profit_margin - b.profit_margin || a.profit_generated - b.profit_generated)
      .slice(0, 10);

    const summary = scoredItems.reduce(
      (acc, item) => {
        acc.total_revenue += item.revenue_generated;
        acc.total_profit += item.profit_generated;
        acc.total_cost += item.cost_consumed;
        acc.total_wastage_loss += item.wastage_cost;
        acc.items_count += 1;
        return acc;
      },
      { total_revenue: 0, total_profit: 0, total_cost: 0, total_wastage_loss: 0, items_count: 0 }
    );
    summary.avg_margin = summary.total_revenue > 0 ? (summary.total_profit / summary.total_revenue) * 100 : 0;

    return res.status(200).json({
      filters: {
        start_date: startDateIso,
        end_date: endDateIso,
        menu_item_id: menuItemId,
      },
      summary,
      chart: {
        sales_by_item: [...scoredItems]
          .sort((a, b) => b.revenue_generated - a.revenue_generated)
          .slice(0, 10)
          .map((item) => ({
            menu_item_id: item.menu_item_id,
            item_name: item.item_name,
            revenue: item.revenue_generated,
            quantity: item.quantity_sold,
          })),
        profit_by_item: [...scoredItems]
          .sort((a, b) => b.profit_generated - a.profit_generated)
          .slice(0, 10)
          .map((item) => ({
            menu_item_id: item.menu_item_id,
            item_name: item.item_name,
            profit: item.profit_generated,
            margin: item.profit_margin,
          })),
        wastage_by_item: [...scoredItems]
          .sort((a, b) => b.wastage_cost - a.wastage_cost)
          .slice(0, 10)
          .map((item) => ({
            menu_item_id: item.menu_item_id,
            item_name: item.item_name,
            wastage_cost: item.wastage_cost,
          })),
      },
      top_items: topPerformingItems,
      risky_items: riskyItems,
      low_margin_items: lowMarginItems,
      items: sortedByScore,
      menu_item_options: (menuOptionsQ.rows || []).map((row) => ({ id: row.id, name: row.name })),
    });
  } catch (error) {
    logError("GET /api/reports/executive/menu-performance", error);
    return res.status(500).json({ message: "Failed to fetch executive menu performance report." });
  }
};

const getExecutiveTableUsageReport = async (req, res) => {
  try {
    const dateRange = getSalesDateRange(req.query);
    if (!dateRange) {
      return res.status(400).json({ message: "Invalid date range. Use YYYY-MM-DD and ensure start_date <= end_date." });
    }
    const { startDate, startDateExclusiveEnd, startDateIso, endDateIso } = dateRange;

    const tableIdRaw = String(req.query?.table_id || "").trim();
    if (tableIdRaw && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(tableIdRaw)) {
      return res.status(400).json({ message: "Invalid table_id." });
    }
    const tableId = tableIdRaw || null;

    const rowsQ = await req.tenantDB.query(
      `
      WITH base_orders AS (
        SELECT
          o.id AS order_id,
          o.table_id,
          COALESCE(t.name, 'Unknown Table') AS table_name,
          o.created_at,
          o.completed_at,
          COALESCE(o.total_amount, 0)::numeric AS total_revenue,
          COALESCE(o.total_profit, 0)::numeric AS total_profit,
          COALESCE(o.tip_amount, 0)::numeric AS total_tips,
          EXTRACT(HOUR FROM timezone('Asia/Kolkata', o.created_at))::int AS hour_24,
          CASE
            WHEN o.completed_at IS NOT NULL AND o.completed_at >= o.created_at
            THEN EXTRACT(EPOCH FROM (o.completed_at - o.created_at))
            ELSE NULL
          END AS duration_seconds
        FROM orders o
        LEFT JOIN tables t ON t.id = o.table_id
        WHERE LOWER(COALESCE(o.order_type, '')) = 'dine_in'
          AND LOWER(COALESCE(o.status, '')) <> 'cancelled'
          AND o.table_id IS NOT NULL
          AND o.created_at >= $1
          AND o.created_at < $2
          AND ($3::uuid IS NULL OR o.table_id = $3::uuid)
      ),
      per_table AS (
        SELECT
          bo.table_id,
          bo.table_name,
          COUNT(*)::int AS total_orders,
          COALESCE(SUM(bo.total_revenue), 0)::numeric AS total_revenue,
          COALESCE(SUM(bo.total_profit), 0)::numeric AS total_profit,
          COALESCE(SUM(bo.total_tips), 0)::numeric AS total_tips,
          COALESCE(SUM(COALESCE(bo.duration_seconds, 0)), 0)::numeric AS total_occupancy_seconds,
          COALESCE(AVG(bo.duration_seconds), 0)::numeric AS average_turnover_seconds
        FROM base_orders bo
        GROUP BY bo.table_id, bo.table_name
      ),
      peak_hour AS (
        SELECT
          x.table_id,
          x.hour_24,
          x.orders_count
        FROM (
          SELECT
            bo.table_id,
            bo.hour_24,
            COUNT(*)::int AS orders_count,
            ROW_NUMBER() OVER (
              PARTITION BY bo.table_id
              ORDER BY COUNT(*) DESC, bo.hour_24 ASC
            ) AS rn
          FROM base_orders bo
          GROUP BY bo.table_id, bo.hour_24
        ) x
        WHERE x.rn = 1
      )
      SELECT
        pt.table_id,
        pt.table_name,
        pt.total_orders,
        pt.total_revenue,
        pt.total_profit,
        pt.total_tips,
        pt.total_occupancy_seconds,
        pt.average_turnover_seconds,
        COALESCE(ph.hour_24, NULL) AS peak_hour_24,
        COALESCE(ph.orders_count, 0)::int AS peak_hour_orders
      FROM per_table pt
      LEFT JOIN peak_hour ph ON ph.table_id = pt.table_id
      ORDER BY pt.total_revenue DESC, pt.total_orders DESC
      `,
      [startDate, startDateExclusiveEnd, tableId]
    );

    const tableOptionsQ = await req.tenantDB.query(
      `
      SELECT id, name
      FROM tables
      ORDER BY name ASC
      `
    );

    const daysInRange = Math.max(
      1,
      Math.floor((new Date(endDateIso).getTime() - new Date(startDateIso).getTime()) / (24 * 60 * 60 * 1000)) + 1
    );

    const toHourLabel = (hour24) => {
      if (!Number.isFinite(Number(hour24))) return null;
      const start = Number(hour24);
      const end = (start + 1) % 24;
      const to12 = (h) => {
        const suffix = h >= 12 ? "PM" : "AM";
        const hh = h % 12 || 12;
        return `${hh} ${suffix}`;
      };
      return `${to12(start)} - ${to12(end)}`;
    };

    const tables = (rowsQ.rows || []).map((row) => {
      const totalOrders = Number(row.total_orders || 0);
      const turnoverRate = daysInRange > 0 ? totalOrders / daysInRange : 0;
      const occupancyHours = Number(row.total_occupancy_seconds || 0) / 3600;
      return {
        table_id: row.table_id,
        table_name: row.table_name || "Unknown Table",
        orders: totalOrders,
        total_orders: totalOrders,
        revenue: Number(row.total_revenue || 0),
        total_revenue: Number(row.total_revenue || 0),
        profit: Number(row.total_profit || 0),
        total_profit: Number(row.total_profit || 0),
        tips: Number(row.total_tips || 0),
        total_tips: Number(row.total_tips || 0),
        total_occupancy_duration: toDurationPayload(Number(row.total_occupancy_seconds || 0)),
        avg_duration: toDurationPayload(Number(row.average_turnover_seconds || 0)),
        average_turnover_time: toDurationPayload(Number(row.average_turnover_seconds || 0)),
        turnover_rate: Number(turnoverRate.toFixed(2)),
        orders_per_day_average: Number(turnoverRate.toFixed(2)),
        occupancy_hours: Number(occupancyHours.toFixed(2)),
        peak_hour: toHourLabel(Number(row.peak_hour_24)),
        peak_hour_orders: Number(row.peak_hour_orders || 0),
      };
    });

    const summary = tables.reduce(
      (acc, tableRow) => {
        acc.total_revenue += tableRow.total_revenue;
        acc.total_profit += tableRow.total_profit;
        acc.total_tips += tableRow.total_tips;
        acc.total_occupancy_seconds += Number(tableRow.total_occupancy_duration.seconds || 0);
        acc.total_turnover_seconds += Number(tableRow.average_turnover_time.seconds || 0);
        acc.total_tables_used += 1;
        return acc;
      },
      {
        total_revenue: 0,
        total_profit: 0,
        total_tips: 0,
        total_occupancy_seconds: 0,
        total_turnover_seconds: 0,
        total_tables_used: 0,
      }
    );
    summary.avg_occupancy = toDurationPayload(
      summary.total_tables_used > 0 ? summary.total_occupancy_seconds / summary.total_tables_used : 0
    );
    summary.avg_turnover = toDurationPayload(
      summary.total_tables_used > 0 ? summary.total_turnover_seconds / summary.total_tables_used : 0
    );

    const highestRevenueTables = [...tables].sort((a, b) => b.total_revenue - a.total_revenue).slice(0, 10);
    const highestTurnoverTables = [...tables].sort((a, b) => b.turnover_rate - a.turnover_rate).slice(0, 10);
    const longestOccupiedTables = [...tables].sort((a, b) => b.occupancy_hours - a.occupancy_hours).slice(0, 10);
    const avgOrdersPerDay = tables.length > 0 ? tables.reduce((s, r) => s + r.orders_per_day_average, 0) / tables.length : 0;
    const underutilizedTables = [...tables]
      .filter((r) => r.orders_per_day_average <= avgOrdersPerDay * 0.5 || r.total_orders <= 1)
      .sort((a, b) => a.orders_per_day_average - b.orders_per_day_average || a.total_revenue - b.total_revenue)
      .slice(0, 10);

    return res.status(200).json({
      filters: {
        start_date: startDateIso,
        end_date: endDateIso,
        table_id: tableId,
      },
      summary,
      top_tables: highestRevenueTables,
      top_tables_analysis: {
        highest_revenue_tables: highestRevenueTables,
        highest_turnover_tables: highestTurnoverTables,
        longest_occupied_tables: longestOccupiedTables,
      },
      underutilized_tables: underutilizedTables,
      chart: {
        revenue_by_table: highestRevenueTables.map((t) => ({
          table_id: t.table_id,
          table_name: t.table_name,
          revenue: t.total_revenue,
        })),
        turnover_by_table: highestTurnoverTables.map((t) => ({
          table_id: t.table_id,
          table_name: t.table_name,
          turnover_rate: t.turnover_rate,
          orders_per_day_average: t.orders_per_day_average,
        })),
        occupancy_by_table: longestOccupiedTables.map((t) => ({
          table_id: t.table_id,
          table_name: t.table_name,
          occupancy_hours: t.occupancy_hours,
          occupancy_duration: t.total_occupancy_duration,
        })),
      },
      tables,
      table_options: (tableOptionsQ.rows || []).map((row) => ({ id: row.id, name: row.name })),
    });
  } catch (error) {
    logError("GET /api/reports/executive/table-usage", error);
    return res.status(500).json({ message: "Failed to fetch executive table usage report." });
  }
};

module.exports = {
  getSalesReport,
  getProfitLossReport,
  getPaymentsReport,
  getAllOrdersReport,
  getCancelledOrdersReport,
  getVoidItemsReport,
  getReplacementsReport,
  getComplimentaryItemsReport,
  listTipsReport,
  listDiscountsReport,
  listStaffReport,
  listStaffOrdersReport,
  getStaffPerformanceReport,
  getStaffTipsReport,
  getInventoryConsumptionReport,
  getInventoryPurchasesReport,
  getGstSummaryReport,
  getPeakHoursReport,
  getCustomerInsightsReport,
  getTimeEfficiencyReport,
  getItemProfitabilityReport,
  getStockWastageReport,
  getExecutiveMenuPerformanceReport,
  getExecutiveTableUsageReport,
};

