const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function createApiIntegrationTables() {
  try {
    console.log('📦 Creating API integration tables...');
    
    // 1. API Keys table (enhanced from existing vendor_api_keys)
    console.log('  Creating api_keys table...');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS api_keys (
        id SERIAL PRIMARY KEY,
        app_id VARCHAR(255) NOT NULL,
        api_key VARCHAR(255) UNIQUE NOT NULL,
        api_secret VARCHAR(255) NOT NULL,
        name VARCHAR(255),
        permission_level VARCHAR(20) DEFAULT 'read' CHECK (permission_level IN ('read', 'read-write')),
        active BOOLEAN DEFAULT true,
        rate_limit INTEGER DEFAULT 60,
        webhook_url TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_used_at TIMESTAMP,
        revoked_at TIMESTAMP,
        FOREIGN KEY (app_id) REFERENCES apps(app_id) ON DELETE CASCADE
      )
    `);
    
    // Create indexes
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_api_keys_app_id ON api_keys(app_id)
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_api_keys_key ON api_keys(api_key)
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_api_keys_active ON api_keys(active)
    `);
    console.log('    ✅ api_keys table created');
    
    // 2. API Activity Logs
    console.log('  Creating api_activity_logs table...');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS api_activity_logs (
        id SERIAL PRIMARY KEY,
        api_key_id INTEGER NOT NULL,
        endpoint VARCHAR(255) NOT NULL,
        method VARCHAR(10) NOT NULL,
        status_code INTEGER,
        response_time_ms INTEGER,
        ip_address VARCHAR(45),
        user_agent TEXT,
        request_body JSONB,
        response_body JSONB,
        error_message TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (api_key_id) REFERENCES api_keys(id) ON DELETE CASCADE
      )
    `);
    
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_api_logs_key_id ON api_activity_logs(api_key_id)
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_api_logs_created_at ON api_activity_logs(created_at)
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_api_logs_endpoint ON api_activity_logs(endpoint)
    `);
    console.log('    ✅ api_activity_logs table created');
    
    // 3. Webhook Logs (enhanced from existing vendor_webhooks)
    console.log('  Creating webhook_logs table...');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS webhook_logs (
        id SERIAL PRIMARY KEY,
        api_key_id INTEGER NOT NULL,
        event_type VARCHAR(50) NOT NULL,
        payload JSONB NOT NULL,
        webhook_url TEXT NOT NULL,
        status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'success', 'failed')),
        status_code INTEGER,
        response_body TEXT,
        attempt_number INTEGER DEFAULT 1,
        max_attempts INTEGER DEFAULT 6,
        next_retry_at TIMESTAMP,
        error_message TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        delivered_at TIMESTAMP,
        FOREIGN KEY (api_key_id) REFERENCES api_keys(id) ON DELETE CASCADE
      )
    `);
    
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_webhook_logs_key_id ON webhook_logs(api_key_id)
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_webhook_logs_status ON webhook_logs(status)
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_webhook_logs_event_type ON webhook_logs(event_type)
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_webhook_logs_next_retry ON webhook_logs(next_retry_at)
    `);
    console.log('    ✅ webhook_logs table created');
    
    // 4. External Users table (for partner platform users)
    console.log('  Creating external_users table...');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS external_users (
        id SERIAL PRIMARY KEY,
        app_id VARCHAR(255) NOT NULL,
        external_user_id VARCHAR(255) NOT NULL,
        wallet_address VARCHAR(255),
        email VARCHAR(255),
        metadata JSONB,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(app_id, external_user_id),
        FOREIGN KEY (app_id) REFERENCES apps(app_id) ON DELETE CASCADE
      )
    `);
    
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_external_users_app_id ON external_users(app_id)
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_external_users_external_id ON external_users(external_user_id)
    `);
    console.log('    ✅ external_users table created');
    
    // 5. API Integration Subscriptions (link external users to NFT subscriptions)
    console.log('  Creating api_integration_subscriptions table...');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS api_integration_subscriptions (
        id SERIAL PRIMARY KEY,
        app_id VARCHAR(255) NOT NULL,
        external_user_id VARCHAR(255) NOT NULL,
        token_id VARCHAR(255) NOT NULL,
        plan_id VARCHAR(255) NOT NULL,
        checkout_order_id VARCHAR(255),
        status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'expired', 'cancelled')),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (app_id, external_user_id) REFERENCES external_users(app_id, external_user_id) ON DELETE CASCADE,
        FOREIGN KEY (token_id) REFERENCES subscriptions(token_id) ON DELETE CASCADE,
        FOREIGN KEY (plan_id) REFERENCES subscription_plans(plan_id) ON DELETE CASCADE
      )
    `);
    
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_api_subs_app_user ON api_integration_subscriptions(app_id, external_user_id)
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_api_subs_token_id ON api_integration_subscriptions(token_id)
    `);
    console.log('    ✅ api_integration_subscriptions table created');
    
    console.log('\n✅ All API integration tables created successfully!');
    process.exit(0);
  } catch (error) {
    console.error('❌ Error creating API integration tables:', error);
    process.exit(1);
  }
}

createApiIntegrationTables();


