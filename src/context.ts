import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const defaultWorkspace = fileURLToPath(new URL('../workspace/', import.meta.url));
const files = ['SOUL.md', 'AGENT.md', 'OWNER.md', 'MEMORY.md'] as const;

export interface WorkspaceContext {
  developer: string[];
  background: string[];
}

export async function loadWorkspaceContext(directory = defaultWorkspace): Promise<WorkspaceContext> {
  const developer: string[] = [];
  const background: string[] = [];
  for (const name of files) {
    let content: string;
    try {
      content = await readFile(resolve(directory, name), 'utf8');
    } catch (error) {
      if (isMissingFile(error)) continue;
      throw error;
    }
    if (!content.trim()) continue;
    const section = content.trim();
    (name === 'SOUL.md' || name === 'AGENT.md' ? developer : background).push(section);
  }
  return { developer, background };
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
