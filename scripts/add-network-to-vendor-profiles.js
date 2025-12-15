const { Pool } = require('pg');
const dotenv = require('dotenv');

dotenv.config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function addNetworkColumn() {
  try {
    console.log('📋 Adding network column to vendor_profiles table...');
    
    // Check if vendor_profiles table exists, create if not
    const tableCheck = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'vendor_profiles'
      )
    `);
    
    if (!tableCheck.rows[0].exists) {
      console.log('📋 Creating vendor_profiles table...');
      await pool.query(`
        CREATE TABLE vendor_profiles (
          id SERIAL PRIMARY KEY,
          vendor_address VARCHAR(255) UNIQUE NOT NULL,
          name VARCHAR(255),
          email VARCHAR(255),
          network VARCHAR(50) DEFAULT 'localhost',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
      console.log('✅ vendor_profiles table created');
    } else {
      // Add network column if it doesn't exist
      try {
        await pool.query(`
          ALTER TABLE vendor_profiles 
          ADD COLUMN IF NOT EXISTS network VARCHAR(50) DEFAULT 'localhost'
        `);
        console.log('✅ network column added to vendor_profiles');
      } catch (e) {
        console.warn('⚠️ Could not add network column:', e.message);
      }
    }
    
    console.log('✅ Migration completed successfully');
    process.exit(0);
  } catch (error) {
    console.error('❌ Migration error:', error);
    process.exit(1);
  }
}

addNetworkColumn();

