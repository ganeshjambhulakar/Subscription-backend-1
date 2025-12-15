const { Pool } = require('pg');
require('dotenv').config();

// Use DATABASE_URL from environment, or default to localhost if running locally
const databaseUrl = process.env.DATABASE_URL || 
  process.env.DATABASE_URL_LOCAL || 
  'postgresql://subscription_user:subscription_pass@localhost:5432/subscription_db';

const pool = new Pool({
  connectionString: databaseUrl,
});

async function deleteAllOrders() {
  try {
    console.log('🗑️  Clearing all checkout orders...');
    console.log(`📊 Database: ${databaseUrl.replace(/:[^:@]+@/, ':****@')}\n`);
    
    // Get counts before deletion
    const transactionsCount = await pool.query('SELECT COUNT(*) FROM checkout_transactions');
    const webhooksCount = await pool.query('SELECT COUNT(*) FROM vendor_webhooks');
    const itemsCount = await pool.query('SELECT COUNT(*) FROM checkout_order_items');
    const ordersCount = await pool.query('SELECT COUNT(*) FROM checkout_orders');
    
    console.log(`Found ${ordersCount.rows[0].count} orders, ${itemsCount.rows[0].count} items, ${transactionsCount.rows[0].count} transactions, ${webhooksCount.rows[0].count} webhooks\n`);
    
    // Delete in correct order due to foreign key constraints
    const transactionsResult = await pool.query('DELETE FROM checkout_transactions');
    console.log(`✅ Deleted ${transactionsCount.rows[0].count} transactions`);
    
    const webhooksResult = await pool.query('DELETE FROM vendor_webhooks');
    console.log(`✅ Deleted ${webhooksCount.rows[0].count} webhooks`);
    
    const itemsResult = await pool.query('DELETE FROM checkout_order_items');
    console.log(`✅ Deleted ${itemsCount.rows[0].count} order items`);
    
    const ordersResult = await pool.query('DELETE FROM checkout_orders');
    console.log(`✅ Deleted ${ordersCount.rows[0].count} orders`);
    
    console.log('\n✅ All checkout orders cleared successfully!');
    console.log('\n💡 Note: If orders are cached in browser localStorage, clear them manually:');
    console.log('   - Open browser console');
    console.log('   - Run: localStorage.removeItem("checkout_orders_<customerAddress>")');
    console.log('   - Or clear all: localStorage.clear()\n');
    
    await pool.end();
    process.exit(0);
  } catch (error) {
    console.error('❌ Error deleting orders:', error.message);
    if (error.message.includes('password must be a string')) {
      console.error('\n💡 Tip: Set DATABASE_URL environment variable:');
      console.error('   export DATABASE_URL="postgresql://user:pass@localhost:5432/dbname"');
      console.error('   Or use: DATABASE_URL="..." node checkout/scripts/delete-all-orders.js\n');
    }
    await pool.end();
    process.exit(1);
  }
}

deleteAllOrders();

