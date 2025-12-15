const { Pool } = require('pg');
const dotenv = require('dotenv');

dotenv.config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function createMaintenanceModeTable() {
  try {
    console.log('📋 Creating maintenance_mode table...');

    await pool.query(`
      CREATE TABLE IF NOT EXISTS maintenance_mode (
        id SERIAL PRIMARY KEY,
        entity_type VARCHAR(50) NOT NULL UNIQUE,
        enabled BOOLEAN DEFAULT false,
        message TEXT,
        enabled_by VARCHAR(255),
        enabled_at TIMESTAMP,
        disabled_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create index on entity_type for faster lookups
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_maintenance_mode_entity_type 
      ON maintenance_mode(entity_type)
    `);

    // Create index on enabled for faster status checks
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_maintenance_mode_enabled 
      ON maintenance_mode(enabled)
    `);

    // Initialize default entries for each entity type if they don't exist
    const entityTypes = ['vendor', 'customer', 'api', 'package'];
    for (const entityType of entityTypes) {
      await pool.query(`
        INSERT INTO maintenance_mode (entity_type, enabled, message)
        VALUES ($1, false, 'System is under maintenance. Please try again later.')
        ON CONFLICT (entity_type) DO NOTHING
      `, [entityType]);
    }

    console.log('✅ maintenance_mode table created successfully');
    console.log('✅ Indexes created successfully');
    console.log('✅ Default entity types initialized');
  } catch (error) {
    console.error('❌ Error creating maintenance_mode table:', error);
    throw error;
  } finally {
    await pool.end();
  }
}

// Run if called directly
if (require.main === module) {
  createMaintenanceModeTable()
    .then(() => {
      console.log('✅ Migration completed');
      process.exit(0);
    })
    .catch((error) => {
      console.error('❌ Migration failed:', error);
      process.exit(1);
    });
}

module.exports = createMaintenanceModeTable;

