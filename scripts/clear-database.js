const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function clearDatabase() {
  try {
    console.log('🗑️  Clearing all database tables...');
    
    // Disable foreign key checks temporarily
    await pool.query('SET session_replication_role = replica');
    
    // Clear all tables in correct order (respecting foreign keys)
    console.log('  Clearing subscription_history...');
    await pool.query('TRUNCATE TABLE subscription_history CASCADE');
    
    console.log('  Clearing subscriptions...');
    await pool.query('TRUNCATE TABLE subscriptions CASCADE');
    
    console.log('  Clearing subscription_plans...');
    await pool.query('TRUNCATE TABLE subscription_plans CASCADE');
    
    console.log('  Clearing customer_profiles...');
    await pool.query('TRUNCATE TABLE customer_profiles CASCADE');
    
    console.log('  Clearing apps...');
    await pool.query('TRUNCATE TABLE apps CASCADE');
    
    // Re-enable foreign key checks
    await pool.query('SET session_replication_role = origin');
    
    // Reset sequences
    console.log('  Resetting sequences...');
    await pool.query('ALTER SEQUENCE IF EXISTS subscription_history_id_seq RESTART WITH 1');
    await pool.query('ALTER SEQUENCE IF EXISTS subscriptions_id_seq RESTART WITH 1');
    await pool.query('ALTER SEQUENCE IF EXISTS subscription_plans_id_seq RESTART WITH 1');
    await pool.query('ALTER SEQUENCE IF EXISTS customer_profiles_id_seq RESTART WITH 1');
    await pool.query('ALTER SEQUENCE IF EXISTS apps_id_seq RESTART WITH 1');
    
    // Verify tables are empty
    const tables = ['apps', 'subscription_plans', 'subscriptions', 'customer_profiles', 'subscription_history'];
    for (const table of tables) {
      const result = await pool.query(`SELECT COUNT(*) FROM ${table}`);
      const count = parseInt(result.rows[0].count);
      if (count > 0) {
        console.warn(`⚠️  Warning: Table ${table} still has ${count} rows`);
      } else {
        console.log(`  ✅ ${table}: cleared`);
      }
    }
    
    console.log('✅ Database cleared successfully!');
    process.exit(0);
  } catch (error) {
    console.error('❌ Error clearing database:', error);
    process.exit(1);
  }
}

clearDatabase();

