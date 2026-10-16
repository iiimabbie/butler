import { readConfig, watchConfig, type ButlerConfig } from './config.js';
import type { RuntimeBundle } from './discord.js';
import { mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { databasePath, prepareDatabaseDirectory } from './paths.js';
import { Store } from './store.js';
import { readDiscordConfig, registerDiscordCommands, startDiscord } from './discord.js';
import { fileURLToPath } from 'node:url';
import { Hindsight } from './hindsight.js';
import { MemoryCoordinator } from './memory-coordinator.js';
import { createWebToolRuntime } from './web-tools.js';
import { createHledgerToolRuntime } from './hledger-tools.js';
import { configureLogging, flushLogs, logError, logInfo, logWarn } from './log.js';
import { isHttp429 } from './tool-errors.js';

try {
  const config = readConfig();
  configureLogging(config);
  process.on('uncaughtExceptionMonitor', error => logError('Uncaught exception monitor', error, { notify: !isHttp429(error) }));
  if (process.argv[2] === 'register-discord-commands') {
    await registerDiscordCommands(config);
  } else {
    if (process.argv.length > 2) throw new Error('Butler service accepts no product commands');
    const deployState = new URL('../.data/service/', import.meta.url);
    const deployStatePath = fileURLToPath(deployState);
    mkdirSync(deployStatePath, { recursive: true, mode: 0o700 });
    const appPidPath = `${deployStatePath}/app.pid`;
    writeFileSync(appPidPath, `${process.pid}\n`, { mode: 0o600 });
    process.once('exit', () => { try { unlinkSync(appPidPath); } catch {} });
    const dbPath = databasePath(config);
    prepareDatabaseDirectory(dbPath);
    const store = new Store(dbPath);
    let current: RuntimeBundle;
    const buildBundle = (candidate: ButlerConfig): RuntimeBundle => ({ settings: candidate, discord: readDiscordConfig(candidate), webTools: createWebToolRuntime(candidate.web), hledgerTools: createHledgerToolRuntime(candidate.hledger ?? { enabled:false, journalPath:fileURLToPath(new URL('../.data/finance/main.journal', import.meta.url)), executablePath:'/usr/bin/hledger', allowedRequesterIds:[], allowedChannelIds:[] }), hindsight: candidate.memory ? new Hindsight(candidate.memory) : undefined });
    current = buildBundle(config);
    const getRuntime = () => current;
    const memoryCoordinator = current.hindsight ? new MemoryCoordinator(store, () => { const wrapper = current.hindsight; if (!wrapper) throw new Error('Memory is disabled in the current runtime'); return wrapper; }, () => current.settings.schedule?.timezone ?? 'Asia/Taipei') : undefined;
    const watcher = watchConfig({ initial: config, log: { logInfo, logWarn, logError }, onCandidate: candidate => { const next = buildBundle(candidate); current = next; configureLogging(candidate); }, prepareCandidate: candidate => { const next = buildBundle(candidate); return () => { current = next; configureLogging(candidate); }; } });
    try {
      await memoryCoordinator?.start();
      await startDiscord(getRuntime, store, dbPath, undefined, memoryCoordinator, () => watcher.close(), id => watcher.addChannel(id));
    } finally {
      watcher.close();
      await memoryCoordinator?.close();
    }
  }
} catch (error) {
  logError('Butler startup/runtime failed', error, { notify: !isHttp429(error) });
  process.exitCode = 1;
} finally {
  await flushLogs();
}
