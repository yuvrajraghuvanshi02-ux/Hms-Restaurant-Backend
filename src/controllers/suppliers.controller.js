const { randomUUID } = require("crypto");
const { logError } = require("../utils/logError");
const { parseListParams, buildPagination, pickSort } = require("../utils/listQuery");

const isUniqueViolation = (error) => error?.code === "23505";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_REGEX = /^[\d+\s().-]{8,20}$/;
const IFSC_REGEX = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const UPI_REGEX = /^[\w.\-]{2,64}@[\w.\-]{2,64}$/i;
const BANK_ACCOUNT_REGEX = /^[A-Za-z0-9\-]{5,34}$/;

const trimOrNull = (v) => {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
};

const normalizeIfsc = (v) => {
  const s = trimOrNull(v);
  return s ? s.toUpperCase() : null;
};

const validatePayload = (payload, { requireName = true } = {}) => {
  const {
    name,
    phone,
    email,
    gst_number,
    contact_person,
    address,
    city,
    state,
    upi_id,
    bank_name,
    bank_ifsc,
    bank_account_number,
  } = payload;

  const n = String(name || "").trim();
  if (requireName && !n) return "Supplier name is required.";

  const ph = trimOrNull(phone);
  if (ph && !PHONE_REGEX.test(ph)) {
    return "Phone number format is invalid.";
  }

  const em = trimOrNull(email);
  if (em && !EMAIL_REGEX.test(em)) {
    return "Email format is invalid.";
  }

  const ifsc = normalizeIfsc(bank_ifsc);
  if (ifsc && !IFSC_REGEX.test(ifsc)) {
    return "IFSC format is invalid (expected 11 characters, e.g. SBIN0001234).";
  }

  const upi = trimOrNull(upi_id);
  if (upi && !UPI_REGEX.test(upi)) {
    return "UPI ID format is invalid.";
  }

  const acct = trimOrNull(bank_account_number);
  if (acct && !BANK_ACCOUNT_REGEX.test(acct)) {
    return "Bank account number format is invalid.";
  }

  const gst = trimOrNull(gst_number);
  if (gst && (gst.length < 2 || gst.length > 20)) {
    return "GST number length is invalid.";
  }

  return null;
};

const supplierColumns = `
  id, name, phone, email, gst_number, contact_person, address, city, state,
  upi_id, bank_name, bank_ifsc, bank_account_number,
  is_active, created_at, updated_at
`;

const createSupplier = async (req, res) => {
  const body = req.body || {};
  const err = validatePayload(body);
  if (err) return res.status(400).json({ message: err });

  const nm = String(body.name).trim();
  const ph = trimOrNull(body.phone);
  const em = trimOrNull(body.email);
  const gst = trimOrNull(body.gst_number);
  const contact = trimOrNull(body.contact_person);
  const addr = trimOrNull(body.address);
  const city = trimOrNull(body.city);
  const st = trimOrNull(body.state);
  const upi = trimOrNull(body.upi_id);
  const bankName = trimOrNull(body.bank_name);
  const ifsc = normalizeIfsc(body.bank_ifsc);
  const acct = trimOrNull(body.bank_account_number);

  try {
    const result = await req.tenantDB.query(
      `
      INSERT INTO suppliers (
        id, name, phone, email, gst_number, contact_person, address, city, state,
        upi_id, bank_name, bank_ifsc, bank_account_number, is_active
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, true)
      RETURNING ${supplierColumns}
      `,
      [
        randomUUID(),
        nm,
        ph,
        em,
        gst,
        contact,
        addr,
        city,
        st,
        upi,
        bankName,
        ifsc,
        acct,
      ]
    );
    return res.status(201).json({ message: "Supplier created.", data: result.rows[0] });
  } catch (error) {
    if (isUniqueViolation(error)) {
      return res.status(409).json({ message: "A supplier with this name already exists." });
    }
    logError("POST /api/suppliers", error);
    return res.status(500).json({ message: "Failed to create supplier." });
  }
};

const listSuppliers = async (req, res) => {
  try {
    const params = parseListParams(req.query, { defaultSortBy: "created_at", defaultOrder: "DESC" });
    const { sortBy, order } = pickSort(params, ["created_at", "name"], "created_at");

    const hasSearch = Boolean(params.search);
    const where = hasSearch
      ? `WHERE (
          name ILIKE $1 OR phone ILIKE $1 OR city ILIKE $1
          OR contact_person ILIKE $1 OR email ILIKE $1
        )`
      : "";
    const countArgs = hasSearch ? [`%${params.search}%`] : [];

    const totalResult = await req.tenantDB.query(
      `SELECT COUNT(*)::int AS total FROM suppliers ${where}`,
      countArgs
    );
    const total = totalResult.rows[0]?.total ?? 0;

    const dataArgs = hasSearch
      ? [`%${params.search}%`, params.limit, params.offset]
      : [params.limit, params.offset];

    const result = await req.tenantDB.query(
      `
      SELECT ${supplierColumns}
      FROM suppliers
      ${where}
      ORDER BY ${sortBy} ${order}
      LIMIT $${hasSearch ? 2 : 1} OFFSET $${hasSearch ? 3 : 2}
      `,
      dataArgs
    );

    return res.status(200).json({
      data: result.rows,
      pagination: buildPagination({ total, page: params.page, limit: params.limit }),
    });
  } catch (error) {
    logError("GET /api/suppliers", error);
    return res.status(500).json({ message: "Failed to fetch suppliers." });
  }
};

