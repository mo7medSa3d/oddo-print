import fs from 'fs';
import path from 'path';

const files = [
  'src/app/actions.ts',
  'src/app/api/agent/discovery/route.ts',
  'src/app/api/agents/[id]/discovered-printers/[deviceId]/provision/route.ts',
  'src/app/api/agents/[id]/discovery/route.ts',
  'src/app/api/auth/forgot-password/route.ts',
  'src/app/api/auth/register/route.ts',
  'src/app/api/auth/verify-email/route.ts',
  'src/app/api/printers/route.ts',
  'src/app/api/team/invitations/route.ts',
  'src/lib/audit.ts',
  'src/lib/print-job-service.ts'
];

for (const file of files) {
  const content = fs.readFileSync(file, 'utf8');
  const libPath = path.resolve('src/lib/nanoid');
  const dirPath = path.dirname(path.resolve(file));
  let relPath = path.relative(dirPath, libPath);
  if (!relPath.startsWith('.')) relPath = './' + relPath;
  
  const newContent = content.replace(/import\s+{\s*nanoid\s*}\s+from\s+['"]nanoid['"];?/, `import { nanoid } from "${relPath}";`);
  fs.writeFileSync(file, newContent);
}
