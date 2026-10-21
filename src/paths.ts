import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Resolves a path relative to the Butler project root; absolute paths are returned unchanged.
export function projectPath(path: string): string { return resolve(projectRoot, path); }

export const databasePath = projectPath('.data/butler.sqlite');
export const attachmentsPath = projectPath('.data/attachments');
export const journalPath = projectPath('.data/finance/main.journal');
