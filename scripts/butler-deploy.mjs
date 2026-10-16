import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pruneDeploymentRuns } from './deployment-runs.mjs';

const root = path.resolve(process.env.BUTLER_DEPLOY_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const data = path.join(root, '.data');
const state = path.join(data, 'service');
const deployDir = path.join(data, 'deploy');
const lockFile = path.join(state, 'lock');
const requestId = process.argv[2] === '--locked' ? process.argv[3] : (process.argv[2] || randomUUID());
const lastResultFile = path.join(deployDir, 'last-result.json');
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
if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)) throw new Error('Deployment id must be a safe single path segment');
const runsDir = path.join(deployDir, 'runs');
const runDir = path.join(runsDir, id);
const logFile = path.join(runDir, 'deploy.log');
const resultFile = path.join(runDir, 'result.json');
const startedFile = path.join(runDir, 'runner-started');
const alertFile = path.join(runDir, 'alert.json');
if (await exists(resultFile) || await exists(startedFile)) throw new Error(`Deployment ${id} already started or has a terminal result; runner replay refused`);
await fs.mkdir(runsDir, { recursive: true, mode: 0o700 });
await fs.chmod(runsDir, 0o700);
await fs.mkdir(runDir, { recursive: false, mode: 0o700 });
await fs.chmod(runDir, 0o700);
await writeAtomic(startedFile, JSON.stringify({ id, pid: process.pid, startedAt: new Date().toISOString() }));
await fs.mkdir(state, { recursive: true, mode: 0o700 });
await fs.chmod(state, 0o700);
const temp = path.join(runDir, 'build');
const backup = path.join(deployDir, 'previous-dist');
const candidate = path.join(root, 'dist');
let oldDistMoved = false;
let candidateInstalled = false;
let oldStopped = false;
let stopAttempted = false;
let candidateStartAttempted = false;
let rollbackStatus = 'not_needed';
let previousBuild = { buildId: 'legacy-unverified', buildDigest: 'unknown', verified: false };
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
  const buildManifest = { buildId: id, buildDigest: originalDigest, createdAt: new Date().toISOString() };
  await writeAtomic(path.join(temp, 'build-manifest.json'), JSON.stringify(buildManifest));
  const nonce = `${id}:${process.pid}`;
  const appPid = Number(String(await fs.readFile(path.join(state, 'app.pid'), 'utf8')).trim());
  if (!Number.isSafeInteger(appPid) || appPid <= 1) throw new Error('Running bot PID is unavailable; deploy refused');
  await fs.rm(path.join(state, 'deploy-quiesced.json'), { force: true });
  await writeAtomic(path.join(state, 'deploy-request.json'), JSON.stringify({ id, pid: appPid, workerPid: process.pid, nonce }));
  await writeAtomic(path.join(state, 'deploy-candidate-ready'), id);
  await log(`Waiting for bot quiescence request ${id}`);
  let ready = false;
  const quiescePolls = Number(process.env.BUTLER_DEPLOY_QUIESCE_POLLS ?? 600);
  const quiesceDelayMs = Number(process.env.BUTLER_DEPLOY_QUIESCE_DELAY_MS ?? 1000);
  for (let n = 0; n < quiescePolls; n++) {
    try { const marker = JSON.parse(await fs.readFile(path.join(state, 'deploy-quiesced.json'), 'utf8')); if (marker.id === id && marker.nonce === nonce && marker.pid === appPid) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, quiesceDelayMs));
  }
  if (!ready) throw new Error('Bot did not quiesce within 10 minutes; deployment cancelled');
  sourceFiles = await listBuildInputs();
  if (await digest(sourceFiles) !== originalDigest || createHash('sha256').update(await fs.readFile(packageLock)).digest('hex') !== lockDigest || createHash('sha256').update(await fs.readFile(path.join(root, 'package.json'))).digest('hex') !== packageDigest) throw new Error('Build inputs changed while waiting for quiescence; deployment cancelled');
  const distStat = await fs.stat(candidate);
  if (!distStat.isDirectory()) throw new Error('Current dist is missing');
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(candidate, 'build-manifest.json'), 'utf8'));
    if (typeof manifest.buildId === 'string' && typeof manifest.buildDigest === 'string') previousBuild = { buildId: manifest.buildId, buildDigest: manifest.buildDigest, verified: true };
  } catch { /* Legacy backup remains recoverable but cannot be claimed verified. */ }
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
  await command(['sh', service, 'deploy-start'], { BUTLER_BUILD_ID: id, BUTLER_BUILD_DIGEST: originalDigest, BUTLER_EXPECTED_BUILD_ID: id, BUTLER_EXPECTED_BUILD_DIGEST: originalDigest });
  const readyEvidence = await readReadyEvidence(id, originalDigest);
  if (!readyEvidence.verified) throw new Error('New service ready evidence did not match the requested build ID, digest, and app PID');
  await writeAtomic(path.join(deployDir, 'baseline.json'), JSON.stringify({ lockDigest, packageDigest, buildDigest: originalDigest, updatedAt: new Date().toISOString() }));
  await fs.rm(path.join(state, 'deploy-quiesced.json'), { force: true });
  const result = JSON.stringify({ id, status: 'completed', at: new Date().toISOString(), buildId: id, buildDigest: originalDigest, readyEvidence: { verified: true, pid: readyEvidence.pid }, log: logFile });
  await writeAtomic(resultFile, result);
  await writeAtomic(lastResultFile, result);
  await log('Deployment completed and ready');
} catch (error) {
  if (oldDistMoved && await exists(backup)) {
    if (!candidateInstalled) {
      await fs.rename(backup, candidate);
      rollbackStatus = 'restored';
      oldDistMoved = false;
    } else if (!stopAttempted) {
      if (candidateInstalled) await fs.rm(candidate, { recursive: true, force: true });
      await fs.rename(backup, candidate);
      rollbackStatus = 'restored';
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
        try {
          await command(['sh', service, 'deploy-start'], previousBuild.verified ? { BUTLER_EXPECTED_BUILD_ID: previousBuild.buildId, BUTLER_EXPECTED_BUILD_DIGEST: previousBuild.buildDigest } : { BUTLER_ALLOW_LEGACY_READY: '1' });
          const rollbackEvidence = await readReadyEvidence(previousBuild.verified ? previousBuild.buildId : undefined, previousBuild.verified ? previousBuild.buildDigest : undefined);
          const legacyReady = rollbackEvidence.ready === true && rollbackEvidence.liveness === 'ready' && rollbackEvidence.pid > 1 && rollbackEvidence.alive;
          const expectedIdentityMatches = previousBuild.verified && rollbackEvidence.buildId === previousBuild.buildId && rollbackEvidence.buildDigest === previousBuild.buildDigest;
          if (previousBuild.verified && !rollbackEvidence.verified && !(legacyReady && expectedIdentityMatches)) throw new Error('Rollback build identity/readiness evidence mismatch');
          if (!previousBuild.verified && !legacyReady) throw new Error('Legacy rollback readiness evidence unavailable');
          rollbackStatus = previousBuild.verified && rollbackEvidence.verified ? 'restored_and_verified' : 'restored_and_started_legacy_unverified';
        } catch (restoreError) { rollbackStatus = 'restored_start_failed'; await log(`Rollback start failed: ${restoreError.message}`); }
      }
    }
  }
  await fs.rm(temp, { recursive: true, force: true });
  await fs.rm(path.join(state, 'deploy-request.json'), { force: true });
  await fs.rm(path.join(state, 'deploy-candidate-ready'), { force: true });
  await fs.rm(path.join(state, 'deploy-quiesced.json'), { force: true });
  await log(`Deployment failed: ${error.message}`);
  const resultRecord = { id, status: 'failed', phase: candidateStartAttempted ? 'candidate_start' : stopAttempted ? 'service_stop_or_start' : candidateInstalled ? 'install' : 'build_or_quiesce', error: error.message, rollback: oldDistMoved ? 'incomplete_or_refused' : rollbackStatus, rollbackBuild: previousBuild, at: new Date().toISOString(), log: logFile,
    alert_status: oldDistMoved || rollbackStatus === 'restored_start_failed' ? 'pending' : 'not_required' };
  await writeAtomic(resultFile, JSON.stringify(resultRecord));
  await writeAtomic(lastResultFile, JSON.stringify(resultRecord));
  if (resultRecord.alert_status === 'pending') await sendEmergencyFailureAlert(resultRecord);
  process.exitCode = 1;
}
try {
  const protectedIds = new Set([id]);
  try {
    const latest = JSON.parse(await fs.readFile(lastResultFile, 'utf8'));
    if (typeof latest.id === 'string') protectedIds.add(latest.id);
  } catch {}
  const database = path.join(data, 'butler.sqlite');
  try {
    await fs.access(database);
    const db = new DatabaseSync(database, { readOnly: true });
    try {
      for (const row of db.prepare("SELECT id FROM deployment_requests WHERE status IN ('queued','running','needs_reconciliation')").all()) {
        if (typeof row.id === 'string') protectedIds.add(row.id);
      }
    } finally { db.close(); }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await pruneDeploymentRuns(deployDir, [...protectedIds]);
} catch (error) { console.warn(`Deployment run pruning skipped: ${error instanceof Error ? error.message : String(error)}`); }
async function exists(file) { try { await fs.access(file); return true; } catch { return false; } }
async function readReadyEvidence(expectedBuildId, expectedBuildDigest) {
  const rawEvidence = await fs.readFile(path.join(state, 'butler.ready'), 'utf8');
  const liveness = String(await fs.readFile(path.join(state, 'butler.liveness'), 'utf8')).trim();
  const appPid = Number(String(await fs.readFile(path.join(state, 'app.pid'), 'utf8')).trim());
  let evidence;
  try { evidence = JSON.parse(rawEvidence); }
  catch (error) {
    if (expectedBuildId !== undefined || expectedBuildDigest !== undefined || rawEvidence.trim() !== 'ready' || liveness !== 'ready') throw error;
    let alive = false; try { process.kill(appPid, 0); alive = appPid > 1; } catch {}
    return { ready: alive, pid: appPid, alive, legacy: true, verified: false, liveness };
  }
  let alive = false;
  try { process.kill(appPid, 0); alive = Number.isSafeInteger(appPid) && appPid > 1; } catch {}
  const verified = liveness === 'ready' && evidence.ready === true && typeof evidence.startupId === 'string' && evidence.startupId.length > 0 && evidence.buildId === expectedBuildId && evidence.buildDigest === expectedBuildDigest && evidence.pid === appPid && alive;
  return { ...evidence, liveness, alive, verified };
}
async function sendEmergencyFailureAlert(result) {
  // The terminal deployment result is immutable; alert delivery has a separate intent/outcome record.
  await writeAtomic(alertFile, JSON.stringify({ id: result.id, status: 'attempted_unknown', at: new Date().toISOString() }));
  try {
    const configModule = await import(pathToFileURL(path.join(root, 'dist/config.js')).href).catch(() => import(pathToFileURL(path.join(deployDir, 'previous-dist/config.js')).href));
    const loggerModule = await import(pathToFileURL(path.join(root, 'dist/log.js')).href).catch(() => import(pathToFileURL(path.join(deployDir, 'previous-dist/log.js')).href));
    const { readConfig } = configModule, logger = loggerModule;
    logger.configureLogging(readConfig());
    let settle;
    const delivered = new Promise(resolve => { settle = resolve; });
    logger.logError('Deployment failed; service unavailable', undefined, { deduplicationKey: `deployment-unavailable:${result.id}`, fields: { deployment_id: result.id, status: 'failed', phase: result.phase }, onNotifySettled: settle });
    await logger.flushLogs();
    result.alert_status = await delivered ? 'delivered' : 'failed';
  } catch (alertError) { result.alert_status = 'failed'; await log(`Emergency alert setup failed: ${alertError instanceof Error ? alertError.message : 'unknown error'}`); }
  await writeAtomic(alertFile, JSON.stringify({ id: result.id, status: result.alert_status, at: new Date().toISOString() }));
}

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
