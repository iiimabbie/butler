import { resolve } from 'node:path';
import { requireSetting, type ButlerConfig } from './config.js';
import { mkdirSync, chmodSync, existsSync } from 'node:fs';

export function databasePath(config: ButlerConfig): string {
  return requireSetting(config.paths?.database, 'paths.database');
}

export function prepareDatabaseDirectory(path: string): void {
  const directory = resolve(path, '..');
  if (!existsSync(directory)) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
  }
}
