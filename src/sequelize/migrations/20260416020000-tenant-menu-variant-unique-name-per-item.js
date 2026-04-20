"use strict";

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS ux_menu_item_variants_item_lower_name
      ON menu_item_variants (item_id, lower(name));
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      DROP INDEX IF EXISTS ux_menu_item_variants_item_lower_name;
    `);
  },
};

