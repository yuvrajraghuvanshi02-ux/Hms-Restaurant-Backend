"use strict";

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      CREATE TABLE IF NOT EXISTS taxes (
        id UUID PRIMARY KEY,
        name VARCHAR(80) NOT NULL,
        percentage NUMERIC NOT NULL DEFAULT 0,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
      );
    `);

    await queryInterface.sequelize.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS ux_taxes_name
      ON taxes (LOWER(name));
    `);

    await queryInterface.sequelize.query(`
      ALTER TABLE orders
        ADD COLUMN IF NOT EXISTS selected_tax_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
        ADD COLUMN IF NOT EXISTS tax_breakup JSONB NOT NULL DEFAULT '{}'::jsonb,
        ADD COLUMN IF NOT EXISTS total_tax_amount NUMERIC NOT NULL DEFAULT 0;
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TABLE orders
        DROP COLUMN IF EXISTS selected_tax_ids,
        DROP COLUMN IF EXISTS tax_breakup,
        DROP COLUMN IF EXISTS total_tax_amount;
    `);
    await queryInterface.sequelize.query(`DROP INDEX IF EXISTS ux_taxes_name;`);
    await queryInterface.sequelize.query(`DROP TABLE IF EXISTS taxes;`);
  },
};

