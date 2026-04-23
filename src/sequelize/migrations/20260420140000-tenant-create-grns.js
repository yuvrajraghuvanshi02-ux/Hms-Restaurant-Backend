"use strict";

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      CREATE TABLE IF NOT EXISTS grns (
        id UUID PRIMARY KEY,
        purchase_order_id UUID NOT NULL REFERENCES purchase_orders(id) ON DELETE RESTRICT,
        grn_number VARCHAR(32) NOT NULL,
        received_date DATE NOT NULL,
        remarks TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await queryInterface.sequelize.query(`
      CREATE TABLE IF NOT EXISTS grn_items (
        id UUID PRIMARY KEY,
        grn_id UUID NOT NULL REFERENCES grns(id) ON DELETE CASCADE,
        raw_material_id UUID NOT NULL REFERENCES raw_materials(id) ON DELETE RESTRICT,
        ordered_quantity NUMERIC NOT NULL,
        received_quantity NUMERIC NOT NULL,
        unit_id UUID NOT NULL REFERENCES units(id) ON DELETE RESTRICT
      );
    `);

    await queryInterface.sequelize.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_indexes WHERE indexname = 'ux_grns_grn_number'
        ) THEN
          CREATE UNIQUE INDEX ux_grns_grn_number
          ON grns (grn_number);
        END IF;
      END $$;
    `);

    await queryInterface.sequelize.query(`
      CREATE INDEX IF NOT EXISTS idx_grns_received_date
      ON grns (received_date DESC);
    `);

    await queryInterface.sequelize.query(`
      CREATE INDEX IF NOT EXISTS idx_grns_purchase_order_id
      ON grns (purchase_order_id);
    `);

    await queryInterface.sequelize.query(`
      CREATE INDEX IF NOT EXISTS idx_grn_items_grn_id
      ON grn_items (grn_id);
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`DROP TABLE IF EXISTS grn_items;`);
    await queryInterface.sequelize.query(`DROP TABLE IF EXISTS grns;`);
  },
};

