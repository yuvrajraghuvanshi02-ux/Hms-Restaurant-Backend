const { randomUUID } = require("crypto");
const { logError } = require("../utils/logError");
const { parseListParams, buildPagination, pickSort } = require("../utils/listQuery");

const isUniqueViolation = (error) => error?.code === "23505";

const parseNonNegativeNumber = (value, label) => {
  const num = Number(value);
  if (Number.isNaN(num) || num < 0) {
    throw new Error(`${label} must be a number >= 0.`);
  }
  return num;
};

const validateUniqueVariantNames = (variants) => {
  const seen = new Set();
  for (const v of variants) {
    const normalized = String(v?.name || "").trim().toLowerCase();
    if (!normalized) continue;
    if (seen.has(normalized)) {
      throw new Error("Duplicate variant names are not allowed for the same item.");
    }
    seen.add(normalized);
  }
};

const ensureCategoryExists = async (tenantDB, categoryId) => {
  const exists = await tenantDB.query("SELECT id FROM menu_categories WHERE id = $1 LIMIT 1", [
    categoryId,
  ]);
  return exists.rowCount > 0;
};

const createMenuCategory = async (req, res) => {
  const { name } = req.body || {};
  if (!name?.trim()) return res.status(400).json({ message: "Category name is required." });

  try {
    const created = await req.tenantDB.query(
      `
      INSERT INTO menu_categories (id, name)
      VALUES ($1, $2)
      RETURNING id, name, created_at, updated_at
      `,
      [randomUUID(), name.trim()]
    );
    return res.status(201).json({ message: "Menu category created.", data: created.rows[0] });
  } catch (error) {
    if (isUniqueViolation(error)) {
      return res.status(409).json({ message: "Category already exists." });
    }
    logError("POST /api/menu/categories", error);
    return res.status(500).json({ message: "Failed to create menu category." });
  }
};

const listMenuCategories = async (req, res) => {
  try {
    const params = parseListParams(req.query, { defaultSortBy: "name", defaultOrder: "ASC" });
    const { sortBy, order } = pickSort(params, ["name", "created_at", "updated_at"], "name");
    const where = params.search ? "WHERE name ILIKE $1" : "";
    const countArgs = params.search ? [`%${params.search}%`] : [];

    const totalResult = await req.tenantDB.query(
      `SELECT COUNT(*)::int AS total FROM menu_categories ${where}`,
      countArgs
    );
    const total = totalResult.rows[0]?.total ?? 0;

    const dataArgs = params.search
      ? [`%${params.search}%`, params.limit, params.offset]
      : [params.limit, params.offset];

    const result = await req.tenantDB.query(
      `
      SELECT id, name, created_at, updated_at
      FROM menu_categories
      ${where}
      ORDER BY ${sortBy} ${order}
      LIMIT $${params.search ? 2 : 1} OFFSET $${params.search ? 3 : 2}
      `,
      dataArgs
    );

    return res.status(200).json({
      data: result.rows,
      pagination: buildPagination({ total, page: params.page, limit: params.limit }),
    });
  } catch (error) {
    logError("GET /api/menu/categories", error);
    return res.status(500).json({ message: "Failed to fetch menu categories." });
  }
};

const updateMenuCategory = async (req, res) => {
  const { id } = req.params;
  const { name } = req.body || {};
  if (!name?.trim()) return res.status(400).json({ message: "Category name is required." });

  try {
    const existing = await req.tenantDB.query(
      "SELECT id FROM menu_categories WHERE id = $1 LIMIT 1",
      [id]
    );
    if (existing.rowCount === 0) return res.status(404).json({ message: "Category not found." });

    const updated = await req.tenantDB.query(
      `
      UPDATE menu_categories
      SET name = $1,
          updated_at = NOW()
      WHERE id = $2
      RETURNING id, name, created_at, updated_at
      `,
      [name.trim(), id]
    );

    return res.status(200).json({ message: "Menu category updated.", data: updated.rows[0] });
  } catch (error) {
    if (isUniqueViolation(error)) {
      return res.status(409).json({ message: "Category already exists." });
    }
    logError("PUT /api/menu/categories/:id", error);
    return res.status(500).json({ message: "Failed to update menu category." });
  }
};

const deleteMenuCategory = async (req, res) => {
  const { id } = req.params;

  try {
    const existing = await req.tenantDB.query(
      "SELECT id FROM menu_categories WHERE id = $1 LIMIT 1",
      [id]
    );
    if (existing.rowCount === 0) return res.status(404).json({ message: "Category not found." });

    const used = await req.tenantDB.query("SELECT 1 FROM menu_items WHERE category_id = $1 LIMIT 1", [
      id,
    ]);
    if (used.rowCount > 0) {
      return res
        .status(400)
        .json({ message: "Cannot delete category, it is linked with menu items" });
    }

    await req.tenantDB.query("DELETE FROM menu_categories WHERE id = $1", [id]);
    return res.status(200).json({ message: "Menu category deleted." });
  } catch (error) {
    logError("DELETE /api/menu/categories/:id", error);
    return res.status(500).json({ message: "Failed to delete menu category." });
  }
};

