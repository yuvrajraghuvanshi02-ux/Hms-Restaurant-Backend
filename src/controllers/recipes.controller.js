const { randomUUID } = require("crypto");
const { logError } = require("../utils/logError");
const { parseListParams, buildPagination, pickSort } = require("../utils/listQuery");

const parsePositiveNumber = (value, label) => {
  const num = Number(value);
  if (Number.isNaN(num) || num <= 0) {
    throw new Error(`${label} must be a number greater than 0.`);
  }
  return num;
};

const uniqueRawMaterials = (materials) => {
  const seen = new Set();
  for (const m of materials) {
    const id = String(m?.raw_material_id || "").trim();
    if (!id) continue;
    if (seen.has(id)) return false;
    seen.add(id);
  }
  return true;
};

const normalizeSteps = (steps) => {
  const input = Array.isArray(steps) ? steps : [];
  // keep only rows where something is entered
  const trimmed = input
    .map((s) => ({
      step_title: String(s?.step_title || "").trim(),
      step_description:
        s?.step_description === undefined || s?.step_description === null
          ? null
          : String(s.step_description).trim(),
    }))
    .filter((s) => s.step_title || s.step_description);

  for (const s of trimmed) {
    if (!s.step_title) throw new Error("Step title is required.");
  }
  return trimmed;
};

const upsertRecipe = async (req, res) => {
  const { menu_item_variant_id, materials, steps } = req.body || {};

  if (!menu_item_variant_id?.trim()) {
    return res.status(400).json({ message: "menu_item_variant_id is required." });
  }
  const rows = Array.isArray(materials) ? materials : [];
  if (rows.length === 0) {
    return res.status(400).json({ message: "At least one raw material is required." });
  }
  if (!uniqueRawMaterials(rows)) {
    return res.status(400).json({ message: "Duplicate raw materials are not allowed." });
  }

  try {
    let normalizedSteps = [];
    try {
      normalizedSteps = normalizeSteps(steps);
    } catch (e) {
      return res.status(400).json({ message: e.message });
    }

    const variantExists = await req.tenantDB.query(
      "SELECT id FROM menu_item_variants WHERE id = $1 LIMIT 1",
      [menu_item_variant_id]
    );
    if (variantExists.rowCount === 0) {
      return res.status(400).json({ message: "Selected menu item variant does not exist." });
    }

    // Validate ids + quantities first (no partial writes)
    for (const m of rows) {
      const rawId = String(m?.raw_material_id || "").trim();
      const unitId = String(m?.unit_id || "").trim();
      if (!rawId) return res.status(400).json({ message: "raw_material_id is required." });
      if (!unitId) return res.status(400).json({ message: "unit_id is required." });

      try {
        parsePositiveNumber(m?.quantity, "Quantity");
      } catch (e) {
        return res.status(400).json({ message: e.message });
      }

      const rawMaterial = await req.tenantDB.query(
        `
        SELECT id, name, consumption_unit_id
        FROM raw_materials
        WHERE id = $1
        LIMIT 1
        `,
        [rawId]
      );
      if (rawMaterial.rowCount === 0) {
        return res.status(400).json({ message: "Selected raw material does not exist." });
      }

      const unitExists = await req.tenantDB.query("SELECT id FROM units WHERE id = $1 LIMIT 1", [
        unitId,
      ]);
      if (unitExists.rowCount === 0) {
        return res.status(400).json({ message: "Selected unit does not exist." });
      }

      const allowedUnitId = rawMaterial.rows[0].consumption_unit_id;
      if (!allowedUnitId || allowedUnitId !== unitId) {
        return res.status(400).json({
          message: `Recipe unit mismatch for ${rawMaterial.rows[0].name}. Use the configured consumption unit.`,
        });
      }
    }

    await req.tenantDB.query("BEGIN");

    await req.tenantDB.query("DELETE FROM recipe_items WHERE menu_item_variant_id = $1", [
      menu_item_variant_id,
    ]);

    for (const m of rows) {
      await req.tenantDB.query(
        `
        INSERT INTO recipe_items (id, menu_item_variant_id, raw_material_id, quantity, unit_id)
        VALUES ($1, $2, $3, $4, $5)
        `,
        [
          randomUUID(),
          menu_item_variant_id,
          String(m.raw_material_id).trim(),
          parsePositiveNumber(m.quantity, "Quantity"),
          String(m.unit_id).trim(),
        ]
      );
    }

    await req.tenantDB.query("DELETE FROM recipe_steps WHERE menu_item_variant_id = $1", [
      menu_item_variant_id,
    ]);

    for (let i = 0; i < normalizedSteps.length; i++) {
      const s = normalizedSteps[i];
      await req.tenantDB.query(
        `
        INSERT INTO recipe_steps (id, menu_item_variant_id, step_title, step_description, step_order)
        VALUES ($1, $2, $3, $4, $5)
        `,
        [randomUUID(), menu_item_variant_id, s.step_title, s.step_description, i + 1]
      );
    }

    await req.tenantDB.query("COMMIT");
    return res.status(200).json({ message: "Recipe saved." });
  } catch (error) {
    try {
      await req.tenantDB.query("ROLLBACK");
    } catch (_) {}
    logError("POST /api/recipes", error);
    return res.status(500).json({ message: "Failed to save recipe." });
  }
};

