const { randomUUID } = require("crypto");
const { logError } = require("../utils/logError");

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
    const err = new Error(`${label} must be >= 0.`);
    err.statusCode = 400;
    throw err;
  }
  return n;
};

const validateMetadata = (mode, metadata, amount) => {
  const m = metadata && typeof metadata === "object" ? metadata : null;
  if (amount <= 0) return null;
  if (mode === "upi") {
    const tx = String(m?.transaction_id || "").trim();
    // UPI transaction_id is optional; store it if present
    return tx ? { ...m, transaction_id: tx } : m;
  }
  if (mode === "card") {
    const last4 = String(m?.last_4_digits || "").trim();
    if (!last4) {
      const err = new Error("Card last_4_digits is required.");
      err.statusCode = 400;
      throw err;
    }
    return { ...m, last_4_digits: last4 };
  }
  return m;
};

const createPayment = async (req, res) => {
  const { order_id, payments, discount_amount } = req.body || {};
  const orderId = String(order_id || "").trim();
  if (!orderId) return res.status(400).json({ message: "order_id is required." });
  const rows = Array.isArray(payments) ? payments : [];
  if (rows.length === 0) return res.status(400).json({ message: "payments must have at least 1 item." });

  const allowed = new Set(["cash", "upi", "card"]);

  let normalized;
  try {
    normalized = rows.map((p, idx) => {
      const mode = String(p?.mode || "").trim().toLowerCase();
      if (!allowed.has(mode)) {
        const err = new Error(`payments[${idx}].mode is invalid.`);
        err.statusCode = 400;
        throw err;
      }
      const amount = toNonNegativeNumber(p?.amount, `payments[${idx}].amount`);
      const metadata = validateMetadata(mode, p?.metadata, amount);
      return { mode, amount, metadata };
    });
  } catch (e) {
    return res.status(e.statusCode || 400).json({ message: e.message });
  }

  const paidAmount = normalized.reduce((s, x) => s + Number(x.amount || 0), 0);

  try {
    const out = await withTenantTx(req.tenantDB, async (client) => {
      const hasDiscountInput = discount_amount !== undefined && discount_amount !== null && discount_amount !== "";
      const discountAmountInput = hasDiscountInput ? toNonNegativeNumber(discount_amount, "discount_amount") : 0;

      const ord = await client.query(
        `
        SELECT
          id,
          status,
          total_amount,
          guest_name,
          guest_phone,
          payment_status
        FROM orders
        WHERE id = $1
        LIMIT 1
        FOR UPDATE
        `,
        [orderId]
      );
      if (ord.rowCount === 0) {
        const err = new Error("Order not found.");
        err.statusCode = 404;
        throw err;
      }
      const order = ord.rows[0];
      const status = String(order.status || "").toLowerCase();
      if (status !== "served") {
        const err = new Error("Payment is allowed only when order is served.");
        err.statusCode = 400;
        throw err;
      }
      if (String(order.payment_status || "").toLowerCase() === "paid") {
        const err = new Error("Payment already exists for this order.");
        err.statusCode = 409;
        throw err;
      }

      const guestName = String(order.guest_name || "").trim();
      const guestPhone = String(order.guest_phone || "").trim();
      if (!guestName || !guestPhone) {
        const err = new Error("Guest details required");
        err.statusCode = 400;
        throw err;
      }

      const expectedTotal = Number(order.total_amount || 0);
      if (Number.isNaN(expectedTotal)) {
        const err = new Error("Invalid order total.");
        err.statusCode = 400;
        throw err;
      }

      if (!Number.isFinite(paidAmount) || paidAmount <= 0) {
        const err = new Error("paid_amount must be greater than 0.");
        err.statusCode = 400;
        throw err;
      }

      // Auto derive discount/tip from what customer paid (order total).
      // - If paid < total => discount = total - paid, tip = 0, final_payable = paid
      // - If paid > total => tip = paid - total, discount = 0, final_payable = total
      // - If equal => both 0, final_payable = total
      //
      // If discount_amount is explicitly provided, we respect it for final payable calculation
      // and then compute tip relative to final payable.
      const discountAmount = hasDiscountInput ? discountAmountInput : Math.max(0, expectedTotal - paidAmount);
      const finalPayable = expectedTotal - discountAmount;
      if (!Number.isFinite(finalPayable) || finalPayable < 0) {
        const err = new Error("discount_amount cannot exceed total_amount.");
        err.statusCode = 400;
        throw err;
      }

      const tipAmount = Math.max(0, paidAmount - finalPayable);

      const existing = await client.query("SELECT id FROM payments WHERE order_id = $1 LIMIT 1", [orderId]);
      if (existing.rowCount > 0) {
        const err = new Error("Payment already exists for this order.");
        err.statusCode = 409;
        throw err;
      }

      const paymentId = randomUUID();
      const inserted = await client.query(
        `
        INSERT INTO payments (id, order_id, total_amount, paid_amount)
        VALUES ($1, $2, $3, $4)
        RETURNING id, order_id, total_amount, paid_amount, created_at, updated_at
        `,
        [paymentId, orderId, finalPayable, paidAmount]
      );

      for (const p of normalized) {
        if (Number(p.amount) <= 0) continue;
        await client.query(
          `
          INSERT INTO payment_items (id, payment_id, mode, amount, metadata)
          VALUES ($1, $2, $3, $4, $5)
          `,
          [randomUUID(), paymentId, p.mode, p.amount, p.metadata || null]
        );
      }

      await client.query(
        `
        UPDATE orders
        SET status = 'completed',
            payment_status = 'paid',
            discount_amount = $1,
            tip_amount = $2,
            completed_at = COALESCE(completed_at, NOW()),
            updated_at = NOW()
        WHERE id = $3
        `,
        [discountAmount, tipAmount, orderId]
      );

      return inserted.rows[0];
    });

    return res.status(201).json({ message: "Payment recorded. Order completed.", data: out });
  } catch (error) {
    logError("POST /api/payments", error);
    return res.status(error.statusCode || 500).json({ message: error?.message || "Failed to create payment." });
  }
};

const getPaymentByOrder = async (req, res) => {
  const { order_id } = req.params;
  const orderId = String(order_id || "").trim();
  if (!orderId) return res.status(400).json({ message: "order_id is required." });

  try {
    const pay = await req.tenantDB.query(
      `
      SELECT
        p.id,
        p.order_id,
        p.total_amount,
        p.paid_amount,
        p.created_at,
        p.updated_at
      FROM payments p
      WHERE p.order_id = $1
      LIMIT 1
      `,
      [orderId]
    );
    if (pay.rowCount === 0) return res.status(404).json({ message: "Payment not found for this order." });

    const items = await req.tenantDB.query(
      `
      SELECT id, mode, amount, metadata
      FROM payment_items
      WHERE payment_id = $1
      ORDER BY mode ASC
      `,
      [pay.rows[0].id]
    );

    return res.status(200).json({
      data: { ...pay.rows[0], items: items.rows || [] },
    });
  } catch (error) {
    logError("GET /api/payments/:order_id", error);
    return res.status(500).json({ message: "Failed to fetch payment." });
  }
};

module.exports = { createPayment, getPaymentByOrder };

