const { Pool } = require('pg');
const { isAdmin } = require('./adminAuth');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

/**
 * Maintenance Mode Middleware
 * Checks if maintenance mode is enabled for the requested entity type
 * Allows admin bypass if user is authenticated as admin
 */
function checkMaintenanceMode(entityType) {
  return async (req, res, next) => {
    try {
      // Check if user is admin - admins can bypass maintenance mode
      if (isAdmin(req)) {
        return next();
      }

      // Check maintenance mode status for the entity type
      const result = await pool.query(
        `SELECT enabled, message FROM maintenance_mode WHERE entity_type = $1`,
        [entityType]
      );

      if (result.rows.length > 0 && result.rows[0].enabled) {
        // Maintenance mode is enabled - block the request
        return res.status(503).json({
          error: 'Maintenance Mode Active',
          message: result.rows[0].message || 'System is under maintenance. Please try again later.',
          entityType: entityType,
          maintenanceEnabled: true,
          retryAfter: null
        });
      }

      // Maintenance mode is not enabled or doesn't exist - allow request
      next();
    } catch (error) {
      console.error('Error checking maintenance mode:', error);
      // On error, allow request to proceed (fail open)
      // Log the error for monitoring
      next();
    }
  };
}

/**
 * Middleware factory for multiple entity types
 * Checks if any of the specified entity types are in maintenance mode
 */
function checkMaintenanceModeMultiple(entityTypes) {
  return async (req, res, next) => {
    try {
      // Check if user is admin - admins can bypass maintenance mode
      if (isAdmin(req)) {
        return next();
      }

      // Check maintenance mode status for all entity types
      const placeholders = entityTypes.map((_, i) => `$${i + 1}`).join(', ');
      const result = await pool.query(
        `SELECT entity_type, enabled, message FROM maintenance_mode 
         WHERE entity_type IN (${placeholders}) AND enabled = true`,
        entityTypes
      );

      if (result.rows.length > 0) {
        // At least one entity type is in maintenance mode
        const maintenanceInfo = result.rows[0]; // Use first enabled maintenance mode
        return res.status(503).json({
          error: 'Maintenance Mode Active',
          message: maintenanceInfo.message || 'System is under maintenance. Please try again later.',
          entityType: maintenanceInfo.entity_type,
          maintenanceEnabled: true,
          retryAfter: null
        });
      }

      // No maintenance mode enabled - allow request
      next();
    } catch (error) {
      console.error('Error checking maintenance mode:', error);
      // On error, allow request to proceed (fail open)
      next();
    }
  };
}

module.exports = {
  checkMaintenanceMode,
  checkMaintenanceModeMultiple
};

