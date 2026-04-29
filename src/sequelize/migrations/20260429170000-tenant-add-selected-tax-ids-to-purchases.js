"use strict";

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TABLE purchase_requests
      ADD COLUMN IF NOT EXISTS selected_tax_ids JSONB NOT NULL DEFAULT '[]'::jsonb;
    `);

    await queryInterface.sequelize.query(`
      ALTER TABLE purchase_orders
      ADD COLUMN IF NOT EXISTS selected_tax_ids JSONB NOT NULL DEFAULT '[]'::jsonb;
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TABLE purchase_orders
      DROP COLUMN IF EXISTS selected_tax_ids;
    `);

    await queryInterface.sequelize.query(`
      ALTER TABLE purchase_requests
      DROP COLUMN IF EXISTS selected_tax_ids;
    `);
  },
};
