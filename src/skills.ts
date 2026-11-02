import { ToolUsageError } from './tool-errors.js';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { execFile as execFileCallback } from 'node:child_process';
import { parse } from 'yaml';

const execFile = promisify(execFileCallback);
const string = { type: 'string' };
const definition = (name: string, description: string, properties: Record<string, unknown>, required: string[]) => ({ type: 'function', name, description, parameters: { type: 'object', properties, required, additionalProperties: false } });
const definitions = [
  definition('skills_read', 'List installed skills and their metadata when name is omitted; read a file in an installed skill directory when name is supplied. path defaults to SKILL.md and requires name.', { name: string, path: string }, []),
  definition('skills_manage', 'Manage installed skills.\nprepare — Stage skill candidates from a Git URL or local directory; required source.\ninstall — Install a staged skill into workspace/skills; existing skills are not overwritten; required path, name.\nremove — Move an installed skill to workspace/.trash; required name.', { action: { type: 'string', enum: ['prepare', 'install', 'remove'] }, source: string, path: string, name: string }, ['action']),
];

export type SkillsToolRuntime = { definitions: typeof definitions; execute(name: string, args: Record<string, unknown>): Promise<unknown>; catalog(): Promise<string> };

export function createSkillsToolRuntime(workspaceDirectory: string): SkillsToolRuntime {
  const workspace = resolve(workspaceDirectory);
  const skillsDirectory = resolve(workspace, 'skills');
  const stagingDirectory = resolve(workspace, '.skills-staging');
  return {
    definitions,
    async catalog() {
      const items = await installedSkills(skillsDirectory);
      return items.map(item => `${item.name}: ${item.description} (${resolve(workspace, item.path)})`).join('\n');
    },
    async execute(name, args) {
      if (name === 'skills_read') {
        validateSkillArgs({ name: string, path: string }, [], args);
        if (args.name === undefined) { if (args.path !== undefined) throw new ToolUsageError('path requires name'); return installedSkills(skillsDirectory); }
        const skill = await installedSkill(stringArg(args.name, 'name'), skillsDirectory);
        const path = args.path === undefined ? 'SKILL.md' : stringArg(args.path, 'path', true) || 'SKILL.md';
        const target = resolve(skill.path, path);
        assertInside(skill.path, target);
        const real = await realpath(target);
        assertInside(await realpath(skill.path), real);
        const info = await stat(real);
        if (!info.isFile()) throw new Error('Skill path must be a regular file');
        return { path: relative(workspace, real), content: await readFile(real, 'utf8') };
      }
      if (name === 'skills_manage') {
        const action = args.action;
        if (typeof action !== 'string' || !['prepare', 'install', 'remove'].includes(action)) throw new ToolUsageError('Unknown or missing action. Valid actions: prepare, install, remove');
        const { action: _action, ...operationArgs } = args;
        const actionSchemas: Record<string, { properties: Record<string, unknown>; required: string[] }> = { prepare: { properties: { source: string }, required: ['source'] }, install: { properties: { path: string, name: string }, required: ['path', 'name'] }, remove: { properties: { name: string }, required: ['name'] } };
        validateSkillArgs(actionSchemas[action]!.properties, actionSchemas[action]!.required, operationArgs); args = operationArgs;
        if (action === 'prepare') return prepare(stringArg(args.source, 'source'), stagingDirectory);
        if (action === 'install') {
          const skillName = validName(stringArg(args.name, 'name'));
          const candidate = resolve(stringArg(args.path, 'path'));
          const stagingReal = await realpath(stagingDirectory);
          const candidateReal = await realpath(candidate);
          assertInside(stagingReal, candidateReal);
          const meta = await skillMetadata(candidateReal);
          if (meta.name !== skillName) throw new ToolUsageError(`Candidate skill name is ${meta.name}, not ${skillName}`);
          const destination = resolve(skillsDirectory, skillName);
          try { await lstat(destination); throw new ToolUsageError(`Skill already exists: ${skillName}`); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
          await mkdir(skillsDirectory, { recursive: true });
          await cp(candidateReal, destination, { recursive: true, errorOnExist: true, force: false, dereference: false });
          // The staged clone is only needed until one of its candidates is installed.
          await rm(resolve(stagingReal, relative(stagingReal, candidateReal).split(sep)[0]!), { recursive: true, force: true });
          return { installed: skillName, path: relative(workspace, destination) };
      }
        if (action === 'remove') {
          const skill = await installedSkill(stringArg(args.name, 'name'), skillsDirectory);
          const trash = resolve(workspace, '.trash');
          await mkdir(trash, { recursive: true });
          const destination = resolve(trash, `${skill.name}-${Date.now()}`);
          await rename(skill.path, destination);
          return { removed: skill.name, path: relative(workspace, destination) };
        }
      }
      throw new ToolUsageError(`Unknown skills tool: ${name}`);
    },
  };
}

function validateSkillArgs(properties: Record<string, unknown>, required: string[], args: Record<string, unknown>): void {
  for (const key of required) if (!(key in args)) throw new ToolUsageError(`${key} is required`);
  for (const [key, value] of Object.entries(args)) if (!(key in properties)) throw new ToolUsageError(`Invalid skill argument: ${key}`);
}

async function prepare(source: string, staging: string) {
  await mkdir(staging, { recursive: true });
  const stage = await mkdtemp(resolve(staging, 'candidate-'));
  try {
    let root: string;
    if (/^[a-z][a-z\d+.-]*:\/\//i.test(source) || /^[^/]+@[^:]+:/.test(source)) {
      root = resolve(stage, 'repo');
      await execFile('git', ['clone', '--depth', '1', '--', source, root], { maxBuffer: 10 * 1024 * 1024 });
    } else {
      const local = await realpath(source);
      if (!(await stat(local)).isDirectory()) throw new Error('Local skill source must be a directory');
      root = resolve(stage, 'local');
      await cp(local, root, { recursive: true, dereference: false });
    }
    const candidates: Array<{ path: string; name: string; description: string; skill_md: string }> = [];
    for (const dir of await findSkillDirectories(root)) {
      const meta = await skillMetadata(dir);
      candidates.push({ path: dir, name: meta.name, description: meta.description, skill_md: meta.content });
    }
    if (!candidates.length) throw new Error('No SKILL.md found in source');
    return { candidates };
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    throw error;
  }
}

async function findSkillDirectories(root: string): Promise<string[]> {
  const result: string[] = [];
  const visit = async (directory: string, depth: number) => {
    if (depth > 5) return;
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
    if (entries.some(entry => entry.isFile() && entry.name === 'SKILL.md')) { result.push(directory); return; }
    for (const entry of entries) if (entry.isDirectory() && !entry.isSymbolicLink()) await visit(resolve(directory, entry.name), depth + 1);
  };
  await visit(root, 0);
  return result;
}

async function skillMetadata(directory: string) {
  const content = await readFile(resolve(directory, 'SKILL.md'), 'utf8');
  const match = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) throw new Error('SKILL.md must contain YAML frontmatter');
  const frontmatter: unknown = parse(match[1]!);
  if (!frontmatter || typeof frontmatter !== 'object' || Array.isArray(frontmatter)) throw new Error('SKILL.md frontmatter must be a YAML mapping');
  const fields = frontmatter as Record<string, unknown>;
  return { name: validName(typeof fields.name === 'string' ? fields.name : basename(directory)), description: typeof fields.description === 'string' ? fields.description : '', content };
}

