"use strict";

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto;`);

    await queryInterface.sequelize.query(`
      ALTER TABLE raw_materials
      ADD COLUMN IF NOT EXISTS category_id UUID REFERENCES raw_material_categories(id) ON DELETE RESTRICT;
    `);

    await queryInterface.sequelize.query(`
      INSERT INTO raw_material_categories (id, name)
      SELECT gen_random_uuid(), TRIM(rm.category)
      FROM raw_materials rm
      WHERE rm.category IS NOT NULL AND TRIM(rm.category) <> ''
      ON CONFLICT (name) DO NOTHING;
    `);

    await queryInterface.sequelize.query(`
      UPDATE raw_materials rm
      SET category_id = c.id
      FROM raw_material_categories c
      WHERE (rm.category_id IS NULL)
        AND rm.category IS NOT NULL
        AND TRIM(rm.category) <> ''
        AND c.name = TRIM(rm.category);
    `);

    await queryInterface.sequelize.query(`
      CREATE INDEX IF NOT EXISTS idx_raw_materials_category_id
      ON raw_materials (category_id);
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TABLE raw_materials
      DROP COLUMN IF EXISTS category_id;
    `);
  },
};