const createMenuItem = async (req, res) => {
  const { name, category_id, image_url, is_veg, is_active, variants } = req.body || {};

  if (!name?.trim()) return res.status(400).json({ message: "Item name is required." });
  if (!category_id?.trim()) return res.status(400).json({ message: "Category is required." });

  const providedVariants = Array.isArray(variants) ? variants : [];
  const finalVariants =
    providedVariants.length > 0 ? providedVariants : [{ name: "Regular", price: 0 }];

  try {
    const catOk = await ensureCategoryExists(req.tenantDB, category_id);
    if (!catOk) return res.status(400).json({ message: "Selected category does not exist." });

    try {
      validateUniqueVariantNames(finalVariants);
    } catch (validationError) {
      return res.status(400).json({ message: validationError.message });
    }

    await req.tenantDB.query("BEGIN");

    const itemId = randomUUID();
    const insertedItem = await req.tenantDB.query(
      `
      INSERT INTO menu_items (id, name, category_id, image_url, is_veg, is_active)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id, name, category_id, image_url, is_veg, is_active, created_at, updated_at
      `,
      [
        itemId,
        name.trim(),
        category_id,
        image_url?.trim() || null,
        is_veg === undefined ? true : Boolean(is_veg),
        is_active === undefined ? true : Boolean(is_active),
      ]
    );

    const variantRows = [];
    for (const v of finalVariants) {
      const vName = String(v?.name || "").trim();
      if (!vName) throw new Error("Variant name is required.");
      const vPrice = parseNonNegativeNumber(v?.price ?? 0, "Variant price");

      const vr = await req.tenantDB.query(
        `
        INSERT INTO menu_item_variants (id, item_id, name, price)
        VALUES ($1, $2, $3, $4)
        RETURNING id, item_id, name, price, created_at, updated_at
        `,
        [randomUUID(), itemId, vName, vPrice]
      );
      variantRows.push(vr.rows[0]);
    }

    await req.tenantDB.query("COMMIT");

    return res.status(201).json({
      message: "Menu item created.",
      data: { ...insertedItem.rows[0], variants: variantRows },
    });
  } catch (error) {
    try {
      await req.tenantDB.query("ROLLBACK");
    } catch (_) {}

    logError("POST /api/menu/items", error);
    return res.status(500).json({ message: error?.message || "Failed to create menu item." });
  }
};

const listMenuItems = async (req, res) => {
  try {
    const params = parseListParams(req.query, { defaultSortBy: "created_at", defaultOrder: "DESC" });
    const { sortBy, order } = pickSort(params, ["created_at", "name"], "created_at");
    const where = params.search ? "WHERE i.name ILIKE $1" : "";
    const countArgs = params.search ? [`%${params.search}%`] : [];

    const totalResult = await req.tenantDB.query(
      `SELECT COUNT(*)::int AS total FROM menu_items i ${where}`,
      countArgs
    );
    const total = totalResult.rows[0]?.total ?? 0;

    // page items first, then join variants/categories for those ids
    const pageArgs = params.search
      ? [`%${params.search}%`, params.limit, params.offset]
      : [params.limit, params.offset];

    const pageItems = await req.tenantDB.query(
      `
      SELECT i.id
      FROM menu_items i
      ${where}
      ORDER BY i.${sortBy} ${order}
      LIMIT $${params.search ? 2 : 1} OFFSET $${params.search ? 3 : 2}
      `,
      pageArgs
    );

    const ids = pageItems.rows.map((r) => r.id);
    if (ids.length === 0) {
      return res.status(200).json({
        data: [],
        pagination: buildPagination({ total, page: params.page, limit: params.limit }),
      });
    }

    const detail = await req.tenantDB.query(
      `
      SELECT
        i.id AS item_id,
        i.name AS item_name,
        i.category_id,
        c.name AS category_name,
        i.image_url,
        i.is_veg,
        i.is_active,
        i.created_at AS item_created_at,
        i.updated_at AS item_updated_at,
        v.id AS variant_id,
        v.name AS variant_name,
        v.price AS variant_price,
        v.created_at AS variant_created_at,
        v.updated_at AS variant_updated_at
      FROM menu_items i
      JOIN menu_categories c ON c.id = i.category_id
      LEFT JOIN menu_item_variants v ON v.item_id = i.id
      WHERE i.id = ANY($1)
      ORDER BY i.${sortBy} ${order}, v.created_at ASC
      `,
      [ids]
    );

    const byId = new Map();
    for (const row of detail.rows) {
      if (!byId.has(row.item_id)) {
        byId.set(row.item_id, {
          id: row.item_id,
          name: row.item_name,
          category_id: row.category_id,
          category_name: row.category_name,
          image_url: row.image_url,
          is_veg: row.is_veg,
          is_active: row.is_active,
          created_at: row.item_created_at,
          updated_at: row.item_updated_at,
          variants: [],
        });
      }
      if (row.variant_id) {
        byId.get(row.item_id).variants.push({
          id: row.variant_id,
          item_id: row.item_id,
          name: row.variant_name,
          price: row.variant_price,
          created_at: row.variant_created_at,
          updated_at: row.variant_updated_at,
        });
      }
    }

    // keep same order as ids
    const data = ids.map((id) => byId.get(id)).filter(Boolean);

    return res.status(200).json({
      data,
      pagination: buildPagination({ total, page: params.page, limit: params.limit }),
    });
  } catch (error) {
    logError("GET /api/menu/items", error);
    return res.status(500).json({ message: "Failed to fetch menu items." });
  }
};

