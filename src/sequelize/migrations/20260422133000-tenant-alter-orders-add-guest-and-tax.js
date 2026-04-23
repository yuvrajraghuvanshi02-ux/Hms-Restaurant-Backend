"use strict";

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TABLE orders
        ADD COLUMN IF NOT EXISTS guest_name VARCHAR(160) NULL,
        ADD COLUMN IF NOT EXISTS guest_phone VARCHAR(40) NULL,
        ADD COLUMN IF NOT EXISTS guest_address TEXT NULL,
        ADD COLUMN IF NOT EXISTS tax_percentage NUMERIC NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS tax_amount NUMERIC NOT NULL DEFAULT 0;
    `);

    await queryInterface.sequelize.query(`
      CREATE INDEX IF NOT EXISTS idx_orders_guest_phone
      ON orders (guest_phone);
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`DROP INDEX IF EXISTS idx_orders_guest_phone;`);
    await queryInterface.sequelize.query(`
      ALTER TABLE orders
        DROP COLUMN IF EXISTS guest_name,
        DROP COLUMN IF EXISTS guest_phone,
        DROP COLUMN IF EXISTS guest_address,
        DROP COLUMN IF EXISTS tax_percentage,
        DROP COLUMN IF EXISTS tax_amount;
    `);
  },
};

