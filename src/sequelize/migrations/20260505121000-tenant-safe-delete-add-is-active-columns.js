"use strict";

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TABLE units
      ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;
    `);

    await queryInterface.sequelize.query(`
      ALTER TABLE raw_materials
      ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;
    `);

    await queryInterface.sequelize.query(`
      ALTER TABLE menu_categories
      ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;
    `);

    await queryInterface.sequelize.query(`
      ALTER TABLE raw_material_categories
      ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;
    `);

    await queryInterface.sequelize.query(`
      ALTER TABLE menu_item_variants
      ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;
    `);

    await queryInterface.sequelize.query(`
      ALTER TABLE recipe_items
      ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;
    `);

    await queryInterface.sequelize.query(`
      ALTER TABLE recipe_steps
      ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TABLE recipe_steps
      DROP COLUMN IF EXISTS is_active;
    `);

    await queryInterface.sequelize.query(`
      ALTER TABLE recipe_items
      DROP COLUMN IF EXISTS is_active;
    `);

    await queryInterface.sequelize.query(`
      ALTER TABLE menu_item_variants
      DROP COLUMN IF EXISTS is_active;
    `);

    await queryInterface.sequelize.query(`
      ALTER TABLE menu_categories
      DROP COLUMN IF EXISTS is_active;
    `);

    await queryInterface.sequelize.query(`
      ALTER TABLE raw_material_categories
      DROP COLUMN IF EXISTS is_active;
    `);

    await queryInterface.sequelize.query(`
      ALTER TABLE raw_materials
      DROP COLUMN IF EXISTS is_active;
    `);

    await queryInterface.sequelize.query(`
      ALTER TABLE units
      DROP COLUMN IF EXISTS is_active;
    `);
  },
};

