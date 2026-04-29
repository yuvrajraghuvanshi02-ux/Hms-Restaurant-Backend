"use strict";

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      CREATE TABLE IF NOT EXISTS order_adjustments (
        id UUID PRIMARY KEY,
        order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
        order_item_id UUID NULL REFERENCES order_items(id) ON DELETE SET NULL,
        type VARCHAR(40) NOT NULL CHECK (type IN ('cancel_before_served', 'void_after_served', 'replacement')),
        reason TEXT NULL,
        quantity NUMERIC NOT NULL DEFAULT 0,
        amount_impact NUMERIC NOT NULL DEFAULT 0,
        cost_impact NUMERIC NOT NULL DEFAULT 0,
        created_by TEXT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await queryInterface.sequelize.query(`
      CREATE INDEX IF NOT EXISTS idx_order_adjustments_order_id
      ON order_adjustments (order_id, created_at DESC);
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`DROP TABLE IF EXISTS order_adjustments;`);
  },
};

