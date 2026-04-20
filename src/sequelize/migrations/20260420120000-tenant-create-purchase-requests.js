"use strict";

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      CREATE TABLE IF NOT EXISTS purchase_requests (
        id UUID PRIMARY KEY,
        supplier_id UUID NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
        request_number VARCHAR(32) NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'approved', 'rejected')),
        remarks TEXT,
        created_by UUID REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await queryInterface.sequelize.query(`
      CREATE TABLE IF NOT EXISTS purchase_request_items (
        id UUID PRIMARY KEY,
        purchase_request_id UUID NOT NULL REFERENCES purchase_requests(id) ON DELETE CASCADE,
        raw_material_id UUID NOT NULL REFERENCES raw_materials(id) ON DELETE RESTRICT,
        quantity NUMERIC NOT NULL,
        unit_id UUID NOT NULL REFERENCES units(id) ON DELETE RESTRICT
      );
    `);

    await queryInterface.sequelize.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_indexes WHERE indexname = 'ux_purchase_requests_request_number'
        ) THEN
          CREATE UNIQUE INDEX ux_purchase_requests_request_number
          ON purchase_requests (request_number);
        END IF;
      END $$;
    `);

    await queryInterface.sequelize.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_indexes WHERE indexname = 'ux_purchase_request_items_request_raw_material'
        ) THEN
          CREATE UNIQUE INDEX ux_purchase_request_items_request_raw_material
          ON purchase_request_items (purchase_request_id, raw_material_id);
        END IF;
      END $$;
    `);

    await queryInterface.sequelize.query(`
      CREATE INDEX IF NOT EXISTS idx_purchase_requests_created_at
      ON purchase_requests (created_at DESC);
    `);

    await queryInterface.sequelize.query(`
      CREATE INDEX IF NOT EXISTS idx_purchase_requests_supplier_id
      ON purchase_requests (supplier_id);
    `);

    await queryInterface.sequelize.query(`
      CREATE INDEX IF NOT EXISTS idx_purchase_request_items_request_id
      ON purchase_request_items (purchase_request_id);
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`DROP TABLE IF EXISTS purchase_request_items;`);
    await queryInterface.sequelize.query(`DROP TABLE IF EXISTS purchase_requests;`);
  },
};