async function installedSkills(directory: string) {
  const result: Array<{ name: string; description: string; path: string }> = [];
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return result; throw error; }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    try {
      const path = resolve(directory, entry.name);
      const metadata = await skillMetadata(path);
      result.push({ name: entry.name, description: metadata.description, path: relative(workspaceRoot(directory), resolve(path, 'SKILL.md')) });
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
  }
  return result;
}

function workspaceRoot(skills: string) { return dirname(skills); }
async function installedSkill(name: string, directory: string) {
  const safeName = validName(name);
  const path = resolve(directory, safeName);
  assertInside(directory, path);
  const real = await realpath(path);
  assertInside(await realpath(directory), real);
  const metadata = await skillMetadata(real);
  return { name: safeName, path: real, metadata };
}
function validName(name: string) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(name) || name === '.' || name === '..') throw new ToolUsageError('Skill name must be a simple directory name');
  return name;
}
function assertInside(root: string, target: string) {
  const rel = relative(root, target);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) { if (rel !== '') throw new ToolUsageError('Path must remain inside its skill or staging directory'); }
}
function stringArg(value: unknown, name: string, empty = false) { if (typeof value !== 'string' || (!empty && !value.trim()) || value.includes('\0')) throw new ToolUsageError(`${name} must be a string`); return value; }
