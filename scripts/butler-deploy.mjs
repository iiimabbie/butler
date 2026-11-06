import { spawnSync } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Usage: node scripts/butler-deploy.mjs [channelId]
// Installs .data/deploy/build (built by the bot, or built here when absent), restarts the butler
// systemd unit, and rolls back to the previous dist when the new build does not become ready.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const channelId = process.argv[2];
const deployDir = path.join(root, '.data/deploy');
const build = path.join(deployDir, 'build');
const previous = path.join(deployDir, 'previous-dist');
const dist = path.join(root, 'dist');
const logFile = path.join(deployDir, 'deploy.log');
await fs.mkdir(deployDir, { recursive: true });
const log = text => fs.appendFile(logFile, `${new Date().toISOString()} ${text}\n`);
// The started Butler posts this notice to the requesting channel.
function notice(text) {
  if (!channelId) return;
  const db = new DatabaseSync(path.join(root, '.data/butler.sqlite'));
  try {
    db.exec('PRAGMA busy_timeout=5000');
    db.prepare('INSERT INTO deploy_notice(id,channel_id,text) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET channel_id=excluded.channel_id,text=excluded.text').run(channelId, text);
  } finally { db.close(); }
}
async function step(label, command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8' });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  await log(`${label}: ${result.status === 0 ? 'ok' : 'failed'}${output ? `\n${output}` : ''}`);
  return result.status === 0;
}
const systemctl = (label, action) => step(label, 'sudo', ['-n', 'systemctl', action, 'butler']);
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
if (!await systemctl('stop', 'stop')) {
  await alert('Deployment could not stop the running Butler');
  process.exit(1);
}
await fs.rm(previous, { recursive: true, force: true });
await fs.rename(dist, previous);
await fs.rename(build, dist);
notice('« Deployment complete. The new version is running. »');
if (await systemctl('start', 'start')) {
  await fs.rm(previous, { recursive: true, force: true });
  process.exit(0);
}
await systemctl('stop new build', 'stop');
await fs.rm(dist, { recursive: true, force: true });
await fs.rename(previous, dist);
notice('部署失敗：新版未能啟動，已回到舊版。詳見 .data/deploy/deploy.log');
if (await systemctl('start previous build', 'start')) process.exit(1);
await alert('Deployment failed and the previous build did not start; Butler is down');
process.exit(1);
