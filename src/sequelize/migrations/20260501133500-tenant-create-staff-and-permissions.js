"use strict";

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      CREATE TABLE IF NOT EXISTS staff_users (
        id UUID PRIMARY KEY,
        restaurant_id UUID NOT NULL,
        name VARCHAR(160) NOT NULL,
        email VARCHAR(160) NOT NULL,
        phone VARCHAR(40),
        password_hash TEXT NOT NULL,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await queryInterface.sequelize.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS ux_staff_users_email_lower
      ON staff_users (LOWER(email));
    `);

    await queryInterface.sequelize.query(`
      CREATE TABLE IF NOT EXISTS permissions (
        id UUID PRIMARY KEY,
        staff_id UUID NOT NULL REFERENCES staff_users(id) ON DELETE CASCADE,
        module_name VARCHAR(80) NOT NULL,
        can_view BOOLEAN NOT NULL DEFAULT FALSE,
        can_add BOOLEAN NOT NULL DEFAULT FALSE,
        can_edit BOOLEAN NOT NULL DEFAULT FALSE,
        can_delete BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await queryInterface.sequelize.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS ux_permissions_staff_module
      ON permissions (staff_id, module_name);
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`DROP TABLE IF EXISTS permissions;`);
    await queryInterface.sequelize.query(`DROP TABLE IF EXISTS staff_users;`);
  },
};
