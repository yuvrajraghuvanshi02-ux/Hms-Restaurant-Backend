"use strict";

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TABLE order_items
      ADD COLUMN IF NOT EXISTS is_voided BOOLEAN NOT NULL DEFAULT FALSE;
    `);

    await queryInterface.sequelize.query(`
      ALTER TABLE order_items
      ADD COLUMN IF NOT EXISTS void_reason TEXT NULL;
    `);

    await queryInterface.sequelize.query(`
      ALTER TABLE order_items
      ADD COLUMN IF NOT EXISTS voided_at TIMESTAMPTZ NULL;
    `);

    await queryInterface.sequelize.query(`
      CREATE INDEX IF NOT EXISTS idx_order_items_is_voided
      ON order_items (is_voided);
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`DROP INDEX IF EXISTS idx_order_items_is_voided;`);
    await queryInterface.sequelize.query(`
      ALTER TABLE order_items
      DROP COLUMN IF EXISTS voided_at,
      DROP COLUMN IF EXISTS void_reason,
      DROP COLUMN IF EXISTS is_voided;
    `);
  },
};

