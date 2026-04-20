"use strict";

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      CREATE TABLE IF NOT EXISTS suppliers (
        id UUID PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        phone VARCHAR(40),
        email VARCHAR(255),
        gst_number VARCHAR(64),
        contact_person VARCHAR(180),
        address TEXT,
        city VARCHAR(120),
        state VARCHAR(120),
        upi_id VARCHAR(120),
        bank_name VARCHAR(180),
        bank_ifsc VARCHAR(20),
        bank_account_number VARCHAR(34),
        is_active BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await queryInterface.sequelize.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_indexes WHERE indexname = 'ux_suppliers_name_lower'
        ) THEN
          CREATE UNIQUE INDEX ux_suppliers_name_lower
          ON suppliers ((lower(btrim(name::text))));
        END IF;
      END $$;
    `);

    await queryInterface.sequelize.query(`
      CREATE INDEX IF NOT EXISTS idx_suppliers_created_at ON suppliers (created_at DESC);
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`DROP TABLE IF EXISTS suppliers;`);
  },
};
