"use strict";

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    // 1) Ensure current_stock exists and is safe (NOT NULL, DEFAULT 0)
    // Note: column may already exist from earlier migrations.
    await queryInterface.sequelize.query(`
      ALTER TABLE raw_materials
      ADD COLUMN IF NOT EXISTS current_stock NUMERIC(14,3) NOT NULL DEFAULT 0;
    `);

    await queryInterface.sequelize.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_name = 'raw_materials'
            AND column_name = 'current_stock'
        ) THEN
          EXECUTE 'ALTER TABLE raw_materials ALTER COLUMN current_stock SET DEFAULT 0';
          EXECUTE 'UPDATE raw_materials SET current_stock = 0 WHERE current_stock IS NULL';
          EXECUTE 'ALTER TABLE raw_materials ALTER COLUMN current_stock SET NOT NULL';
        END IF;
      END $$;
    `);

    // 2) Add stock_unit_id (nullable initially) with FK ON DELETE SET NULL
    await queryInterface.sequelize.query(`
      ALTER TABLE raw_materials
      ADD COLUMN IF NOT EXISTS stock_unit_id UUID;
    `);

    await queryInterface.sequelize.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conname = 'fk_raw_materials_stock_unit_id'
        ) THEN
          EXECUTE 'ALTER TABLE raw_materials
                   ADD CONSTRAINT fk_raw_materials_stock_unit_id
                   FOREIGN KEY (stock_unit_id)
                   REFERENCES units(id)
                   ON DELETE SET NULL';
        END IF;
      END $$;
    `);

    // 3) Optional backfill: stock_unit_id = consumption_unit_id if available
    await queryInterface.sequelize.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_name = 'raw_materials'
            AND column_name = 'consumption_unit_id'
        ) THEN
          EXECUTE 'UPDATE raw_materials
                   SET stock_unit_id = consumption_unit_id
                   WHERE stock_unit_id IS NULL AND consumption_unit_id IS NOT NULL';
        END IF;
      END $$;
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TABLE raw_materials
      DROP CONSTRAINT IF EXISTS fk_raw_materials_stock_unit_id;
    `);

    await queryInterface.sequelize.query(`
      ALTER TABLE raw_materials
      DROP COLUMN IF EXISTS stock_unit_id,
      DROP COLUMN IF EXISTS current_stock;
    `);
  },
};

