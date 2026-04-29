"use strict";

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TABLE order_items
      ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'active'
      CHECK (status IN ('active', 'cancelled', 'voided', 'replaced'));
    `);

    // Backfill: existing voided items
    await queryInterface.sequelize.query(`
      UPDATE order_items
      SET status = 'voided'
      WHERE COALESCE(is_voided, FALSE) = TRUE
        AND status = 'active';
    `);

    await queryInterface.sequelize.query(`
      CREATE INDEX IF NOT EXISTS idx_order_items_status
      ON order_items (status);
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`DROP INDEX IF EXISTS idx_order_items_status;`);
    await queryInterface.sequelize.query(`
      ALTER TABLE order_items
      DROP COLUMN IF EXISTS status;
    `);
  },
};

