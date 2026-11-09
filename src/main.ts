import { DEFAULT_SCHEDULE_TIMEZONE } from './timezone.js';
import { configuredFixedChannels, readConfig, watchConfig, type ButlerConfig } from './config.js';
import type { RuntimeBundle } from './discord.js';
import { attachmentsPath, databasePath, journalPath } from './paths.js';
import { Store } from './store.js';
import { runRetention } from './retention.js';
import { readDiscordConfig, registerDiscordCommands, startDiscord } from './discord.js';
import { Hindsight } from './hindsight.js';
import { MemoryCoordinator } from './memory-coordinator.js';
import { createWebToolRuntime } from './web-tools.js';
import { createHledgerToolRuntime } from './hledger-tools.js';
import { configureLogging, flushLogs, logError, logInfo, logWarn } from './log.js';
import { isHttp429 } from './tool-errors.js';

try {
  const config = readConfig();
  configureLogging(config);
  process.on('uncaughtExceptionMonitor', error => logError('Uncaught exception monitor', error, { mention: !isHttp429(error) }));
  if (process.argv[2] === 'register-discord-commands') {
    await registerDiscordCommands(config);
  } else {
    if (process.argv.length > 2) throw new Error('Butler service accepts no product commands');
    const store = new Store(databasePath, { fixedChannels: configuredFixedChannels(config), timezone: config.schedule?.timezone ?? DEFAULT_SCHEDULE_TIMEZONE });
    let current: RuntimeBundle;
    const buildBundle = (candidate: ButlerConfig): RuntimeBundle => ({ settings: candidate, discord: readDiscordConfig(candidate), webTools: createWebToolRuntime({ ...candidate.web, reserveRequest: (provider, limit) => store.reserveWebRequest(provider, limit) }), hledgerTools: createHledgerToolRuntime({ enabled: candidate.hledger?.enabled ?? false, journalPath, schedules: { load: () => store.hledgerSchedules(), save: schedules => store.saveHledgerSchedules(schedules) } }), hindsightFor: candidate.memory ? (channelId: string | undefined) => { const bankId = channelId ? store.channelMemoryBank(channelId) : undefined; return new Hindsight(bankId ? { ...candidate.memory!, bankId } : candidate.memory!); } : undefined });
    current = buildBundle(config);
    const closeSettingsWatch = store.watchFileSettings((error, file) => logWarn('File-backed settings reload rejected; retaining last valid snapshot', error, { file }));
    const getRuntime = () => current;
    const memoryCoordinator = current.hindsightFor ? new MemoryCoordinator(store, channelId => { const resolve = current.hindsightFor; if (!resolve) throw new Error('Memory is disabled in the current runtime'); return resolve(channelId); }, () => current.settings.schedule?.timezone ?? DEFAULT_SCHEDULE_TIMEZONE) : undefined;
    const watcher = watchConfig({ initial: config, log: { logInfo, logWarn, logError }, prepareCandidate: candidate => { const next = buildBundle(candidate); return () => { store.setSettingsTimezone(candidate.schedule?.timezone ?? DEFAULT_SCHEDULE_TIMEZONE); store.setFixedChannels(configuredFixedChannels(candidate)); current = next; configureLogging(candidate); }; } });
    setImmediate(() => runRetention(store, attachmentsPath));
    const retentionTimer = setInterval(() => runRetention(store, attachmentsPath), 24 * 60 * 60 * 1000);
    retentionTimer.unref();
    try {
      await memoryCoordinator?.start();
      await startDiscord(getRuntime, store, memoryCoordinator, () => { watcher.close(); closeSettingsWatch(); });
    } finally {
      clearInterval(retentionTimer);
      watcher.close();
      closeSettingsWatch();
      await memoryCoordinator?.close();
      store.close();
    }
  }
} catch (error) {
  logError('Butler startup/runtime failed', error, { mention: !isHttp429(error) });
  process.exitCode = 1;
} finally {
  await flushLogs();
}
