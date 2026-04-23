"use strict";

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TABLE orders
      ADD COLUMN IF NOT EXISTS payment_status VARCHAR(20) NOT NULL DEFAULT 'unpaid'
      CHECK (payment_status IN ('unpaid', 'paid'));
    `);

    await queryInterface.sequelize.query(`
      CREATE INDEX IF NOT EXISTS idx_orders_payment_status
      ON orders (payment_status);
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`DROP INDEX IF EXISTS idx_orders_payment_status;`);
    await queryInterface.sequelize.query(`
      ALTER TABLE orders
      DROP COLUMN IF EXISTS payment_status;
    `);
  },
};

