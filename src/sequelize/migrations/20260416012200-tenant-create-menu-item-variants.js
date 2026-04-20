"use strict";

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      CREATE TABLE IF NOT EXISTS menu_item_variants (
        id UUID PRIMARY KEY,
        item_id UUID NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
        name VARCHAR(120) NOT NULL,
        price NUMERIC(14,3) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await queryInterface.sequelize.query(`
      CREATE INDEX IF NOT EXISTS idx_menu_item_variants_item_id
      ON menu_item_variants (item_id);
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`DROP TABLE IF EXISTS menu_item_variants;`);
  },
};

