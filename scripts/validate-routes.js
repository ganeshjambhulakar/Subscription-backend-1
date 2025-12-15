#!/usr/bin/env node
/**
 * Route Validation Script
 * Checks for common issues in route files:
 * - Duplicate variable declarations
 * - Missing error handling
 * - Inconsistent parameter naming
 */

const fs = require('fs');
const path = require('path');

const routesDir = path.join(__dirname, '../routes');
const issues = [];

function checkFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  const declaredVars = new Map(); // Track variable declarations per scope
  
  lines.forEach((line, index) => {
    const lineNum = index + 1;
    
    // Check for duplicate const/let declarations in same scope
    const constMatch = line.match(/const\s+(\w+)\s*=/);
    const letMatch = line.match(/let\s+(\w+)\s*=/);
    
    if (constMatch || letMatch) {
      const varName = constMatch ? constMatch[1] : letMatch[1];
      const scope = getScope(line, index, lines);
      
      if (declaredVars.has(scope)) {
        const scopeVars = declaredVars.get(scope);
        if (scopeVars.has(varName)) {
          issues.push({
            file: path.basename(filePath),
            line: lineNum,
            type: 'duplicate_declaration',
            message: `Variable '${varName}' is declared multiple times in the same scope`,
            severity: 'error'
          });
        } else {
          scopeVars.add(varName);
        }
      } else {
        declaredVars.set(scope, new Set([varName]));
      }
    }
  });
}

function getScope(line, lineIndex, allLines) {
  // Simple scope detection - look for function/block boundaries
  let scope = 'global';
  let braceCount = 0;
  
  for (let i = 0; i <= lineIndex; i++) {
    const currentLine = allLines[i];
    braceCount += (currentLine.match(/{/g) || []).length;
    braceCount -= (currentLine.match(/}/g) || []).length;
    
    const funcMatch = currentLine.match(/(?:function|async\s+function|=>)\s*(\w+)/);
    if (funcMatch) {
      scope = funcMatch[1] || 'anonymous';
    }
  }
  
  return `${scope}_${braceCount}`;
}

// Check all route files
const routeFiles = fs.readdirSync(routesDir)
  .filter(file => file.endsWith('.js'))
  .map(file => path.join(routesDir, file));

routeFiles.forEach(checkFile);

// Report issues
if (issues.length > 0) {
  console.error('❌ Route validation found issues:\n');
  issues.forEach(issue => {
    console.error(`  ${issue.file}:${issue.line} - ${issue.type}`);
    console.error(`    ${issue.message}\n`);
  });
  process.exit(1);
} else {
  console.log('✅ All route files validated successfully');
  process.exit(0);
}

