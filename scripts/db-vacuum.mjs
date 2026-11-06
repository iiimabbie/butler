// Usage: node scripts/db-vacuum.mjs
// Reclaims free pages in .data/butler.sqlite: refuses while a subagent runs, stops Butler, checkpoints and VACUUMs, starts Butler.
// No rows are deleted; model_requests keeps its own 500-row/24-hour limit.
import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.join(root, '.data/butler.sqlite');
const mb = bytes => `${(bytes / 1048576).toFixed(1)}M`;
function systemctl(action) {
  const result = spawnSync('sudo', ['-n', 'systemctl', action, 'butler'], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`systemctl ${action} butler failed`);
}

const check = new DatabaseSync(file, { readOnly: true });
const running = check.prepare("SELECT count(*) AS n FROM subagent_runs WHERE status='running'").get().n;
check.close();
if (running > 0) {
  console.error(`${running} subagent run(s) in progress; stopping Butler would kill them. Try again later.`);
  process.exit(1);
}

const before = statSync(file).size;
systemctl('stop');
try {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA wal_checkpoint(TRUNCATE); VACUUM;');
  db.close();
} finally {
  systemctl('start');
}
console.log(`butler.sqlite ${mb(before)} -> ${mb(statSync(file).size)}; Butler restarted`);
