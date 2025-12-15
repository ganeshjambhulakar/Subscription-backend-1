const { Pool } = require('pg');
const dotenv = require('dotenv');

dotenv.config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function addTransactionHashColumn() {
  try {
    console.log('Adding transaction_hash column to subscriptions table...');
    
    // Check if column exists
    const checkResult = await pool.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'subscriptions' 
      AND column_name = 'transaction_hash'
    `);
    
    if (checkResult.rows.length > 0) {
      console.log('✅ Column transaction_hash already exists');
      process.exit(0);
      return;
    }
    
    // Add the column
    await pool.query(`
      ALTER TABLE subscriptions 
      ADD COLUMN transaction_hash VARCHAR(255)
    `);
    
    console.log('✅ Successfully added transaction_hash column to subscriptions table');
    process.exit(0);
  } catch (error) {
    console.error('Error adding column:', error);
    process.exit(1);
  }
}

addTransactionHashColumn();

