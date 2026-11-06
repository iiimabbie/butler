// Read-only post-deploy report. Usage: node scripts/deploy-check.mjs
import { spawnSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const data = name => fileURLToPath(new URL(`../.data/${name}`, import.meta.url));
const problems = [];
const redact = text => text
  .replace(/\bBearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
  .replace(/\b[\w-]*(?:token|secret|api[_-]?key)[\w-]*["']?\s*[:=]\s*(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]+)/gi, '[REDACTED]')
  .replace(/\b(?:ya29\.[\w.-]+|sk-[\w-]{8,})/g, '[REDACTED]');
const short = text => { const value = redact(text); return value.length > 200 ? `${value.slice(0, 199)}…` : value; };
function systemctl(args) {
  const result = spawnSync('systemctl', args, {
    encoding: 'utf8', timeout: 10_000, env: { ...process.env, TZ: 'UTC' },
  });
  if (result.error || (result.status !== 0 && args[0] !== 'is-active')) {
    problems.push(`Could not read systemctl ${args[0]}`);
  }
  return result.stdout?.trim() ?? '';
}
async function lines(name, visit) {
  const input = createReadStream(data(name), { encoding: 'utf8' });
  const reader = createInterface({ input, crlfDelay: Infinity });
  try { for await (const line of reader) visit(line); }
  catch { problems.push(`Could not read .data/${name}`); }
  finally { reader.close(); input.destroy(); }
}

const active = systemctl(['is-active', 'butler']);
const entered = systemctl(['show', 'butler', '-p', 'ActiveEnterTimestamp', '--value']);
const started = Date.parse(entered);
if (!Number.isFinite(started)) problems.push('Service start timestamp is unavailable');
console.log(`Service: ${active || 'unknown'}; ActiveEnterTimestamp: ${entered || 'unavailable'}`);

// A build is optional when the deployment uses an already staged build. The next
// build or stop after a previous stop starts a new run; rollback steps stay in it.
let deploy = [];
await lines('deploy/deploy.log', line => {
  const match = /^(\S+) (build|stop|start|stop new build|start previous build): (ok|failed)$/.exec(line);
  if (!match) return;
  const label = match[2];
  if (label === 'build' || (label === 'stop' && deploy.some(step => step.label !== 'build'))) deploy = [];
  deploy.push({ label, line });
});
console.log('Last deploy:');
if (deploy.length) for (const step of deploy) console.log(`  ${short(step.line)}`);
else console.log('  No recorded build/stop/start outcome');

const counts = { ERROR: 0, WARN: 0 };
const recent = { ERROR: [], WARN: [] };
let ready = false, retention;
await lines('service/butler.log', line => {
  const match = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) \| (INFO|WARN|ERROR) \| ([^|]*)(?: \||$)/.exec(line);
  if (!match) return;
  const event = match[3].trim();
  if (event === 'Retention completed') retention = short(line);
  // Butler logs in Asia/Taipei with second precision, independently of host TZ.
  const timestamp = Date.parse(`${match[1].replace(' ', 'T')}+08:00`);
  if (!Number.isFinite(started) || timestamp < Math.floor(started / 1000) * 1000) return;
  if (event === 'Discord ready') ready = true;
  const level = match[2];
  if (level === 'ERROR' || level === 'WARN') {
    counts[level]++;
    recent[level].push(short(line));
    if (recent[level].length > 10) recent[level].shift();
  }
});
console.log(`Since service start: Discord ready=${ready ? 'yes' : 'no'}; ERROR=${counts.ERROR}; WARN=${counts.WARN}`);
for (const level of ['ERROR', 'WARN']) {
  if (recent[level].length) console.log(`Last ${recent[level].length} ${level} lines:\n${recent[level].map(line => `  ${line}`).join('\n')}`);
}
console.log(`Latest retention (whole log): ${retention ?? 'not found'}`);

let db;
try {
  db = new DatabaseSync(data('butler.sqlite'), { readOnly: true });
  const running = db.prepare("select id,status from subagent_runs where status='running'").all();
  console.log(`Running subagents: ${running.length}`);
  for (const row of running) console.log(`  ${short(row.id)} ${row.status}`);
} catch { problems.push('Could not read running subagents from .data/butler.sqlite'); }
finally { db?.close(); }
for (const problem of problems) console.log(`Check unavailable: ${problem}`);
process.exitCode = active !== 'active' || !ready || counts.ERROR > 0 || problems.length > 0 ? 1 : 0;
