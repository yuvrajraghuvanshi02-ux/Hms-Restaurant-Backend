"use strict";

const { randomUUID } = require("crypto");

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TABLE taxes
        ADD COLUMN IF NOT EXISTS is_system BOOLEAN NOT NULL DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS is_mandatory BOOLEAN NOT NULL DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS tax_code VARCHAR(20);
    `);

    await queryInterface.sequelize.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS ux_taxes_tax_code
      ON taxes (UPPER(tax_code))
      WHERE tax_code IS NOT NULL;
    `);

    await queryInterface.sequelize.query(`
      ALTER TABLE purchase_requests
        ADD COLUMN IF NOT EXISTS tax_breakup JSONB NOT NULL DEFAULT '{}'::jsonb;
    `);

    await queryInterface.sequelize.query(`
      ALTER TABLE purchase_orders
        ADD COLUMN IF NOT EXISTS tax_breakup JSONB NOT NULL DEFAULT '{}'::jsonb;
    `);

    const systemTaxes = [
      { code: "CGST", name: "CGST", percentage: 9 },
      { code: "SGST", name: "SGST", percentage: 9 },
    ];

    for (const tax of systemTaxes) {
      const existingByCode = await queryInterface.sequelize.query(
        `
        SELECT id FROM taxes WHERE UPPER(tax_code) = UPPER($1) LIMIT 1
        `,
        { bind: [tax.code] }
      );
      if (existingByCode[0]?.length > 0) {
        await queryInterface.sequelize.query(
          `
          UPDATE taxes
          SET name = $1,
              is_system = TRUE,
              is_mandatory = TRUE,
              is_default = TRUE,
              is_active = TRUE,
              tax_code = $2,
              updated_at = NOW()
          WHERE id = $3
          `,
          { bind: [tax.name, tax.code, existingByCode[0][0].id] }
        );
        continue;
      }

      const existingByName = await queryInterface.sequelize.query(
        `
        SELECT id FROM taxes WHERE LOWER(name) = LOWER($1) LIMIT 1
        `,
        { bind: [tax.name] }
      );
      if (existingByName[0]?.length > 0) {
        await queryInterface.sequelize.query(
          `
          UPDATE taxes
          SET tax_code = $1,
              is_system = TRUE,
              is_mandatory = TRUE,
              is_default = TRUE,
              is_active = TRUE,
              updated_at = NOW()
          WHERE id = $2
          `,
          { bind: [tax.code, existingByName[0][0].id] }
        );
        continue;
      }

      await queryInterface.sequelize.query(
        `
        INSERT INTO taxes (
          id, name, percentage, is_active,
          is_system, is_mandatory, is_default, tax_code,
          created_at, updated_at
        )
        VALUES ($1, $2, $3, TRUE, TRUE, TRUE, TRUE, $4, NOW(), NOW())
        `,
        { bind: [randomUUID(), tax.name, tax.percentage, tax.code] }
      );
    }
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      DELETE FROM taxes WHERE is_system = TRUE AND UPPER(tax_code) IN ('CGST', 'SGST');
    `);

    await queryInterface.sequelize.query(`
      ALTER TABLE purchase_orders DROP COLUMN IF EXISTS tax_breakup;
    `);
    await queryInterface.sequelize.query(`
      ALTER TABLE purchase_requests DROP COLUMN IF EXISTS tax_breakup;
    `);

    await queryInterface.sequelize.query(`DROP INDEX IF EXISTS ux_taxes_tax_code;`);

    await queryInterface.sequelize.query(`
      ALTER TABLE taxes
        DROP COLUMN IF EXISTS tax_code,
        DROP COLUMN IF EXISTS is_default,
        DROP COLUMN IF EXISTS is_mandatory,
        DROP COLUMN IF EXISTS is_system;
    `);
  },
};
