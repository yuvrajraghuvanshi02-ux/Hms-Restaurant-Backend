const SYSTEM_TAX_CODES = ["CGST", "SGST"];
const RESERVED_TAX_CODES = new Set(SYSTEM_TAX_CODES);

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

const breakupLabel = (row) => {
  const code = String(row?.tax_code || "").trim();
  if (code) return code;
  return String(row?.name || "").trim() || "Tax";
};

const computeTax = (subtotal, taxPercentage) => {
  const sub = Number(subtotal || 0);
  const tp = Number(taxPercentage || 0);
  const taxAmount = (sub * tp) / 100;
  const total = sub + taxAmount;
  return { taxAmount, total };
};

const getMandatorySystemTaxes = async (client) => {
  const q = await client.query(
    `
    SELECT id, name, percentage, tax_code, is_system, is_mandatory
    FROM taxes
    WHERE is_active = TRUE
      AND (
        is_mandatory = TRUE
        OR is_system = TRUE
        OR UPPER(COALESCE(tax_code, '')) = ANY($1::text[])
      )
    ORDER BY
      CASE UPPER(COALESCE(tax_code, ''))
        WHEN 'CGST' THEN 1
        WHEN 'SGST' THEN 2
        ELSE 99
      END,
      name ASC
    `,
    [SYSTEM_TAX_CODES]
  );
  return q.rows || [];
};

const mergeWithMandatoryTaxIds = async (client, selectedTaxIds, { applyMandatory = true, subtotal = null } = {}) => {
  const merged = normalizeTaxIds(selectedTaxIds);
  if (!applyMandatory) return merged;
  if (subtotal !== null && Number(subtotal || 0) <= 0) return merged;

  const mandatory = await getMandatorySystemTaxes(client);
  const mandatoryIds = mandatory.map((r) => String(r.id));
  return Array.from(new Set([...mandatoryIds, ...merged]));
};

const computeTaxesFromSelection = async (client, subtotal, selectedTaxIds) => {
  const sub = Number(subtotal || 0);
  const ids = normalizeTaxIds(selectedTaxIds);
  if (ids.length === 0) {
    return { selectedTaxIds: [], taxBreakup: {}, totalTaxAmount: 0, taxPercentage: 0 };
  }

  const q = await client.query(
    `
    SELECT id, name, percentage, tax_code
    FROM taxes
    WHERE id = ANY($1::uuid[])
      AND is_active = TRUE
    ORDER BY
      CASE UPPER(COALESCE(tax_code, ''))
        WHEN 'CGST' THEN 1
        WHEN 'SGST' THEN 2
        ELSE 99
      END,
      name ASC
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
    taxBreakup[breakupLabel(t)] = amount;
    totalTaxAmount += amount;
    taxPercentage += pct;
  }
  return { selectedTaxIds: selected, taxBreakup, totalTaxAmount, taxPercentage };
};

const computeOrderTaxes = async (client, subtotal, selectedTaxIds) => {
  const sub = Number(subtotal || 0);
  if (sub <= 0) {
    return { selectedTaxIds: [], taxBreakup: {}, totalTaxAmount: 0, taxPercentage: 0, taxAmount: 0, total: 0 };
  }
  const mergedIds = await mergeWithMandatoryTaxIds(client, selectedTaxIds, { subtotal: sub });
  const tx = await computeTaxesFromSelection(client, sub, mergedIds);
  const taxAmount = Number(tx.totalTaxAmount || 0);
  return {
    ...tx,
    taxAmount,
    total: sub + taxAmount,
  };
};

const computePurchaseTaxes = async (client, subtotal, selectedTaxIds) => {
  const sub = Number(subtotal || 0);
  if (sub <= 0) {
    return {
      selectedTaxIds: [],
      taxBreakup: {},
      gstPercentage: 0,
      gstAmount: 0,
    };
  }
  const mergedIds = await mergeWithMandatoryTaxIds(client, selectedTaxIds, { subtotal: sub });
  const tx = await computeTaxesFromSelection(client, sub, mergedIds);
  return {
    selectedTaxIds: tx.selectedTaxIds,
    taxBreakup: tx.taxBreakup,
    gstPercentage: Number(tx.taxPercentage || 0),
    gstAmount: Number(tx.totalTaxAmount || 0),
  };
};

const isReservedTaxCode = (code) => RESERVED_TAX_CODES.has(String(code || "").trim().toUpperCase());

const isReservedTaxName = (name) => {
  const n = String(name || "").trim().toLowerCase();
  return n === "cgst" || n === "sgst";
};

const resolveOrderTaxFromSubtotal = async (client, subtotal, selectedTaxIds, taxPercentage = 0) => {
  const sub = Number(subtotal || 0);
  const ids = normalizeTaxIds(selectedTaxIds);
  const mandatoryTaxes = sub > 0 ? await getMandatorySystemTaxes(client) : [];

  if (sub > 0 && (ids.length > 0 || mandatoryTaxes.length > 0)) {
    const tx = await computeOrderTaxes(client, sub, ids);
    return {
      selectedTaxIds: tx.selectedTaxIds,
      taxBreakup: tx.taxBreakup,
      totalTaxAmount: Number(tx.totalTaxAmount || 0),
      taxPercentage: Number(tx.taxPercentage || 0),
      taxAmount: Number(tx.taxAmount || 0),
      total: Number(tx.total || sub + Number(tx.taxAmount || 0)),
    };
  }

  const c = computeTax(sub, taxPercentage);
  const taxAmount = Number(c.taxAmount || 0);
  return {
    selectedTaxIds: ids,
    taxBreakup: Number(taxPercentage || 0) > 0 ? { Tax: taxAmount } : {},
    totalTaxAmount: taxAmount,
    taxPercentage: Number(taxPercentage || 0),
    taxAmount,
    total: Number(c.total || sub),
  };
};

module.exports = {
  SYSTEM_TAX_CODES,
  RESERVED_TAX_CODES,
  normalizeTaxIds,
  computeTax,
  getMandatorySystemTaxes,
  mergeWithMandatoryTaxIds,
  computeTaxesFromSelection,
  computeOrderTaxes,
  computePurchaseTaxes,
  resolveOrderTaxFromSubtotal,
  isReservedTaxCode,
  isReservedTaxName,
};
