import path from 'node:path';
import { initDb, getDb } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations/index.js';
import { DATA_DIR } from '../src/config.js';
import { grantRole, hasAnyOwner } from '../src/modules/permissions/db/user-roles.js';

const userId = process.argv[2];
if (!userId) {
  console.error('usage: tsx scripts/seed-owner.ts <user_id>');
  process.exit(1);
}

initDb(path.join(DATA_DIR, 'v2.db'));
runMigrations(getDb());

if (hasAnyOwner()) {
  console.log('owner already exists; not granting');
  process.exit(0);
}

grantRole({
  user_id: userId,
  role: 'owner',
  agent_group_id: null,
  granted_by: null,
  granted_at: new Date().toISOString(),
});

console.log(`granted owner role to ${userId}`);
