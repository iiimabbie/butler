import { spawnSync } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Usage: node scripts/butler-deploy.mjs [channelId]
// Installs .data/deploy/build (built by the bot, or built here when absent), restarts Butler,
// and rolls back to the previous dist when the new build does not become ready.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const channelId = process.argv[2];
const deployDir = path.join(root, '.data/deploy');
const build = path.join(deployDir, 'build');
const previous = path.join(deployDir, 'previous-dist');
const dist = path.join(root, 'dist');
const noticeFile = path.join(deployDir, 'notice.json');
const logFile = path.join(deployDir, 'deploy.log');
const service = path.join(root, 'scripts/butler-service.sh');
await fs.mkdir(deployDir, { recursive: true });
const log = text => fs.appendFile(logFile, `${new Date().toISOString()} ${text}\n`);
const notice = async text => { if (channelId) await fs.writeFile(noticeFile, JSON.stringify({ channelId, text })); };
async function step(label, command, args, env = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', env: { ...process.env, ...env } });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  await log(`${label}: ${result.status === 0 ? 'ok' : 'failed'}${output ? `\n${output}` : ''}`);
  return result.status === 0;
}
async function alert(message) {
  await log(message);
  try {
    const { readConfig } = await import(pathToFileURL(path.join(dist, 'config.js')).href);
    const logger = await import(pathToFileURL(path.join(dist, 'log.js')).href);
    logger.configureLogging(readConfig());
    logger.logError(message);
    await logger.flushLogs();
  } catch (error) { await log(`Alert failed: ${error instanceof Error ? error.message : String(error)}`); }
}

if (!existsSync(build) && !await step('build', process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'), '--outDir', build])) {
  await fs.rm(build, { recursive: true, force: true });
  process.exit(1);
}
if (!await step('stop', 'sh', [service, 'stop'], { BUTLER_SERVICE_TIMEOUT_SECONDS: '900' })) {
  await alert('Deployment could not stop the running Butler');
  process.exit(1);
}
await fs.rm(previous, { recursive: true, force: true });
await fs.rename(dist, previous);
await fs.rename(build, dist);
await notice('部署完成，新版已啟動。');
if (await step('start', 'sh', [service, 'start'])) process.exit(0);
await step('stop new build', 'sh', [service, 'stop']);
await fs.rm(dist, { recursive: true, force: true });
await fs.rename(previous, dist);
await notice('部署失敗：新版未能啟動，已回到舊版。詳見 .data/deploy/deploy.log');
if (await step('start previous build', 'sh', [service, 'start'])) process.exit(1);
await fs.rm(noticeFile, { force: true });
await alert('Deployment failed and the previous build did not start; Butler is down');
process.exit(1);
