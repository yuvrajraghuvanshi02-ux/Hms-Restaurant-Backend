"use strict";

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TABLE orders
      ADD COLUMN IF NOT EXISTS assigned_staff_id UUID;
    `);

    await queryInterface.sequelize.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conname = 'fk_orders_assigned_staff_id'
        ) THEN
          ALTER TABLE orders
          ADD CONSTRAINT fk_orders_assigned_staff_id
          FOREIGN KEY (assigned_staff_id)
          REFERENCES staff_users(id)
          ON UPDATE CASCADE
          ON DELETE SET NULL;
        END IF;
      END $$;
    `);

    await queryInterface.sequelize.query(`
      CREATE INDEX IF NOT EXISTS idx_orders_assigned_staff_id
      ON orders (assigned_staff_id);
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TABLE orders
      DROP CONSTRAINT IF EXISTS fk_orders_assigned_staff_id;
    `);

    await queryInterface.sequelize.query(`
      DROP INDEX IF EXISTS idx_orders_assigned_staff_id;
    `);

    await queryInterface.sequelize.query(`
      ALTER TABLE orders
      DROP COLUMN IF EXISTS assigned_staff_id;
    `);
  },
};
