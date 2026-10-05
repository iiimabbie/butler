import { readConfig } from './config.js';
import { databasePath, prepareDatabaseDirectory } from './paths.js';
import { Store } from './store.js';
import { readDiscordConfig, registerDiscordCommands, startDiscord } from './discord.js';

try {
  const config = readConfig();
  if (process.argv[2] === 'register-discord-commands') {
    await registerDiscordCommands(config);
  } else {
    if (process.argv.length > 2) throw new Error('Butler service accepts no product commands');
    const dbPath = databasePath(config);
    prepareDatabaseDirectory(dbPath);
    const store = new Store(dbPath);
    await startDiscord(readDiscordConfig(config), store, config, dbPath);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
