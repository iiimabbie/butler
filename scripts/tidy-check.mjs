// Usage: node scripts/tidy-check.mjs [--apply]
// Reports anything in the project tree that breaks the layout in docs/project-tidy.md.
// Read-only by default; --apply deletes only Python caches (__pycache__, *.pyc). Everything else needs a decision.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const apply = process.argv.includes('--apply');
const DAY = 24 * 60 * 60 * 1000, RETENTION_DAYS = 30, CURATION_WORK_DAYS = 45;
// Ignored paths that belong in the tree; anything else git ignores is a leftover.
const IGNORED_OK = new Set(['.codegraph/', '.data/', 'backups/', 'dist/', 'node_modules/', 'services/hindsight/.env', 'workspace/']);
const DATA_OK = new Set(['alloy', 'attachments', 'butler.sqlite', 'butler.sqlite-shm', 'butler.sqlite-wal', 'channel-names.json', 'config', 'config.yaml', 'deploy', 'google', 'hledger', 'private', 'service', 'steam-freebies', 'subagent']);
// Names that look like a backup or trash; they belong under backups/ only.
const BACKUP_NAME = /(^|[-_.])(backups?|bak|trash|snapshots?|orig|old)([-_.]|$)|~$/i;
const SKIP_DIRS = new Set(['.git', 'node_modules', 'backups', 'dist', '.codegraph', 'hindsight-docs']);

const findings = [];
const report = (section, text) => findings.push(`[${section}] ${text}`);
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' });
const rel = p => path.relative(root, p);
const mb = bytes => `${(bytes / 1048576).toFixed(1)}M`;
function size(p) {
  const s = statSync(p);
  return s.isDirectory() ? readdirSync(p).reduce((sum, name) => sum + size(path.join(p, name)), 0) : s.size;
}
function walk(dir, visit) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (visit(full, entry) === false || !entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue;
    walk(full, visit);
  }
}

// 1. Leftovers git does not know about.
for (const line of git(root, 'status', '--porcelain', '--ignored').split('\n').filter(Boolean)) {
  const [code, file] = [line.slice(0, 2), line.slice(3)];
  if (code === '??') report('untracked', `${file} (commit it, move it, or delete it)`);
  if (code === '!!' && !IGNORED_OK.has(file) && !file.includes('__pycache__')) report('ignored-leftover', file);
}
for (const line of git(path.join(root, 'workspace'), 'status', '--porcelain').split('\n').filter(Boolean)) {
  if (line.startsWith('??')) report('workspace-untracked', `workspace/${line.slice(3)}`);
}

// 2. Unexpected entries in .data/.
for (const name of readdirSync(path.join(root, '.data'))) if (!DATA_OK.has(name)) report('data', `.data/${name} is not part of the runtime layout`);
for (const name of ['build', 'previous-dist']) {
  if (existsSync(path.join(root, '.data/deploy', name))) report('data', `.data/deploy/${name} is left over from an unfinished deploy`);
}

// 3. Python caches (removed by --apply) and backups outside backups/.
walk(root, (full, entry) => {
  if (entry.name === '__pycache__' || entry.name.endsWith('.pyc')) {
    if (apply) rmSync(full, { recursive: true, force: true });
    report('pycache', `${rel(full)}${apply ? ' (deleted)' : ''}`);
    return false;
  }
  if (!SKIP_DIRS.has(entry.name) && BACKUP_NAME.test(entry.name)) report('backup-outside', `${rel(full)} (move under backups/<source>/)`);
});

// 4. Retention under backups/: these are pruned automatically, so anything older means the prune is not running.
for (const dir of ['skills-trash', 'memory-curation']) {
  const base = path.join(root, 'backups', dir);
  if (!existsSync(base)) continue;
  for (const name of readdirSync(base)) {
    const stamp = dir === 'skills-trash' ? Number(/-(\d+)$/.exec(name)?.[1]) : Date.parse(/^\d{4}-\d{2}-\d{2}/.exec(name)?.[0] ?? '');
    if (Number.isFinite(stamp) && Date.now() - stamp > RETENTION_DAYS * DAY) report('retention', `backups/${dir}/${name} is older than ${RETENTION_DAYS} days`);
  }
}
const work = path.join(root, 'workspace/memory-curation/work');
if (existsSync(work)) for (const name of readdirSync(work)) {
  const day = /^(?:monthly-)?(\d{4}-\d{2}-\d{2})/.exec(name)?.[1];
  if (!day) report('curation-work', `workspace/memory-curation/work/${name} has no date prefix (one-off file?)`);
  else if (Date.now() - Date.parse(day) > (CURATION_WORK_DAYS + 1) * DAY) report('retention', `workspace/memory-curation/work/${name} is older than ${CURATION_WORK_DAYS} days`);
}

// 5. Things that grow: log rotation, database.
const rotate = '/etc/logrotate.d/butler';
if (!existsSync(rotate)) report('log', `${rotate} is missing; install scripts/butler.logrotate`);
else if (readFileSync(rotate, 'utf8') !== readFileSync(path.join(root, 'scripts/butler.logrotate'), 'utf8')) report('log', `${rotate} differs from scripts/butler.logrotate`);
const log = path.join(root, '.data/service/butler.log');
if (existsSync(log) && statSync(log).size > 50 * 1048576) report('log', `butler.log is ${mb(statSync(log).size)}; check that logrotate runs`);
const db = new DatabaseSync(path.join(root, '.data/butler.sqlite'), { readOnly: true });
const pageSize = db.prepare('PRAGMA page_size').get().page_size, free = db.prepare('PRAGMA freelist_count').get().freelist_count * pageSize;
const requests = db.prepare('SELECT count(*) AS n FROM model_requests').get().n;
db.close();
if (free > 50 * 1048576) report('database', `${mb(free)} reclaimable; run the VACUUM procedure in docs/project-tidy.md`);

console.log(`project ${mb(size(path.join(root, '.data')))} .data, ${mb(existsSync(path.join(root, 'backups')) ? size(path.join(root, 'backups')) : 0)} backups, ${mb(size(path.join(root, 'workspace')))} workspace; database free ${mb(free)}, model_requests ${requests}`);
for (const dir of existsSync(path.join(root, 'backups')) ? readdirSync(path.join(root, 'backups')) : []) console.log(`  backups/${dir} ${mb(size(path.join(root, 'backups', dir)))}`);
console.log(findings.length ? findings.join('\n') : 'clean');
