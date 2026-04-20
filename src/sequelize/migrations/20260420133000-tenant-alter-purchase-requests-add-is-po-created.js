"use strict";

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TABLE purchase_requests
      ADD COLUMN IF NOT EXISTS is_po_created BOOLEAN NOT NULL DEFAULT false;
    `);

    await queryInterface.sequelize.query(`
      CREATE INDEX IF NOT EXISTS idx_purchase_requests_is_po_created
      ON purchase_requests (is_po_created);
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      DROP INDEX IF EXISTS idx_purchase_requests_is_po_created;
    `);
    await queryInterface.sequelize.query(`
      ALTER TABLE purchase_requests
      DROP COLUMN IF EXISTS is_po_created;
    `);
  },
};

