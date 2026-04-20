"use strict";

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      CREATE TABLE IF NOT EXISTS raw_materials (
        id UUID PRIMARY KEY,
        name VARCHAR(150) NOT NULL UNIQUE,
        unit_id UUID NOT NULL REFERENCES units(id) ON DELETE RESTRICT,
        current_stock NUMERIC(14,3) NOT NULL DEFAULT 0,
        min_stock NUMERIC(14,3),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`DROP TABLE IF EXISTS raw_materials;`);
  },
};

