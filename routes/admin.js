const express = require('express');
const router = express.Router();
const { Pool } = require('pg');
const { ethers } = require('ethers');
const contractService = require('../services/contractService');
const { getNetworkFromRequest } = require('../utils/networkHelper');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

/**
 * POST /api/admin/db-cleanup
 * Danger Zone: clears all DB tables except vendor identity tables.
 *
 * Safeguards:
 * - requires adminSecret to match ADMIN_MAINTENANCE_SECRET
 * - requires confirmation phrase
 */
router.post('/db-cleanup', async (req, res) => {
  const requiredSecret = process.env.ADMIN_MAINTENANCE_SECRET;
  const { adminSecret, confirmation } = req.body || {};

  if (!requiredSecret) {
    return res.status(503).json({
      error: 'Maintenance not configured',
      message: 'Set ADMIN_MAINTENANCE_SECRET in backend environment to enable DB cleanup.'
    });
  }

  if (!adminSecret || adminSecret !== requiredSecret) {
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Invalid admin maintenance secret.'
    });
  }

  if (confirmation !== 'CLEAR_ALL_EXCEPT_VENDORS') {
    return res.status(400).json({
      error: 'Confirmation required',
      message: 'Set confirmation to exactly: CLEAR_ALL_EXCEPT_VENDORS'
    });
  }

  const preservedTables = ['vendor_profiles', 'vendor_api_keys'];

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET session_replication_role = replica');

    const tablesResult = await client.query(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_type = 'BASE TABLE'`
    );

    const allTables = tablesResult.rows.map(r => r.table_name);
    const tablesToTruncate = allTables.filter(t => !preservedTables.includes(t));

    // Truncate everything else (CASCADE to respect FKs)
    for (const table of tablesToTruncate) {
      await client.query(`TRUNCATE TABLE "${table}" CASCADE`);
    }

    await client.query('SET session_replication_role = origin');
    await client.query('COMMIT');

    return res.json({
      success: true,
      preservedTables,
      truncatedTables: tablesToTruncate,
      message: `Truncated ${tablesToTruncate.length} tables. Preserved: ${preservedTables.join(', ')}`
    });
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (e) {
      // ignore
    }
    return res.status(500).json({
      error: 'Cleanup failed',
      message: error.message
    });
  } finally {
    client.release();
  }
});

/**
 * GET /api/admin/plans
 * Get all plans with pagination, search, and sorting
 */
router.get('/plans', async (req, res, next) => {
  try {
    const { page = 1, limit = 25, search = '', sortBy = 'created_at', sortOrder = 'desc' } = req.query;
    const offset = (page - 1) * limit;

    let query = `
      SELECT 
        plan_id,
        vendor_address,
        name,
        description,
        price,
        duration,
        active,
        max_subscriptions,
        pause_enabled,
        max_pause_attempts,
        app_id,
        created_at
      FROM subscription_plans
      WHERE 1=1
    `;
    const params = [];
    let paramCount = 0;

    if (search) {
      paramCount++;
      query += ` AND (name ILIKE $${paramCount} OR description ILIKE $${paramCount} OR plan_id::text ILIKE $${paramCount} OR vendor_address ILIKE $${paramCount})`;
      params.push(`%${search}%`);
    }

    // Validate sortBy to prevent SQL injection
    const validSortColumns = ['plan_id', 'name', 'price', 'duration', 'created_at', 'vendor_address', 'active'];
    const sortColumn = validSortColumns.includes(sortBy) ? sortBy : 'created_at';
    const sortDirection = sortOrder.toLowerCase() === 'asc' ? 'ASC' : 'DESC';

    query += ` ORDER BY ${sortColumn} ${sortDirection} LIMIT $${paramCount + 1} OFFSET $${paramCount + 2}`;
    params.push(limit, offset);

    const result = await pool.query(query, params);
    const countResult = await pool.query(
      search 
        ? `SELECT COUNT(*) FROM subscription_plans WHERE (name ILIKE $1 OR description ILIKE $1 OR plan_id::text ILIKE $1 OR vendor_address ILIKE $1)`
        : `SELECT COUNT(*) FROM subscription_plans`,
      search ? [`%${search}%`] : []
    );

    res.json({
      data: result.rows,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: parseInt(countResult.rows[0].count),
        totalPages: Math.ceil(countResult.rows[0].count / limit)
      }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/admin/subscriptions
 * Get all subscriptions with pagination, search, and sorting
 */
router.get('/subscriptions', async (req, res, next) => {
  try {
    const { page = 1, limit = 25, search = '', sortBy = 'created_at', sortOrder = 'desc', status } = req.query;
    const offset = (page - 1) * limit;

    let query = `
      SELECT 
        s.token_id,
        s.subscriber_address,
        s.plan_id,
        s.created_at,
        sp.name as plan_name,
        sp.vendor_address,
        sp.price as plan_price,
        sp.duration as plan_duration
      FROM subscriptions s
      LEFT JOIN subscription_plans sp ON s.plan_id = sp.plan_id
      WHERE 1=1
    `;
    const params = [];
    let paramCount = 0;

    if (search) {
      paramCount++;
      query += ` AND (
        s.token_id::text ILIKE $${paramCount} OR 
        s.subscriber_address ILIKE $${paramCount} OR 
        sp.name ILIKE $${paramCount}
      )`;
      params.push(`%${search}%`);
    }

    const validSortColumns = ['token_id', 'subscriber_address', 'plan_name', 'created_at'];
    const sortColumn = validSortColumns.includes(sortBy) ? sortBy : 'created_at';
    const sortDirection = sortOrder.toLowerCase() === 'asc' ? 'ASC' : 'DESC';

    // Handle sorting by plan_name
    if (sortColumn === 'plan_name') {
      query += ` ORDER BY sp.name ${sortDirection}`;
    } else {
      query += ` ORDER BY s.${sortColumn === 'plan_name' ? 'created_at' : sortColumn} ${sortDirection}`;
    }

    query += ` LIMIT $${paramCount + 1} OFFSET $${paramCount + 2}`;
    params.push(limit, offset);

    const result = await pool.query(query, params);
    
    // Enrich with blockchain data
    const enrichedSubscriptions = await Promise.all(
      result.rows.map(async (sub) => {
        try {
          const contract = await contractService.getContract();
          const subscription = await contract.getSubscription(sub.token_id);
          const startTime = parseInt(subscription.startTime.toString());
          const endTime = parseInt(subscription.endTime.toString());
          const isValid = subscription.active && endTime > Math.floor(Date.now() / 1000);
          return {
            ...sub,
            start_time: startTime,
            end_time: endTime,
            isValid: isValid,
            paused: subscription.paused,
            published: subscription.published
          };
        } catch (e) {
          console.error(`Error fetching subscription ${sub.token_id} from blockchain:`, e.message);
          return {
            ...sub,
            start_time: null,
            end_time: null,
            isValid: false,
            paused: false,
            published: true
          };
        }
      })
    );

    // Filter by status after enriching with blockchain data
    let filteredSubscriptions = enrichedSubscriptions;
    if (status === 'active') {
      filteredSubscriptions = enrichedSubscriptions.filter(s => s.isValid);
    } else if (status === 'expired') {
      filteredSubscriptions = enrichedSubscriptions.filter(s => !s.isValid);
    }

    // For count, we need to get all matching records and filter by status
    // Since status filtering requires blockchain data, we'll use the filtered results count
    const countQuery = `
      SELECT COUNT(*) 
      FROM subscriptions s
      LEFT JOIN subscription_plans sp ON s.plan_id = sp.plan_id
      WHERE 1=1
      ${search ? `AND (s.token_id::text ILIKE $1 OR s.subscriber_address ILIKE $1 OR sp.name ILIKE $1)` : ''}
    `;
    const countParams = search ? [`%${search}%`] : [];
    const countResult = await pool.query(countQuery, countParams);
    
    // Adjust count based on status filter (if applied)
    let totalCount = parseInt(countResult.rows[0].count);
    if (status === 'active' || status === 'expired') {
      totalCount = filteredSubscriptions.length;
    }

    // Apply pagination to filtered results
    const paginatedData = filteredSubscriptions.slice(offset, offset + parseInt(limit));

    res.json({
      data: paginatedData,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: totalCount,
        totalPages: Math.ceil(totalCount / limit)
      }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/admin/vendors
 * Get all vendors with pagination, search, and sorting
 */
router.get('/vendors', async (req, res, next) => {
  try {
    const { page = 1, limit = 25, search = '', sortBy = 'created_at', sortOrder = 'desc' } = req.query;
    const offset = (page - 1) * limit;

    let query = `
      SELECT 
        v.vendor_address,
        vp.id as vendor_profile_id,
        vp.name as vendor_name,
        vp.email as vendor_email,
        vp.network as vendor_network,
        COUNT(DISTINCT a.app_id) + COUNT(DISTINCT ca.app_id) as total_apps,
        COUNT(DISTINCT sp.plan_id) as total_plans,
        COALESCE(SUM(sp.price * (
          SELECT COUNT(*) FROM subscriptions s WHERE s.plan_id = sp.plan_id
        )), 0) as total_revenue,
        MIN(sp.created_at) as first_plan_date,
        LEAST(COALESCE(MIN(a.created_at), '9999-12-31'::timestamp), COALESCE(MIN(ca.created_at), '9999-12-31'::timestamp)) as first_app_date,
        MIN(vp.created_at) as profile_created_at
      FROM (
        SELECT DISTINCT vendor_address FROM vendor_profiles
        UNION
        SELECT DISTINCT vendor_address FROM apps
        UNION
        SELECT DISTINCT vendor_address FROM checkout_apps WHERE status = 'active'
        UNION
        SELECT DISTINCT vendor_address FROM subscription_plans
      ) v
      LEFT JOIN vendor_profiles vp ON v.vendor_address = vp.vendor_address
      LEFT JOIN apps a ON v.vendor_address = a.vendor_address
      LEFT JOIN checkout_apps ca ON v.vendor_address = ca.vendor_address AND ca.status = 'active'
      LEFT JOIN subscription_plans sp ON v.vendor_address = sp.vendor_address
      WHERE 1=1
    `;
    const params = [];
    let paramCount = 0;

    if (search) {
      paramCount++;
      query += ` AND v.vendor_address ILIKE $${paramCount}`;
      params.push(`%${search}%`);
    }

    query += ` GROUP BY v.vendor_address, vp.id, vp.name, vp.email, vp.network`;

    const validSortColumns = ['vendor_address', 'total_apps', 'total_plans', 'total_revenue', 'first_plan_date', 'joined_at'];
    let sortColumn = validSortColumns.includes(sortBy) ? sortBy : 'joined_at';
    const sortDirection = sortOrder.toLowerCase() === 'asc' ? 'ASC' : 'DESC';

    // Handle joined_at sorting (use earliest date from plans, apps, checkout apps, or profile)
    if (sortColumn === 'joined_at' || sortColumn === 'first_plan_date') {
      // Use COALESCE to get the earliest date available
      query += ` ORDER BY COALESCE(MIN(sp.created_at), LEAST(MIN(a.created_at), MIN(ca.created_at)), MIN(vp.created_at)) ${sortDirection} LIMIT $${paramCount + 1} OFFSET $${paramCount + 2}`;
    } else {
      query += ` ORDER BY ${sortColumn} ${sortDirection} LIMIT $${paramCount + 1} OFFSET $${paramCount + 2}`;
    }
    params.push(limit, offset);

    const result = await pool.query(query, params);
    
    const countQuery = search
      ? `
        SELECT COUNT(DISTINCT vendor_address) FROM (
          SELECT DISTINCT vendor_address FROM vendor_profiles WHERE vendor_address ILIKE $1
          UNION
          SELECT DISTINCT vendor_address FROM apps WHERE vendor_address ILIKE $1
          UNION
          SELECT DISTINCT vendor_address FROM checkout_apps WHERE vendor_address ILIKE $1 AND status = 'active'
          UNION
          SELECT DISTINCT vendor_address FROM subscription_plans WHERE vendor_address ILIKE $1
        ) v
      `
      : `
        SELECT COUNT(DISTINCT vendor_address) FROM (
          SELECT DISTINCT vendor_address FROM vendor_profiles
          UNION
          SELECT DISTINCT vendor_address FROM apps
          UNION
          SELECT DISTINCT vendor_address FROM checkout_apps WHERE status = 'active'
          UNION
          SELECT DISTINCT vendor_address FROM subscription_plans
        ) v
      `;
    const countParams = search ? [`%${search}%`] : [];
    const countResult = await pool.query(countQuery, countParams);

    // Enrich vendors with additional data
    const enrichedVendors = result.rows.map((v, index) => {
      // Use vendor_profile_id if available, otherwise generate sequential ID
      const vendorId = v.vendor_profile_id 
        ? `V-${v.vendor_profile_id}` 
        : `V-${(parseInt(page) - 1) * parseInt(limit) + index + 1}`;
      
      // Determine joined date: prefer first plan date, then first app date (including checkout apps), then profile created date
      const joinedAt = v.first_plan_date || v.first_app_date || v.profile_created_at;
      
      return {
        vendorId: vendorId,
        vendorAddress: v.vendor_address,
        vendorName: v.vendor_name || null,
        vendorEmail: v.vendor_email || null,
        network: v.vendor_network || 'localhost',
        totalApps: parseInt(v.total_apps) || 0,
        totalPlans: parseInt(v.total_plans) || 0,
        totalRevenue: parseFloat(v.total_revenue) || 0,
        joinedAt: joinedAt
      };
    });

    res.json({
      data: enrichedVendors,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: parseInt(countResult.rows[0].count),
        totalPages: Math.ceil(countResult.rows[0].count / limit)
      }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/admin/customers
 * Get all customers with pagination, search, and sorting
 */
router.get('/customers', async (req, res, next) => {
  try {
    const { page = 1, limit = 25, search = '', sortBy = 'last_active', sortOrder = 'desc' } = req.query;
    const offset = (page - 1) * limit;

    let query = `
      SELECT 
        s.subscriber_address as customer_address,
        COUNT(DISTINCT s.token_id) as subscription_count,
        MAX(s.created_at) as last_active,
        MIN(s.created_at) as first_subscription
      FROM subscriptions s
      WHERE 1=1
    `;
    const params = [];
    let paramCount = 0;

    if (search) {
      paramCount++;
      query += ` AND s.subscriber_address ILIKE $${paramCount}`;
      params.push(`%${search}%`);
    }

    query += ` GROUP BY s.subscriber_address`;

    const validSortColumns = ['customer_address', 'subscription_count', 'last_active', 'first_subscription'];
    const sortColumn = validSortColumns.includes(sortBy) ? sortBy : 'last_active';
    const sortDirection = sortOrder.toLowerCase() === 'asc' ? 'ASC' : 'DESC';

    query += ` ORDER BY ${sortColumn} ${sortDirection} LIMIT $${paramCount + 1} OFFSET $${paramCount + 2}`;
    params.push(limit, offset);

    const result = await pool.query(query, params);
    
    // Enrich with status (active subscriptions)
    const enrichedCustomers = await Promise.all(
      result.rows.map(async (customer) => {
        // Get active subscriptions from blockchain
        let activeCount = 0;
        try {
          const contract = await contractService.getContract();
          const userSubscriptions = await contract.getUserSubscriptions(customer.customer_address);
          for (const tokenId of userSubscriptions) {
            try {
              const subscription = await contract.getSubscription(tokenId);
              const endTime = parseInt(subscription.endTime.toString());
              if (subscription.active && endTime > Math.floor(Date.now() / 1000)) {
                activeCount++;
              }
            } catch (e) {
              // Skip invalid subscriptions
            }
          }
        } catch (e) {
          console.error(`Error fetching active subscriptions for ${customer.customer_address}:`, e.message);
        }
        return {
          customerId: customer.customer_address,
          walletAddress: customer.customer_address,
          subscriptionCount: parseInt(customer.subscription_count),
          lastActive: customer.last_active,
          status: activeCount > 0 ? 'active' : 'inactive'
        };
      })
    );

    const countQuery = search
      ? `SELECT COUNT(DISTINCT subscriber_address) FROM subscriptions WHERE subscriber_address ILIKE $1`
      : `SELECT COUNT(DISTINCT subscriber_address) FROM subscriptions`;
    const countParams = search ? [`%${search}%`] : [];
    const countResult = await pool.query(countQuery, countParams);

    res.json({
      data: enrichedCustomers,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: parseInt(countResult.rows[0].count),
        totalPages: Math.ceil(countResult.rows[0].count / limit)
      }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/admin/maintenance-mode
 * Get current maintenance mode status for all entity types
 */
router.get('/maintenance-mode', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT * FROM maintenance_mode ORDER BY entity_type`
    );

    const maintenanceStatus = {};
    result.rows.forEach(row => {
      maintenanceStatus[row.entity_type] = {
        enabled: row.enabled,
        message: row.message,
        enabledBy: row.enabled_by,
        enabledAt: row.enabled_at,
        disabledAt: row.disabled_at,
        updatedAt: row.updated_at
      };
    });

    res.json({
      success: true,
      data: maintenanceStatus
    });
  } catch (error) {
    console.error('Error fetching maintenance mode status:', error);
    next(error);
  }
});

