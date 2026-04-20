"use strict";

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      CREATE TABLE IF NOT EXISTS recipe_items (
        id UUID PRIMARY KEY,
        menu_item_variant_id UUID NOT NULL REFERENCES menu_item_variants(id) ON DELETE CASCADE,
        raw_material_id UUID NOT NULL REFERENCES raw_materials(id) ON DELETE RESTRICT,
        quantity NUMERIC(14,3) NOT NULL,
        unit_id UUID NOT NULL REFERENCES units(id) ON DELETE RESTRICT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT ux_recipe_items_variant_raw UNIQUE (menu_item_variant_id, raw_material_id)
      );
    `);

    await queryInterface.sequelize.query(`
      CREATE INDEX IF NOT EXISTS idx_recipe_items_variant
      ON recipe_items (menu_item_variant_id);
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`DROP TABLE IF EXISTS recipe_items;`);
  },
};

