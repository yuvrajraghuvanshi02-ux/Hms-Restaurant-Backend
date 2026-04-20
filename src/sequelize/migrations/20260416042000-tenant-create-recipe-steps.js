"use strict";

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      CREATE TABLE IF NOT EXISTS recipe_steps (
        id UUID PRIMARY KEY,
        menu_item_variant_id UUID NOT NULL REFERENCES menu_item_variants(id) ON DELETE CASCADE,
        step_title VARCHAR(200) NOT NULL,
        step_description TEXT,
        step_order INTEGER NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await queryInterface.sequelize.query(`
      CREATE INDEX IF NOT EXISTS idx_recipe_steps_variant
      ON recipe_steps (menu_item_variant_id);
    `);

    await queryInterface.sequelize.query(`
      CREATE INDEX IF NOT EXISTS idx_recipe_steps_variant_order
      ON recipe_steps (menu_item_variant_id, step_order);
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`DROP TABLE IF EXISTS recipe_steps;`);
  },
};

