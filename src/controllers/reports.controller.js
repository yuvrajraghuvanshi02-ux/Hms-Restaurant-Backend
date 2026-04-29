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

const getGstSummaryReport = async (req, res) => {
  try {
    const range = String(req.query?.range || "month").trim().toLowerCase();
    const allowedRanges = new Set(["day", "week", "month"]);
    const rangeStart = startOfRange(allowedRanges.has(range) ? range : "month");

    const outputQ = await req.tenantDB.query(
      `
      SELECT
        COALESCE(
          SUM(
            CASE
              WHEN o.total_tax_amount IS NOT NULL THEN o.total_tax_amount
              ELSE o.tax_amount
            END
          ),
          0
        )::numeric AS total_output_gst
      FROM orders o
      WHERE COALESCE(o.completed_at, o.created_at) >= $1
        AND (LOWER(COALESCE(o.status, '')) = 'completed' OR LOWER(COALESCE(o.payment_status, '')) = 'paid')
      `,
      [rangeStart]
    );

    const inputQ = await req.tenantDB.query(
      `
      SELECT COALESCE(SUM(po.gst_amount), 0)::numeric AS total_input_gst
      FROM purchase_orders po
      WHERE po.created_at >= $1
      `,
      [rangeStart]
    );

    const totalOutputGst = Number(outputQ.rows[0]?.total_output_gst || 0);
    const totalInputGst = Number(inputQ.rows[0]?.total_input_gst || 0);
    const netGst = totalOutputGst - totalInputGst;

    return res.status(200).json({
      range,
      total_output_gst: totalOutputGst,
      total_input_gst: totalInputGst,
      net_gst: Math.abs(netGst),
      gst_status: netGst >= 0 ? "payable" : "credit",
      gst_payable: netGst >= 0 ? netGst : 0,
      gst_credit: netGst < 0 ? Math.abs(netGst) : 0,
    });
  } catch (error) {
    logError("GET /api/reports/gst-summary", error);
    return res.status(500).json({ message: "Failed to fetch GST summary report." });
  }
};

module.exports = { listTipsReport, listDiscountsReport, getGstSummaryReport };

