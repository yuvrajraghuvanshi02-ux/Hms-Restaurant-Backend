"use strict";

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      CREATE TABLE IF NOT EXISTS orders (
        id UUID PRIMARY KEY,
        order_number VARCHAR(32) NOT NULL,
        order_type VARCHAR(20) NOT NULL DEFAULT 'dine_in'
          CHECK (order_type IN ('dine_in', 'takeaway', 'delivery')),
        status VARCHAR(20) NOT NULL DEFAULT 'created'
          CHECK (status IN ('created', 'kot_sent', 'preparing', 'ready', 'served', 'completed', 'cancelled')),
        table_id UUID REFERENCES tables(id) ON DELETE SET NULL,
        total_amount NUMERIC NOT NULL DEFAULT 0,
        total_cost NUMERIC NOT NULL DEFAULT 0,
        total_profit NUMERIC NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await queryInterface.sequelize.query(`
      CREATE TABLE IF NOT EXISTS order_items (
        id UUID PRIMARY KEY,
        order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
        variant_id UUID NOT NULL REFERENCES menu_item_variants(id) ON DELETE RESTRICT,
        quantity NUMERIC NOT NULL,
        price NUMERIC NOT NULL,
        total_price NUMERIC NOT NULL,
        cost_price NUMERIC NOT NULL DEFAULT 0,
        profit NUMERIC NOT NULL DEFAULT 0
      );
    `);

    await queryInterface.sequelize.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_indexes WHERE indexname = 'ux_orders_order_number'
        ) THEN
          CREATE UNIQUE INDEX ux_orders_order_number
          ON orders (order_number);
        END IF;
      END $$;
    `);

    await queryInterface.sequelize.query(`
      CREATE INDEX IF NOT EXISTS idx_orders_created_at
      ON orders (created_at DESC);
    `);

    await queryInterface.sequelize.query(`
      CREATE INDEX IF NOT EXISTS idx_orders_status
      ON orders (status);
    `);

    await queryInterface.sequelize.query(`
      CREATE INDEX IF NOT EXISTS idx_orders_table_id
      ON orders (table_id);
    `);

    await queryInterface.sequelize.query(`
      CREATE INDEX IF NOT EXISTS idx_order_items_order_id
      ON order_items (order_id);
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`DROP TABLE IF EXISTS order_items;`);
    await queryInterface.sequelize.query(`DROP TABLE IF EXISTS orders;`);
  },
};

