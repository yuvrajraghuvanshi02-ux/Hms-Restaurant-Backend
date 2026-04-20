const toPositiveNumber = (value, label) => {
  const n = Number(value);
  if (Number.isNaN(n) || !Number.isFinite(n) || n <= 0) {
    const err = new Error(`${label} must be greater than 0.`);
    err.statusCode = 400;
    throw err;
  }
  return n;
};

const ensureUuid = (value, label) => {
  const v = String(value || "").trim();
  if (!v) {
    const err = new Error(`${label} is required.`);
    err.statusCode = 400;
    throw err;
  }
  return v;
};

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

const convertToStockUnit = ({
  quantity,
  fromUnitId,
  stockUnitId,
  consumptionUnitId,
  conversionFactor,
}) => {
  if (!stockUnitId || fromUnitId === stockUnitId) return quantity;

  if (consumptionUnitId && fromUnitId === consumptionUnitId) {
    const factor = Number(conversionFactor || 1);
    if (Number.isNaN(factor) || factor <= 0) {
      const err = new Error("Invalid conversion factor for raw material.");
      err.statusCode = 400;
      throw err;
    }
    return quantity / factor;
  }

  const err = new Error("Unit mismatch for stock operation.");
  err.statusCode = 400;
  throw err;
};

const addStock = async (tenantPool, { raw_material_id, quantity, unit_id }) => {
  const rawMaterialId = ensureUuid(raw_material_id, "raw_material_id");
  const unitId = ensureUuid(unit_id, "unit_id");
  const qty = toPositiveNumber(quantity, "quantity");

  return await withTenantTx(tenantPool, async (client) => {
    const unit = await client.query("SELECT id FROM units WHERE id = $1 LIMIT 1", [unitId]);
    if (unit.rowCount === 0) {
      const err = new Error("Unit not found.");
      err.statusCode = 400;
      throw err;
    }

    // lock raw material row to avoid concurrent stock updates
    const rm = await client.query(
      `
      SELECT id, name, current_stock, stock_unit_id, consumption_unit_id, conversion_factor
      FROM raw_materials
      WHERE id = $1
      FOR UPDATE
      `,
      [rawMaterialId]
    );
    if (rm.rowCount === 0) {
      const err = new Error("Raw material not found.");
      err.statusCode = 404;
      throw err;
    }

    const row = rm.rows[0];
    const stockUnitId = row.stock_unit_id || unitId;
    const convertedQty = convertToStockUnit({
      quantity: qty,
      fromUnitId: unitId,
      stockUnitId,
      consumptionUnitId: row.consumption_unit_id,
      conversionFactor: row.conversion_factor,
    });

    if (convertedQty <= 0) {
      const err = new Error("quantity must be greater than 0.");
      err.statusCode = 400;
      throw err;
    }

    const updated = await client.query(
      `
      UPDATE raw_materials
      SET current_stock = current_stock + $1,
          stock_unit_id = COALESCE(stock_unit_id, $2)
      WHERE id = $3
      RETURNING id, name, current_stock, stock_unit_id
      `,
      [convertedQty, stockUnitId, rawMaterialId]
    );

    return updated.rows[0];
  });
};

const deductStockByVariant = async (tenantPool, variantId) => {
  const vId = ensureUuid(variantId, "menu_item_variant_id");

  return await withTenantTx(tenantPool, async (client) => {
    // lock all raw materials involved in this recipe in a single query
    const rows = await client.query(
      `
      SELECT
        ri.raw_material_id,
        rm.name AS raw_material_name,
        rm.current_stock,
        rm.stock_unit_id,
        rm.consumption_unit_id,
        rm.conversion_factor,
        ri.quantity AS recipe_quantity,
        ri.unit_id AS recipe_unit_id
      FROM recipe_items ri
      JOIN raw_materials rm ON rm.id = ri.raw_material_id
      WHERE ri.menu_item_variant_id = $1
      FOR UPDATE OF rm
      `,
      [vId]
    );

    if (rows.rowCount === 0) {
      const err = new Error("Recipe not found for this variant.");
      err.statusCode = 404;
      throw err;
    }

    // validate all deductions first (no partial deduction)
    const requirements = rows.rows.map((r) => {
      const reqQty = toPositiveNumber(r.recipe_quantity, "quantity");
      const needed = convertToStockUnit({
        quantity: reqQty,
        fromUnitId: r.recipe_unit_id,
        stockUnitId: r.stock_unit_id || r.recipe_unit_id,
        consumptionUnitId: r.consumption_unit_id,
        conversionFactor: r.conversion_factor,
      });
      return {
        raw_material_id: r.raw_material_id,
        raw_material_name: r.raw_material_name,
        stock_unit_id: r.stock_unit_id || r.recipe_unit_id,
        needed,
        current: Number(r.current_stock || 0),
      };
    });

    for (const req of requirements) {
      if (req.current < req.needed) {
        const err = new Error(`Insufficient stock for ${req.raw_material_name}`);
        err.statusCode = 400;
        throw err;
      }
    }

    // deduct after validation
    for (const req of requirements) {
      await client.query(
        `
        UPDATE raw_materials
        SET current_stock = current_stock - $1,
            stock_unit_id = COALESCE(stock_unit_id, $2)
        WHERE id = $3
        `,
        [req.needed, req.stock_unit_id, req.raw_material_id]
      );
    }

    return true;
  });
};

module.exports = {
  addStock,
  deductStockByVariant,
};

