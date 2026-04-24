"use strict";

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TABLE orders
      ADD COLUMN IF NOT EXISTS served_at TIMESTAMPTZ NULL;
    `);

    await queryInterface.sequelize.query(`
      ALTER TABLE orders
      ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ NULL;
    `);

    await queryInterface.sequelize.query(`
      CREATE INDEX IF NOT EXISTS idx_orders_served_at
      ON orders (served_at DESC);
    `);

    await queryInterface.sequelize.query(`
      CREATE INDEX IF NOT EXISTS idx_orders_completed_at
      ON orders (completed_at DESC);
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`DROP INDEX IF EXISTS idx_orders_completed_at;`);
    await queryInterface.sequelize.query(`DROP INDEX IF EXISTS idx_orders_served_at;`);
    await queryInterface.sequelize.query(`
      ALTER TABLE orders
      DROP COLUMN IF EXISTS completed_at;
    `);
    await queryInterface.sequelize.query(`
      ALTER TABLE orders
      DROP COLUMN IF EXISTS served_at;
    `);
  },
};

