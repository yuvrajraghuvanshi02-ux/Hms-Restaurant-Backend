"use strict";

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TABLE raw_materials
      ADD COLUMN IF NOT EXISTS conversion_factor NUMERIC(14,3) NOT NULL DEFAULT 1;
    `);

    await queryInterface.sequelize.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_name = 'raw_materials'
            AND column_name = 'conversion_factor'
        ) THEN
          EXECUTE 'UPDATE raw_materials
                   SET conversion_factor = 1
                   WHERE conversion_factor IS NULL OR conversion_factor <= 0';
          EXECUTE 'ALTER TABLE raw_materials ALTER COLUMN conversion_factor SET DEFAULT 1';
          EXECUTE 'ALTER TABLE raw_materials ALTER COLUMN conversion_factor SET NOT NULL';
        END IF;
      END $$;
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TABLE raw_materials
      DROP COLUMN IF EXISTS conversion_factor;
    `);
  },
};

