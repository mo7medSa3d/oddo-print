const fs = require('fs');
let code = fs.readFileSync('src/db/schema.ts', 'utf8');

code = code.replace(
  /tenantId: text\("tenant_id"\)\.references\(\(\) => tenants\.id\)\.notNull\(\),/g,
  (match, offset) => {
    // We only want to replace for managerSessions and tenantInvitations
    // Let's do it specifically
    return match;
  }
);

fs.writeFileSync('src/db/schema.ts', code);
