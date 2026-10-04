import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { mkdirSync, chmodSync, existsSync } from 'node:fs';

export function databasePath(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.BUTLER_DB || join(homedir(), '.local/share/butler/butler.sqlite'));
}

export function prepareDatabaseDirectory(path: string): void {
  const directory = resolve(path, '..');
  if (!existsSync(directory)) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
  }
}
