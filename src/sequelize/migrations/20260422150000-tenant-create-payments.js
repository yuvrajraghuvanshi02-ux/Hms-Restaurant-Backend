"use strict";

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      CREATE TABLE IF NOT EXISTS payments (
        id UUID PRIMARY KEY,
        order_id UUID NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
        total_amount NUMERIC NOT NULL,
        paid_amount NUMERIC NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await queryInterface.sequelize.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_indexes WHERE indexname = 'ux_payments_order_id'
        ) THEN
          CREATE UNIQUE INDEX ux_payments_order_id ON payments (order_id);
        END IF;
      END $$;
    `);

    await queryInterface.sequelize.query(`
      CREATE TABLE IF NOT EXISTS payment_items (
        id UUID PRIMARY KEY,
        payment_id UUID NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
        mode VARCHAR(20) NOT NULL CHECK (mode IN ('cash', 'upi', 'card')),
        amount NUMERIC NOT NULL,
        metadata JSONB NULL
      );
    `);

    await queryInterface.sequelize.query(`
      CREATE INDEX IF NOT EXISTS idx_payment_items_payment_id
      ON payment_items (payment_id);
    `);

    await queryInterface.sequelize.query(`
      CREATE INDEX IF NOT EXISTS idx_payment_items_mode
      ON payment_items (mode);
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`DROP TABLE IF EXISTS payment_items;`);
    await queryInterface.sequelize.query(`DROP TABLE IF EXISTS payments;`);
  },
};

