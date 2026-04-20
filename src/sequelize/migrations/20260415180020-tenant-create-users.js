"use strict";

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY,
        first_name VARCHAR(80) NOT NULL,
        last_name VARCHAR(80) NOT NULL,
        email VARCHAR(160) NOT NULL UNIQUE,
        password VARCHAR(255) NOT NULL,
        role VARCHAR(30) NOT NULL DEFAULT 'admin',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`DROP TABLE IF EXISTS users;`);
  },
};

