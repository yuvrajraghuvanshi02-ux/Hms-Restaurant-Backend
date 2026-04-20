"use strict";

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TABLE raw_materials
      ADD COLUMN IF NOT EXISTS category VARCHAR(80),
      ADD COLUMN IF NOT EXISTS purchase_unit_id UUID REFERENCES units(id) ON DELETE RESTRICT,
      ADD COLUMN IF NOT EXISTS consumption_unit_id UUID REFERENCES units(id) ON DELETE RESTRICT,
      ADD COLUMN IF NOT EXISTS purchase_price NUMERIC(14,3) NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS transfer_price NUMERIC(14,3) NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS reconciliation_price NUMERIC(14,3) NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS normal_loss_percent NUMERIC(6,3) NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS gst_percent NUMERIC(6,3) NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS min_stock_level NUMERIC(14,3) NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS closing_stock_type VARCHAR(20) NOT NULL DEFAULT 'monthly',
      ADD COLUMN IF NOT EXISTS is_expiry BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS auto_hide_on_low_stock BOOLEAN NOT NULL DEFAULT FALSE;
    `);

    await queryInterface.sequelize.query(`
      UPDATE raw_materials
      SET purchase_unit_id = COALESCE(purchase_unit_id, unit_id),
          consumption_unit_id = COALESCE(consumption_unit_id, unit_id),
          min_stock_level = COALESCE(min_stock_level, COALESCE(min_stock, 0)),
          closing_stock_type = COALESCE(closing_stock_type, 'monthly');
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TABLE raw_materials
      DROP COLUMN IF EXISTS auto_hide_on_low_stock,
      DROP COLUMN IF EXISTS is_expiry,
      DROP COLUMN IF EXISTS closing_stock_type,
      DROP COLUMN IF EXISTS min_stock_level,
      DROP COLUMN IF EXISTS gst_percent,
      DROP COLUMN IF EXISTS normal_loss_percent,
      DROP COLUMN IF EXISTS reconciliation_price,
      DROP COLUMN IF EXISTS transfer_price,
      DROP COLUMN IF EXISTS purchase_price,
      DROP COLUMN IF EXISTS consumption_unit_id,
      DROP COLUMN IF EXISTS purchase_unit_id,
      DROP COLUMN IF EXISTS category;
    `);
  },
};

