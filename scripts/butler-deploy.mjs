import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = path.join(root, '.data');
const state = path.join(data, 'service');
const deployDir = path.join(data, 'deploy');
const lockFile = path.join(state, 'lock');
const requestId = process.argv[2] === '--locked' ? process.argv[3] : randomUUID();
const logFile = path.join(deployDir, `${requestId}.log`);
const resultFile = path.join(deployDir, 'last-result.json');
const node = process.env.BUTLER_NODE || process.execPath;
const service = path.join(root, 'scripts/butler-service.sh');
const packageLock = path.join(root, 'package-lock.json');
let sourceFiles = await listBuildInputs();
await fs.mkdir(deployDir, { recursive: true, mode: 0o700 });
await fs.chmod(deployDir, 0o700);
await fs.mkdir(state, { recursive: true, mode: 0o700 });
await fs.chmod(state, 0o700);
const log = async text => fs.appendFile(logFile, `${new Date().toISOString()} ${text}\n`, { mode: 0o600 });
const digest = async files => {
  const hash = createHash('sha256');
  for (const file of files) { hash.update(file); hash.update('\0'); hash.update(await fs.readFile(path.join(root, file))); hash.update('\0'); }
  return hash.digest('hex');
};
if (process.argv[2] === '--record-baseline') {
  const lockDigest = createHash('sha256').update(await fs.readFile(packageLock)).digest('hex');
  const packageDigest = createHash('sha256').update(await fs.readFile(path.join(root, 'package.json'))).digest('hex');
  await writeAtomic(path.join(deployDir, 'baseline.json'), JSON.stringify({ lockDigest, packageDigest, recordedAt: new Date().toISOString() }));
  process.exit(0);
}
if (process.argv[2] !== '--locked') {
  const locked = spawnSync('flock', ['-n', lockFile, node, fileURLToPath(import.meta.url), '--locked', requestId], { cwd: root, stdio: 'inherit', env: process.env });
  if (locked.error) throw locked.error;
  process.exit(locked.status ?? 1);
}
const id = process.argv[3];
await fs.mkdir(state, { recursive: true, mode: 0o700 });
await fs.chmod(state, 0o700);
const temp = path.join(deployDir, `dist-${id}`);
const backup = path.join(deployDir, 'previous-dist');
const candidate = path.join(root, 'dist');
let oldDistMoved = false;
let candidateInstalled = false;
let oldStopped = false;
let stopAttempted = false;
let candidateStartAttempted = false;
let originalDigest;
let lockDigest;
let packageDigest;
async function command(args, env = {}) {
  const result = spawnSync(args[0], args.slice(1), { cwd: root, encoding: 'utf8', env: { ...process.env, BUTLER_DEPLOY_LOCKED: '1', ...env } });
  if (result.stdout) await log(result.stdout.trim());
  if (result.stderr) await log(result.stderr.trim());
  if (result.status !== 0) throw new Error(`${args.join(' ')} failed (${result.status ?? result.error})`);
}
try {
  originalDigest = await digest(sourceFiles);
  lockDigest = createHash('sha256').update(await fs.readFile(packageLock)).digest('hex');
  packageDigest = createHash('sha256').update(await fs.readFile(path.join(root, 'package.json'))).digest('hex');
  const baselineFile = path.join(deployDir, 'baseline.json');
  try {
    const baseline = JSON.parse(await fs.readFile(baselineFile, 'utf8'));
    if (baseline.lockDigest !== lockDigest || baseline.packageDigest !== packageDigest) throw new Error('package.json or package-lock.json changed since the running build; automatic deploy refused');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await fs.rm(temp, { recursive: true, force: true });
  await fs.mkdir(temp, { recursive: true });
  await command([node, path.join(root, 'node_modules/typescript/bin/tsc'), '--outDir', temp]);
  sourceFiles = await listBuildInputs();
  if (await digest(sourceFiles) !== originalDigest || createHash('sha256').update(await fs.readFile(packageLock)).digest('hex') !== lockDigest || createHash('sha256').update(await fs.readFile(path.join(root, 'package.json'))).digest('hex') !== packageDigest) throw new Error('Build inputs changed during build; deploy cancelled');
  const nonce = `${id}:${process.pid}`;
  const appPid = Number(String(await fs.readFile(path.join(state, 'app.pid'), 'utf8')).trim());
  if (!Number.isSafeInteger(appPid) || appPid <= 1) throw new Error('Running bot PID is unavailable; deploy refused');
  await fs.rm(path.join(state, 'deploy-quiesced.json'), { force: true });
  await writeAtomic(path.join(state, 'deploy-request.json'), JSON.stringify({ id, pid: appPid, workerPid: process.pid, nonce }));
  await writeAtomic(path.join(state, 'deploy-candidate-ready'), id);
  await log(`Waiting for bot quiescence request ${id}`);
  let ready = false;
  for (let n = 0; n < 600; n++) {
    try { const marker = JSON.parse(await fs.readFile(path.join(state, 'deploy-quiesced.json'), 'utf8')); if (marker.id === id && marker.nonce === nonce && marker.pid === appPid) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  if (!ready) throw new Error('Bot did not quiesce within 10 minutes; deployment cancelled');
  sourceFiles = await listBuildInputs();
  if (await digest(sourceFiles) !== originalDigest || createHash('sha256').update(await fs.readFile(packageLock)).digest('hex') !== lockDigest || createHash('sha256').update(await fs.readFile(path.join(root, 'package.json'))).digest('hex') !== packageDigest) throw new Error('Build inputs changed while waiting for quiescence; deployment cancelled');
  const distStat = await fs.stat(candidate);
  if (!distStat.isDirectory()) throw new Error('Current dist is missing');
  await fs.rm(backup, { recursive: true, force: true });
  await fs.rename(candidate, backup);
  oldDistMoved = true;
  await fs.rename(temp, candidate);
  candidateInstalled = true;
  stopAttempted = true;
  await command(['sh', service, 'deploy-stop']);
  oldStopped = true;
  await fs.rm(path.join(state, 'deploy-candidate-ready'), { force: true });
  await fs.rm(path.join(state, 'deploy-request.json'), { force: true });
  candidateStartAttempted = true;
  await command(['sh', service, 'deploy-start']);
  await writeAtomic(path.join(deployDir, 'baseline.json'), JSON.stringify({ lockDigest, packageDigest, buildDigest: originalDigest, updatedAt: new Date().toISOString() }));
  await fs.rm(path.join(state, 'deploy-quiesced.json'), { force: true });
  await fs.writeFile(resultFile, JSON.stringify({ id, status: 'completed', at: new Date().toISOString(), log: logFile }), { mode: 0o600 });
  await log('Deployment completed and ready');
} catch (error) {
  if (oldDistMoved && await exists(backup)) {
    if (!candidateInstalled) {
      await fs.rename(backup, candidate);
      oldDistMoved = false;
    } else if (!stopAttempted) {
      if (candidateInstalled) await fs.rm(candidate, { recursive: true, force: true });
      await fs.rename(backup, candidate);
      oldDistMoved = false;
      candidateInstalled = false;
    } else if (!oldStopped) {
      await log('Could not confirm old bot stopped; preserving candidate files and refusing rollback/start');
    } else {
      let candidateStopped = !candidateStartAttempted;
      if (candidateStartAttempted) {
        try { await command(['sh', service, 'deploy-stop']); candidateStopped = true; }
        catch (stopError) { await log(`Could not confirm candidate stopped; refusing rollback start: ${stopError.message}`); }
      }
      if (candidateStopped) {
        await fs.rm(candidate, { recursive: true, force: true });
        await fs.rename(backup, candidate);
        oldDistMoved = false;
        candidateInstalled = false;
        try { await command(['sh', service, 'deploy-start']); }
        catch (restoreError) { await log(`Rollback start failed: ${restoreError.message}`); }
      }
    }
  }
  await fs.rm(temp, { recursive: true, force: true });
  await fs.rm(path.join(state, 'deploy-request.json'), { force: true });
  await fs.rm(path.join(state, 'deploy-candidate-ready'), { force: true });
  await fs.rm(path.join(state, 'deploy-quiesced.json'), { force: true });
  await log(`Deployment failed: ${error.message}`);
  await fs.writeFile(resultFile, JSON.stringify({ id, status: 'failed', error: error.message, at: new Date().toISOString(), log: logFile }), { mode: 0o600 });
  process.exitCode = 1;
}
async function exists(file) { try { await fs.access(file); return true; } catch { return false; } }
async function writeAtomic(file, content) {
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, content, { mode: 0o600 });
  await fs.rename(temporary, file);
}
async function listBuildInputs() {
  const files = [];
  async function visit(dir) {
    for (const entry of await fs.readdir(path.join(root, dir), { withFileTypes: true })) {
      const relative = path.posix.join(dir, entry.name);
      if (entry.isDirectory()) { if (!['node_modules', 'dist', '.data', '.git'].includes(entry.name)) await visit(relative); }
      else if (entry.isFile() && (relative.endsWith('.ts') || relative === 'tsconfig.json' || relative === 'package.json')) files.push(relative);
    }
  }
  await visit('src');
  files.push('tsconfig.json', 'package.json', 'package-lock.json');
  return [...new Set(files)].sort();
}
