# Route Development Guide

## ⚠️ Common Pitfalls to Avoid

### 1. Duplicate Variable Declarations

**❌ WRONG:**
```javascript
router.get('/endpoint', async (req, res, next) => {
  const { network } = req.query;  // Line 1: Declares 'network'
  
  // ... some code ...
  
  const network = await getNetworkFromRequest(req);  // Line 50: ERROR! 'network' already declared
});
```

**✅ CORRECT:**
```javascript
router.get('/endpoint', async (req, res, next) => {
  const { network: queryNetwork } = req.query;  // Rename during destructuring
  
  // ... some code ...
  
  const vendorNetwork = queryNetwork || await getNetworkFromRequest(req);  // Use different name
});
```

**OR:**
```javascript
router.get('/endpoint', async (req, res, next) => {
  const { network } = req.query;
  
  // ... some code ...
  
  // Reuse the existing variable, don't redeclare
  const finalNetwork = network || await getNetworkFromRequest(req);
});
```

### 2. Variable Naming Convention

When working with network parameters:
- **Query param**: `network` (from `req.query`)
- **Final resolved value**: `vendorNetwork` or `targetNetwork`
- **Helper function result**: Use different name or reuse existing

### 3. Parameter Count Management

**❌ WRONG:**
```javascript
let paramCount = 1;
// ... some code ...
let paramCount = 1;  // ERROR! Already declared
```

**✅ CORRECT:**
```javascript
let paramCount = 1;
// ... some code ...
// Reuse paramCount, don't redeclare
if (someCondition) {
  paramCount++;
  query += ` AND field = $${paramCount}`;
}
```

## Best Practices

1. **Always check for existing variable names** before declaring new ones
2. **Use descriptive variable names** that indicate their source (e.g., `queryNetwork`, `vendorNetwork`)
3. **Reuse variables** when possible instead of redeclaring
4. **Run linter** before committing: `npm run lint`
5. **Test routes** after changes: `curl http://localhost:3001/health`

## Quick Checklist

Before committing route changes:
- [ ] No duplicate variable declarations in same scope
- [ ] All variables have unique, descriptive names
- [ ] Network parameter handling is consistent
- [ ] Error handling is present
- [ ] Backend starts without syntax errors

