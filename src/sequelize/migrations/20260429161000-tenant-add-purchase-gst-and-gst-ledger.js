"use strict";

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TABLE purchase_requests
        ADD COLUMN IF NOT EXISTS purchase_total NUMERIC NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS gst_percentage NUMERIC NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS gst_amount NUMERIC NOT NULL DEFAULT 0;
    `);

    await queryInterface.sequelize.query(`
      ALTER TABLE purchase_orders
        ADD COLUMN IF NOT EXISTS purchase_total NUMERIC NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS gst_percentage NUMERIC NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS gst_amount NUMERIC NOT NULL DEFAULT 0;
    `);

    await queryInterface.sequelize.query(`
      CREATE TABLE IF NOT EXISTS gst_ledger (
        id UUID PRIMARY KEY,
        type VARCHAR(20) NOT NULL CHECK (type IN ('input', 'output')),
        source VARCHAR(20) NOT NULL CHECK (source IN ('order', 'purchase')),
        source_id UUID NOT NULL,
        amount NUMERIC NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await queryInterface.sequelize.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS ux_gst_ledger_type_source_source_id
      ON gst_ledger (type, source, source_id);
    `);

    await queryInterface.sequelize.query(`
      CREATE INDEX IF NOT EXISTS idx_gst_ledger_created_at
      ON gst_ledger (created_at DESC);
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      DROP TABLE IF EXISTS gst_ledger;
    `);

    await queryInterface.sequelize.query(`
      ALTER TABLE purchase_orders
        DROP COLUMN IF EXISTS purchase_total,
        DROP COLUMN IF EXISTS gst_percentage,
        DROP COLUMN IF EXISTS gst_amount;
    `);

    await queryInterface.sequelize.query(`
      ALTER TABLE purchase_requests
        DROP COLUMN IF EXISTS purchase_total,
        DROP COLUMN IF EXISTS gst_percentage,
        DROP COLUMN IF EXISTS gst_amount;
    `);
  },
};