const updateMenuItem = async (req, res) => {
  const { id } = req.params;
  const { name, category_id, image_url, is_veg, is_active, variants } = req.body || {};

  if (!name?.trim()) return res.status(400).json({ message: "Item name is required." });
  if (!category_id?.trim()) return res.status(400).json({ message: "Category is required." });

  const providedVariants = Array.isArray(variants) ? variants : [];
  const finalVariants =
    providedVariants.length > 0 ? providedVariants : [{ name: "Regular", price: 0 }];

  try {
    const itemExists = await req.tenantDB.query("SELECT id FROM menu_items WHERE id = $1 LIMIT 1", [
      id,
    ]);
    if (itemExists.rowCount === 0) return res.status(404).json({ message: "Item not found." });

    const catOk = await ensureCategoryExists(req.tenantDB, category_id);
    if (!catOk) return res.status(400).json({ message: "Selected category does not exist." });

    try {
      validateUniqueVariantNames(finalVariants);
    } catch (validationError) {
      return res.status(400).json({ message: validationError.message });
    }

    await req.tenantDB.query("BEGIN");

    const updatedItem = await req.tenantDB.query(
      `
      UPDATE menu_items
      SET name = $1,
          category_id = $2,
          image_url = $3,
          is_veg = $4,
          is_active = $5,
          updated_at = NOW()
      WHERE id = $6
      RETURNING id, name, category_id, image_url, is_veg, is_active, created_at, updated_at
      `,
      [
        name.trim(),
        category_id,
        image_url?.trim() || null,
        Boolean(is_veg),
        Boolean(is_active),
        id,
      ]
    );

    const existingVariants = await req.tenantDB.query(
      "SELECT id FROM menu_item_variants WHERE item_id = $1",
      [id]
    );
    const existingIds = new Set(existingVariants.rows.map((r) => r.id));
    const keepIds = new Set();
    const outVariants = [];

    for (const v of finalVariants) {
      const vId = v?.id ? String(v.id) : null;
      const vName = String(v?.name || "").trim();
      if (!vName) throw new Error("Variant name is required.");
      const vPrice = parseNonNegativeNumber(v?.price ?? 0, "Variant price");

      if (vId && existingIds.has(vId)) {
        keepIds.add(vId);
        const up = await req.tenantDB.query(
          `
          UPDATE menu_item_variants
          SET name = $1,
              price = $2,
              updated_at = NOW()
          WHERE id = $3 AND item_id = $4
          RETURNING id, item_id, name, price, created_at, updated_at
          `,
          [vName, vPrice, vId, id]
        );
        outVariants.push(up.rows[0]);
      } else {
        const ins = await req.tenantDB.query(
          `
          INSERT INTO menu_item_variants (id, item_id, name, price)
          VALUES ($1, $2, $3, $4)
          RETURNING id, item_id, name, price, created_at, updated_at
          `,
          [randomUUID(), id, vName, vPrice]
        );
        outVariants.push(ins.rows[0]);
      }
    }

    const toDelete = [...existingIds].filter((x) => !keepIds.has(x));
    if (toDelete.length > 0) {
      await req.tenantDB.query("DELETE FROM menu_item_variants WHERE item_id = $1 AND id = ANY($2)", [
        id,
        toDelete,
      ]);
    }

    await req.tenantDB.query("COMMIT");

    return res.status(200).json({
      message: "Menu item updated.",
      data: { ...updatedItem.rows[0], variants: outVariants },
    });
  } catch (error) {
    try {
      await req.tenantDB.query("ROLLBACK");
    } catch (_) {}
    logError("PUT /api/menu/items/:id", error);
    return res.status(500).json({ message: error?.message || "Failed to update menu item." });
  }
};

const deleteMenuItem = async (req, res) => {
  const { id } = req.params;
  try {
    const existing = await req.tenantDB.query("SELECT id FROM menu_items WHERE id = $1 LIMIT 1", [
      id,
    ]);
    if (existing.rowCount === 0) return res.status(404).json({ message: "Item not found." });

    await req.tenantDB.query("DELETE FROM menu_items WHERE id = $1", [id]);
    return res.status(200).json({ message: "Menu item deleted." });
  } catch (error) {
    logError("DELETE /api/menu/items/:id", error);
    return res.status(500).json({ message: "Failed to delete menu item." });
  }
};

module.exports = {
  createMenuCategory,
  listMenuCategories,
  updateMenuCategory,
  deleteMenuCategory,
  createMenuItem,
  listMenuItems,
  updateMenuItem,
  deleteMenuItem,
};

