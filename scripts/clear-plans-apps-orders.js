const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function clearPlansAppsOrders() {
  try {
    console.log('🗑️  Clearing plans, apps, and orders from database...');
    
    // Disable foreign key checks temporarily
    await pool.query('SET session_replication_role = replica');
    
    // Clear checkout order items first (has foreign key to orders)
    console.log('  Clearing checkout_order_items...');
    try {
      await pool.query('TRUNCATE TABLE checkout_order_items CASCADE');
      console.log('    ✅ checkout_order_items cleared');
    } catch (error) {
      console.warn('    ⚠️  checkout_order_items table may not exist:', error.message);
    }
    
    // Clear checkout orders
    console.log('  Clearing checkout_orders...');
    try {
      await pool.query('TRUNCATE TABLE checkout_orders CASCADE');
      console.log('    ✅ checkout_orders cleared');
    } catch (error) {
      console.warn('    ⚠️  checkout_orders table may not exist:', error.message);
    }
    
    // Clear subscriptions (they reference plans)
    console.log('  Clearing subscriptions...');
    try {
      await pool.query('TRUNCATE TABLE subscriptions CASCADE');
      console.log('    ✅ subscriptions cleared');
    } catch (error) {
      console.warn('    ⚠️  subscriptions table may not exist:', error.message);
    }
    
    // Clear subscription_history (references subscriptions)
    console.log('  Clearing subscription_history...');
    try {
      await pool.query('TRUNCATE TABLE subscription_history CASCADE');
      console.log('    ✅ subscription_history cleared');
    } catch (error) {
      console.warn('    ⚠️  subscription_history table may not exist:', error.message);
    }
    
    // Clear subscription plans
    console.log('  Clearing subscription_plans...');
    try {
      await pool.query('TRUNCATE TABLE subscription_plans CASCADE');
      console.log('    ✅ subscription_plans cleared');
    } catch (error) {
      console.warn('    ⚠️  subscription_plans table may not exist:', error.message);
    }
    
    // Clear apps
    console.log('  Clearing apps...');
    try {
      await pool.query('TRUNCATE TABLE apps CASCADE');
      console.log('    ✅ apps cleared');
    } catch (error) {
      console.warn('    ⚠️  apps table may not exist:', error.message);
    }
    
    // Clear checkout_apps
    console.log('  Clearing checkout_apps...');
    try {
      await pool.query('TRUNCATE TABLE checkout_apps CASCADE');
      console.log('    ✅ checkout_apps cleared');
    } catch (error) {
      console.warn('    ⚠️  checkout_apps table may not exist:', error.message);
    }
    
    // Re-enable foreign key checks
    await pool.query('SET session_replication_role = origin');
    
    // Reset sequences
    console.log('  Resetting sequences...');
    const sequences = [
      'checkout_order_items_id_seq',
      'checkout_orders_id_seq',
      'subscriptions_id_seq',
      'subscription_history_id_seq',
      'subscription_plans_id_seq',
      'apps_id_seq',
      'checkout_apps_id_seq'
    ];
    
    for (const seq of sequences) {
      try {
        await pool.query(`ALTER SEQUENCE IF EXISTS ${seq} RESTART WITH 1`);
        console.log(`    ✅ ${seq} reset`);
      } catch (error) {
        console.warn(`    ⚠️  Could not reset ${seq}:`, error.message);
      }
    }
    
    // Verify tables are empty
    console.log('\n📊 Verifying tables are empty...');
    const tables = [
      'apps',
      'checkout_apps',
      'subscription_plans',
      'checkout_orders',
      'checkout_order_items',
      'subscriptions',
      'subscription_history'
    ];
    
    for (const table of tables) {
      try {
        const result = await pool.query(`SELECT COUNT(*) FROM ${table}`);
        const count = parseInt(result.rows[0].count);
        if (count === 0) {
          console.log(`  ✅ ${table}: 0 rows`);
        } else {
          console.log(`  ⚠️  ${table}: ${count} rows (should be 0)`);
        }
      } catch (error) {
        console.warn(`  ⚠️  Could not verify ${table}:`, error.message);
      }
    }
    
    console.log('\n✅ Database cleanup complete!');
    console.log('   - All plans cleared');
    console.log('   - All apps cleared');
    console.log('   - All checkout_apps cleared');
    console.log('   - All orders cleared');
    console.log('   - All subscriptions cleared (they depend on plans)');
    
    await pool.end();
    process.exit(0);
  } catch (error) {
    console.error('❌ Error clearing database:', error);
    await pool.end();
    process.exit(1);
  }
}

clearPlansAppsOrders();


