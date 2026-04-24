"use strict";

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TABLE orders
      ADD COLUMN IF NOT EXISTS discount_amount NUMERIC NOT NULL DEFAULT 0;
    `);

    await queryInterface.sequelize.query(`
      ALTER TABLE orders
      ADD COLUMN IF NOT EXISTS tip_amount NUMERIC NOT NULL DEFAULT 0;
    `);

    await queryInterface.sequelize.query(`
      CREATE INDEX IF NOT EXISTS idx_orders_discount_amount
      ON orders (discount_amount DESC);
    `);

    await queryInterface.sequelize.query(`
      CREATE INDEX IF NOT EXISTS idx_orders_tip_amount
      ON orders (tip_amount DESC);
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`DROP INDEX IF EXISTS idx_orders_tip_amount;`);
    await queryInterface.sequelize.query(`DROP INDEX IF EXISTS idx_orders_discount_amount;`);
    await queryInterface.sequelize.query(`
      ALTER TABLE orders
      DROP COLUMN IF EXISTS tip_amount;
    `);
    await queryInterface.sequelize.query(`
      ALTER TABLE orders
      DROP COLUMN IF EXISTS discount_amount;
    `);
  },
};

