/**
 * Migration script to create webhooks and webhook_logs tables
 * This enables full webhook management for Elite Pass SDK
 */

const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function createWebhooksTable() {
  console.log('🔄 Creating webhooks and webhook_logs tables...\n');

  try {
    // Create webhooks table for webhook configurations
    await pool.query(`
      CREATE TABLE IF NOT EXISTS webhooks (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        app_id VARCHAR(255) NOT NULL,
        url TEXT NOT NULL,
        secret VARCHAR(255) NOT NULL,
        events JSONB NOT NULL DEFAULT '[]'::jsonb,
        active BOOLEAN DEFAULT true,
        description TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_triggered_at TIMESTAMP,
        success_count INTEGER DEFAULT 0,
        failure_count INTEGER DEFAULT 0,
        CONSTRAINT webhooks_url_app_unique UNIQUE (app_id, url)
      );
    `);
    console.log('✅ Created webhooks table');

    // Create webhook_logs table if not exists (might already exist)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS webhook_logs (
        id SERIAL PRIMARY KEY,
        webhook_id UUID REFERENCES webhooks(id) ON DELETE SET NULL,
        api_key_id INTEGER,
        event_type VARCHAR(100) NOT NULL,
        payload JSONB NOT NULL,
        webhook_url TEXT NOT NULL,
        status VARCHAR(50) DEFAULT 'pending',
        status_code INTEGER,
        response_body TEXT,
        error_message TEXT,
        attempt_number INTEGER DEFAULT 1,
        max_attempts INTEGER DEFAULT 5,
        next_retry_at TIMESTAMP,
        delivered_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        duration_ms INTEGER
      );
    `);
    console.log('✅ Created/verified webhook_logs table');

    // Add webhook_id column to webhook_logs if it doesn't exist
    await pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns 
          WHERE table_name = 'webhook_logs' AND column_name = 'webhook_id'
        ) THEN
          ALTER TABLE webhook_logs ADD COLUMN webhook_id UUID REFERENCES webhooks(id) ON DELETE SET NULL;
        END IF;
      END $$;
    `);

    // Add duration_ms column if it doesn't exist
    await pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns 
          WHERE table_name = 'webhook_logs' AND column_name = 'duration_ms'
        ) THEN
          ALTER TABLE webhook_logs ADD COLUMN duration_ms INTEGER;
        END IF;
      END $$;
    `);

    // Create indexes for better query performance
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_webhooks_app_id ON webhooks(app_id);
      CREATE INDEX IF NOT EXISTS idx_webhooks_active ON webhooks(active);
      CREATE INDEX IF NOT EXISTS idx_webhook_logs_webhook_id ON webhook_logs(webhook_id);
      CREATE INDEX IF NOT EXISTS idx_webhook_logs_status ON webhook_logs(status);
      CREATE INDEX IF NOT EXISTS idx_webhook_logs_event_type ON webhook_logs(event_type);
      CREATE INDEX IF NOT EXISTS idx_webhook_logs_created_at ON webhook_logs(created_at);
      CREATE INDEX IF NOT EXISTS idx_webhook_logs_next_retry ON webhook_logs(next_retry_at) WHERE status IN ('pending', 'failed');
    `);
    console.log('✅ Created indexes');

    // Insert default webhook event types into a reference table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS webhook_event_types (
        id SERIAL PRIMARY KEY,
        event_name VARCHAR(100) UNIQUE NOT NULL,
        description TEXT,
        category VARCHAR(50)
      );

      INSERT INTO webhook_event_types (event_name, description, category)
      VALUES 
        ('subscription.purchased', 'Triggered when a subscription is purchased', 'subscription'),
        ('subscription.expired', 'Triggered when a subscription expires', 'subscription'),
        ('subscription.cancelled', 'Triggered when a subscription is cancelled', 'subscription'),
        ('subscription.renewed', 'Triggered when a subscription is renewed', 'subscription'),
        ('order.created', 'Triggered when a new order is created', 'checkout'),
        ('payment.completed', 'Triggered when payment is confirmed on blockchain', 'checkout'),
        ('order.status_changed', 'Triggered when order status changes', 'checkout'),
        ('order.accepted', 'Triggered when vendor accepts an order', 'checkout'),
        ('order.delivered', 'Triggered when order is marked as delivered', 'checkout'),
        ('order.refunded', 'Triggered when a refund is processed', 'checkout'),
        ('order.cancelled', 'Triggered when an order is cancelled', 'checkout')
      ON CONFLICT (event_name) DO NOTHING;
    `);
    console.log('✅ Created webhook_event_types reference table');

    console.log('\n✅ All webhook tables created successfully!');
    console.log('\n📊 Tables created:');
    console.log('   - webhooks: Stores webhook configurations');
    console.log('   - webhook_logs: Stores delivery attempts and results');
    console.log('   - webhook_event_types: Reference table for available events');

  } catch (error) {
    console.error('❌ Error creating webhook tables:', error.message);
    throw error;
  } finally {
    await pool.end();
  }
}

// Run migration
createWebhooksTable()
  .then(() => {
    console.log('\n✅ Migration completed successfully');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n❌ Migration failed:', error);
    process.exit(1);
  });







