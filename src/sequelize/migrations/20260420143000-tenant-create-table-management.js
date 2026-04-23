"use strict";

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      CREATE TABLE IF NOT EXISTS table_types (
        id UUID PRIMARY KEY,
        name VARCHAR(120) NOT NULL,
        description TEXT,
        is_active BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await queryInterface.sequelize.query(`
      CREATE TABLE IF NOT EXISTS tables (
        id UUID PRIMARY KEY,
        name VARCHAR(80) NOT NULL,
        table_type_id UUID NOT NULL REFERENCES table_types(id) ON DELETE RESTRICT,
        capacity INT NOT NULL DEFAULT 1,
        is_active BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CHECK (capacity >= 1)
      );
    `);

    await queryInterface.sequelize.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_indexes WHERE indexname = 'ux_tables_name_lower'
        ) THEN
          CREATE UNIQUE INDEX ux_tables_name_lower
          ON tables ((lower(btrim(name::text))));
        END IF;
      END $$;
    `);

    await queryInterface.sequelize.query(`
      CREATE INDEX IF NOT EXISTS idx_table_types_created_at
      ON table_types (created_at DESC);
    `);

    await queryInterface.sequelize.query(`
      CREATE INDEX IF NOT EXISTS idx_tables_created_at
      ON tables (created_at DESC);
    `);

    await queryInterface.sequelize.query(`
      CREATE INDEX IF NOT EXISTS idx_tables_table_type_id
      ON tables (table_type_id);
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`DROP TABLE IF EXISTS tables;`);
    await queryInterface.sequelize.query(`DROP TABLE IF EXISTS table_types;`);
  },
};