const getRecipeByVariant = async (req, res) => {
  const variantId = req.params.variantId;
  try {
    const meta = await req.tenantDB.query(
      `
      SELECT
        v.id AS variant_id,
        v.name AS variant_name,
        i.name AS item_name
      FROM menu_item_variants v
      JOIN menu_items i ON i.id = v.item_id
      WHERE v.id = $1
      LIMIT 1
      `,
      [variantId]
    );

    if (meta.rowCount === 0) {
      return res.status(404).json({ message: "Variant not found." });
    }

    const materials = await req.tenantDB.query(
      `
      SELECT
        ri.raw_material_id,
        rm.name AS raw_material_name,
        ri.quantity,
        ri.unit_id,
        u.name AS unit_name,
        u.short_name AS unit_short_name
      FROM recipe_items ri
      JOIN raw_materials rm ON rm.id = ri.raw_material_id
      JOIN units u ON u.id = ri.unit_id
      WHERE ri.menu_item_variant_id = $1
      ORDER BY rm.name ASC
      `,
      [variantId]
    );

    const steps = await req.tenantDB.query(
      `
      SELECT
        step_title,
        step_description,
        step_order
      FROM recipe_steps
      WHERE menu_item_variant_id = $1
      ORDER BY step_order ASC
      `,
      [variantId]
    );

    return res.status(200).json({
      variant_id: meta.rows[0].variant_id,
      variant_name: meta.rows[0].variant_name,
      item_name: meta.rows[0].item_name,
      materials: materials.rows,
      steps: steps.rows,
    });
  } catch (error) {
    logError("GET /api/recipes/:variantId", error);
    return res.status(500).json({ message: "Failed to fetch recipe." });
  }
};

const listRecipes = async (req, res) => {
  try {
    const params = parseListParams(req.query, { defaultSortBy: "item_name", defaultOrder: "ASC" });
    const { sortBy, order } = pickSort(params, ["item_name", "variant_name"], "item_name");

    const hasSearch = Boolean(params.search);
    const where = hasSearch
      ? "WHERE (i.name ILIKE $1 OR v.name ILIKE $1)"
      : "";
    const countArgs = hasSearch ? [`%${params.search}%`] : [];

    const totalResult = await req.tenantDB.query(
      `
      SELECT COUNT(DISTINCT v.id)::int AS total
      FROM recipe_items ri
      JOIN menu_item_variants v ON v.id = ri.menu_item_variant_id
      JOIN menu_items i ON i.id = v.item_id
      ${where}
      `,
      countArgs
    );
    const total = totalResult.rows[0]?.total ?? 0;

    const pageArgs = hasSearch
      ? [`%${params.search}%`, params.limit, params.offset]
      : [params.limit, params.offset];

    const variantsPage = await req.tenantDB.query(
      `
      SELECT DISTINCT
        v.id AS variant_id,
        v.name AS variant_name,
        i.name AS item_name
      FROM recipe_items ri
      JOIN menu_item_variants v ON v.id = ri.menu_item_variant_id
      JOIN menu_items i ON i.id = v.item_id
      ${where}
      ORDER BY ${sortBy === "variant_name" ? "v.name" : "i.name"} ${order},
               ${sortBy === "variant_name" ? "i.name" : "v.name"} ASC
      LIMIT $${hasSearch ? 2 : 1} OFFSET $${hasSearch ? 3 : 2}
      `,
      pageArgs
    );

    const variantIds = variantsPage.rows.map((r) => r.variant_id);
    if (variantIds.length === 0) {
      return res.status(200).json({
        data: [],
        pagination: buildPagination({ total, page: params.page, limit: params.limit }),
      });
    }

    const materials = await req.tenantDB.query(
      `
      SELECT
        v.id AS variant_id,
        v.name AS variant_name,
        i.name AS item_name,
        ri.raw_material_id,
        rm.name AS raw_material_name,
        ri.quantity,
        ri.unit_id,
        u.name AS unit_name,
        u.short_name AS unit_short_name
      FROM recipe_items ri
      JOIN menu_item_variants v ON v.id = ri.menu_item_variant_id
      JOIN menu_items i ON i.id = v.item_id
      JOIN raw_materials rm ON rm.id = ri.raw_material_id
      JOIN units u ON u.id = ri.unit_id
      WHERE v.id = ANY($1)
      ORDER BY i.name ASC, v.name ASC, rm.name ASC
      `,
      [variantIds]
    );

    const grouped = new Map();
    for (const v of variantsPage.rows) {
      grouped.set(v.variant_id, {
        variant_id: v.variant_id,
        variant_name: v.variant_name,
        item_name: v.item_name,
        materials: [],
      });
    }
    for (const row of materials.rows) {
      if (!grouped.has(row.variant_id)) continue;
      grouped.get(row.variant_id).materials.push({
        raw_material_id: row.raw_material_id,
        raw_material_name: row.raw_material_name,
        quantity: row.quantity,
        unit_id: row.unit_id,
        unit_name: row.unit_name,
        unit_short_name: row.unit_short_name,
      });
    }

    const data = variantIds.map((id) => grouped.get(id)).filter(Boolean);
    return res.status(200).json({
      data,
      pagination: buildPagination({ total, page: params.page, limit: params.limit }),
    });
  } catch (error) {
    logError("GET /api/recipes", error);
    return res.status(500).json({ message: "Failed to fetch recipes." });
  }
};

const deleteRecipeByVariant = async (req, res) => {
  const variantId = req.params.variantId;
  try {
    await req.tenantDB.query("DELETE FROM recipe_items WHERE menu_item_variant_id = $1", [variantId]);
    await req.tenantDB.query("DELETE FROM recipe_steps WHERE menu_item_variant_id = $1", [variantId]);
    return res.status(200).json({ message: "Recipe deleted." });
  } catch (error) {
    logError("DELETE /api/recipes/:variantId", error);
    return res.status(500).json({ message: "Failed to delete recipe." });
  }
};

module.exports = {
  upsertRecipe,
  listRecipes,
  getRecipeByVariant,
  deleteRecipeByVariant,
};