const getSupplier = async (req, res) => {
  const { id } = req.params;
  try {
    const result = await req.tenantDB.query(
      `
      SELECT ${supplierColumns}
      FROM suppliers
      WHERE id = $1
      LIMIT 1
      `,
      [id]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ message: "Supplier not found." });
    }
    return res.status(200).json({ data: result.rows[0] });
  } catch (error) {
    logError("GET /api/suppliers/:id", error);
    return res.status(500).json({ message: "Failed to fetch supplier." });
  }
};

const updateSupplier = async (req, res) => {
  const { id } = req.params;
  const body = req.body || {};

  try {
    const existing = await req.tenantDB.query(
      `
      SELECT ${supplierColumns}
      FROM suppliers
      WHERE id = $1
      LIMIT 1
      `,
      [id]
    );
    if (existing.rowCount === 0) {
      return res.status(404).json({ message: "Supplier not found." });
    }

    const cur = existing.rows[0];
    const merged = {
      name: body.name !== undefined ? String(body.name).trim() : cur.name,
      phone: body.phone !== undefined ? trimOrNull(body.phone) : cur.phone,
      email: body.email !== undefined ? trimOrNull(body.email) : cur.email,
      gst_number: body.gst_number !== undefined ? trimOrNull(body.gst_number) : cur.gst_number,
      contact_person:
        body.contact_person !== undefined ? trimOrNull(body.contact_person) : cur.contact_person,
      address: body.address !== undefined ? trimOrNull(body.address) : cur.address,
      city: body.city !== undefined ? trimOrNull(body.city) : cur.city,
      state: body.state !== undefined ? trimOrNull(body.state) : cur.state,
      upi_id: body.upi_id !== undefined ? trimOrNull(body.upi_id) : cur.upi_id,
      bank_name: body.bank_name !== undefined ? trimOrNull(body.bank_name) : cur.bank_name,
      bank_ifsc:
        body.bank_ifsc !== undefined ? normalizeIfsc(body.bank_ifsc) : cur.bank_ifsc,
      bank_account_number:
        body.bank_account_number !== undefined
          ? trimOrNull(body.bank_account_number)
          : cur.bank_account_number,
      is_active: body.is_active !== undefined ? Boolean(body.is_active) : cur.is_active,
    };

    const err = validatePayload(merged, { requireName: true });
    if (err) return res.status(400).json({ message: err });

    const updated = await req.tenantDB.query(
      `
      UPDATE suppliers
      SET
        name = $1,
        phone = $2,
        email = $3,
        gst_number = $4,
        contact_person = $5,
        address = $6,
        city = $7,
        state = $8,
        upi_id = $9,
        bank_name = $10,
        bank_ifsc = $11,
        bank_account_number = $12,
        is_active = $13,
        updated_at = NOW()
      WHERE id = $14
      RETURNING ${supplierColumns}
      `,
      [
        merged.name,
        merged.phone,
        merged.email,
        merged.gst_number,
        merged.contact_person,
        merged.address,
        merged.city,
        merged.state,
        merged.upi_id,
        merged.bank_name,
        merged.bank_ifsc,
        merged.bank_account_number,
        merged.is_active,
        id,
      ]
    );

    return res.status(200).json({ message: "Supplier updated.", data: updated.rows[0] });
  } catch (error) {
    if (isUniqueViolation(error)) {
      return res.status(409).json({ message: "A supplier with this name already exists." });
    }
    logError("PUT /api/suppliers/:id", error);
    return res.status(500).json({ message: "Failed to update supplier." });
  }
};

const deleteSupplier = async (req, res) => {
  const { id } = req.params;
  try {
    const existing = await req.tenantDB.query("SELECT id FROM suppliers WHERE id = $1 LIMIT 1", [id]);
    if (existing.rowCount === 0) {
      return res.status(404).json({ message: "Supplier not found." });
    }

    await req.tenantDB.query(
      `
      UPDATE suppliers
      SET is_active = false, updated_at = NOW()
      WHERE id = $1
      `,
      [id]
    );
    return res.status(200).json({ message: "Supplier deactivated." });
  } catch (error) {
    logError("DELETE /api/suppliers/:id", error);
    return res.status(500).json({ message: "Failed to deactivate supplier." });
  }
};

module.exports = {
  createSupplier,
  listSuppliers,
  getSupplier,
  updateSupplier,
  deleteSupplier,
};
