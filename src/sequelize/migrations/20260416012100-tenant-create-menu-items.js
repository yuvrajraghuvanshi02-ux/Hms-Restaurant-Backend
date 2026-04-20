"use strict";

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      CREATE TABLE IF NOT EXISTS menu_items (
        id UUID PRIMARY KEY,
        name VARCHAR(180) NOT NULL,
        category_id UUID NOT NULL REFERENCES menu_categories(id) ON DELETE RESTRICT,
        image_url TEXT,
        is_veg BOOLEAN NOT NULL DEFAULT TRUE,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await queryInterface.sequelize.query(`
      CREATE INDEX IF NOT EXISTS idx_menu_items_category_id
      ON menu_items (category_id);
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`DROP TABLE IF EXISTS menu_items;`);
  },
};