/**
 * POST /api/admin/maintenance-mode
 * Enable/disable maintenance mode for an entity type
 * Body: { entityType: 'vendor'|'customer'|'api'|'package', enabled: boolean, message?: string }
 */
router.post('/maintenance-mode', async (req, res, next) => {
  try {
    const { entityType, enabled, message } = req.body;
    const enabledBy = req.headers['x-admin-address'] || req.headers['x-vendor-address'] || 'admin';

    if (!entityType || typeof enabled !== 'boolean') {
      return res.status(400).json({
        error: 'Invalid request',
        message: 'entityType and enabled (boolean) are required'
      });
    }

    const validEntityTypes = ['vendor', 'customer', 'api', 'package'];
    if (!validEntityTypes.includes(entityType)) {
      return res.status(400).json({
        error: 'Invalid entity type',
        message: `entityType must be one of: ${validEntityTypes.join(', ')}`
      });
    }

    const defaultMessage = 'System is under maintenance. Please try again later.';
    const maintenanceMessage = message || defaultMessage;

    const now = new Date();

    if (enabled) {
      // Enable maintenance mode
      const result = await pool.query(
        `UPDATE maintenance_mode 
         SET enabled = true, 
             message = $1, 
             enabled_by = $2, 
             enabled_at = $3,
             disabled_at = NULL,
             updated_at = $3
         WHERE entity_type = $4
         RETURNING *`,
        [maintenanceMessage, enabledBy, now, entityType]
      );

      if (result.rows.length === 0) {
        // Create entry if it doesn't exist
        await pool.query(
          `INSERT INTO maintenance_mode (entity_type, enabled, message, enabled_by, enabled_at, updated_at)
           VALUES ($1, true, $2, $3, $4, $4)`,
          [entityType, maintenanceMessage, enabledBy, now]
        );
      }

      res.json({
        success: true,
        message: `Maintenance mode enabled for ${entityType}`,
        data: {
          entityType,
          enabled: true,
          message: maintenanceMessage,
          enabledBy,
          enabledAt: now
        }
      });
    } else {
      // Disable maintenance mode
      const result = await pool.query(
        `UPDATE maintenance_mode 
         SET enabled = false, 
             disabled_at = $1,
             updated_at = $1
         WHERE entity_type = $2
         RETURNING *`,
        [now, entityType]
      );

      if (result.rows.length === 0) {
        // Create entry if it doesn't exist
        await pool.query(
          `INSERT INTO maintenance_mode (entity_type, enabled, disabled_at, updated_at)
           VALUES ($1, false, $2, $2)`,
          [entityType, now]
        );
      }

      res.json({
        success: true,
        message: `Maintenance mode disabled for ${entityType}`,
        data: {
          entityType,
          enabled: false,
          disabledAt: now
        }
      });
    }
  } catch (error) {
    console.error('Error updating maintenance mode:', error);
    next(error);
  }
});

module.exports = router;

