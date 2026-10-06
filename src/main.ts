import { readConfig } from './config.js';
import { mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { databasePath, prepareDatabaseDirectory } from './paths.js';
import { Store } from './store.js';
import { readDiscordConfig, registerDiscordCommands, startDiscord } from './discord.js';
import { fileURLToPath } from 'node:url';

try {
  const config = readConfig();
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
    await startDiscord(readDiscordConfig(config), store, config, dbPath);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
