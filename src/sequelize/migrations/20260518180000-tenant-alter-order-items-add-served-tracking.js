"use strict";

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TABLE order_items
      ADD COLUMN IF NOT EXISTS is_served BOOLEAN NOT NULL DEFAULT FALSE;
    `);

    await queryInterface.sequelize.query(`
      ALTER TABLE order_items
      ADD COLUMN IF NOT EXISTS served_at TIMESTAMPTZ NULL;
    `);

    await queryInterface.sequelize.query(`
      ALTER TABLE order_items
      ADD COLUMN IF NOT EXISTS served_by UUID NULL;
    `);

    await queryInterface.sequelize.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conname = 'fk_order_items_served_by_staff_users'
        ) THEN
          ALTER TABLE order_items
          ADD CONSTRAINT fk_order_items_served_by_staff_users
          FOREIGN KEY (served_by) REFERENCES staff_users(id) ON DELETE SET NULL;
        END IF;
      END $$;
    `);

    await queryInterface.sequelize.query(`
      CREATE INDEX IF NOT EXISTS idx_order_items_is_served
      ON order_items (is_served);
    `);

    await queryInterface.sequelize.query(`
      CREATE INDEX IF NOT EXISTS idx_order_items_served_at
      ON order_items (served_at DESC);
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`DROP INDEX IF EXISTS idx_order_items_served_at;`);
    await queryInterface.sequelize.query(`DROP INDEX IF EXISTS idx_order_items_is_served;`);
    await queryInterface.sequelize.query(`
      ALTER TABLE order_items
      DROP CONSTRAINT IF EXISTS fk_order_items_served_by_staff_users;
    `);
    await queryInterface.sequelize.query(`
      ALTER TABLE order_items
      DROP COLUMN IF EXISTS served_by,
      DROP COLUMN IF EXISTS served_at,
      DROP COLUMN IF EXISTS is_served;
    `);
  },
};
