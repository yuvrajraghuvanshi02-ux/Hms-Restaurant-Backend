"use strict";

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      CREATE TABLE IF NOT EXISTS purchase_orders (
        id UUID PRIMARY KEY,
        purchase_request_id UUID NOT NULL REFERENCES purchase_requests(id) ON DELETE RESTRICT,
        supplier_id UUID NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
        po_number VARCHAR(32) NOT NULL,
        status VARCHAR(32) NOT NULL DEFAULT 'created'
          CHECK (status IN ('created', 'sent', 'partially_received', 'completed')),
        remarks TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await queryInterface.sequelize.query(`
      CREATE TABLE IF NOT EXISTS purchase_order_items (
        id UUID PRIMARY KEY,
        purchase_order_id UUID NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
        raw_material_id UUID NOT NULL REFERENCES raw_materials(id) ON DELETE RESTRICT,
        ordered_quantity NUMERIC NOT NULL,
        received_quantity NUMERIC NOT NULL DEFAULT 0,
        unit_id UUID NOT NULL REFERENCES units(id) ON DELETE RESTRICT
      );
    `);

    await queryInterface.sequelize.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_indexes WHERE indexname = 'ux_purchase_orders_po_number'
        ) THEN
          CREATE UNIQUE INDEX ux_purchase_orders_po_number
          ON purchase_orders (po_number);
        END IF;
      END $$;
    `);

    await queryInterface.sequelize.query(`
      CREATE INDEX IF NOT EXISTS idx_purchase_orders_created_at
      ON purchase_orders (created_at DESC);
    `);

    await queryInterface.sequelize.query(`
      CREATE INDEX IF NOT EXISTS idx_purchase_orders_supplier_id
      ON purchase_orders (supplier_id);
    `);

    await queryInterface.sequelize.query(`
      CREATE INDEX IF NOT EXISTS idx_purchase_orders_purchase_request_id
      ON purchase_orders (purchase_request_id);
    `);

    await queryInterface.sequelize.query(`
      CREATE INDEX IF NOT EXISTS idx_purchase_order_items_po_id
      ON purchase_order_items (purchase_order_id);
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`DROP TABLE IF EXISTS purchase_order_items;`);
    await queryInterface.sequelize.query(`DROP TABLE IF EXISTS purchase_orders;`);
  },
};

