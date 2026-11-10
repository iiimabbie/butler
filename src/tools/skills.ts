import { errorMessage, ToolUsageError } from './tool-errors.js';
import { logWarn } from '../log.js';
import { cp, lstat, mkdir, mkdtemp, readFile, readlink, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { parse } from 'yaml';
import { projectPath } from '../paths.js';
import { validateToolArgs } from './tool-schema.js';

const execFile = promisify(execFileCallback);
const string = { type: 'string', minLength: 1 };
const optionalPath = { type: 'string' };
const definition = (name: string, description: string, properties: Record<string, unknown>, required: string[]) => ({ type: 'function', name, description, parameters: { type: 'object', properties, required, additionalProperties: false } });
const definitions = [
  definition('skills_read', 'List installed skills and their metadata when name is omitted; read a file in an installed skill directory when name is supplied. path defaults to SKILL.md and requires name.', { name: string, path: optionalPath }, []),
  definition('skills_manage', 'Manage installed skills.\nprepare — Stage skill candidates from a Git URL or local directory; required source.\ninstall — Install a staged skill into workspace/skills and record its Git source in workspace/skills/.lock.json; existing skills are not overwritten; required path, name.\nupdate — Re-fetch locked skills from their recorded source and replace them; name selects one, omitted updates all; locally modified skills are skipped unless force is true.\ncheck — Report which locked skills have upstream changes or local modifications without changing anything; optional name.\nremove — Move an installed skill to backups/skills-trash (kept 30 days) and drop its lock entry; required name.', { action: { type: 'string', enum: ['prepare', 'install', 'update', 'check', 'remove'] }, source: string, path: string, name: string, force: { type: 'boolean' } }, ['action']),
];

export type SkillsToolRuntime = { definitions: typeof definitions; execute(name: string, args: Record<string, unknown>): Promise<unknown>; catalog(): Promise<string> };

type SkillSource = { type: 'git'; url: string; path: string } | { type: 'url'; files: Record<string, string> };
type SkillLockEntry = { source: SkillSource; revision?: string; hash?: string; updatedAt?: string };
type SkillLock = { version: 1; skills: Record<string, SkillLockEntry> };

export function createSkillsToolRuntime(workspaceDirectory: string): SkillsToolRuntime {
  const workspace = resolve(workspaceDirectory);
  const skillsDirectory = resolve(workspace, 'skills');
  const stagingDirectory = resolve(workspace, '.skills-staging');
  const lockPath = resolve(skillsDirectory, '.lock.json');
  return {
    definitions,
    async catalog() {
      const items = await installedSkills(skillsDirectory);
      return items.map(item => `${item.name}: ${item.description} (${resolve(workspace, item.path)})`).join('\n');
    },
    async execute(name, args) {
      if (name === 'skills_read') {
        validateToolArgs({ name: string, path: optionalPath }, [], args);
        if (args.name === undefined) { if (args.path !== undefined) throw new ToolUsageError('path requires name'); return installedSkills(skillsDirectory); }
        const skill = await installedSkill(args.name as string, skillsDirectory);
        const path = (args.path as string | undefined) || 'SKILL.md';
        const target = resolve(skill.path, path);
        assertInside(skill.path, target);
        let real: string;
        try { real = await realpath(target); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ToolUsageError('Skill file does not exist'); throw error; }
        assertInside(await realpath(skill.path), real);
        const info = await stat(real).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ToolUsageError('Skill file does not exist'); throw error; });
        if (!info.isFile()) throw new ToolUsageError('Skill path must be a regular file');
        return { path: relative(workspace, real), content: await readFile(real, 'utf8') };
      }
      if (name === 'skills_manage') {
        const action = args.action;
        if (typeof action !== 'string' || !['prepare', 'install', 'update', 'check', 'remove'].includes(action)) throw new ToolUsageError('Unknown or missing action. Valid actions: prepare, install, update, check, remove');
        const { action: _action, ...operationArgs } = args;
        const actionSchemas: Record<string, { properties: Record<string, unknown>; required: string[] }> = { prepare: { properties: { source: string }, required: ['source'] }, install: { properties: { path: string, name: string }, required: ['path', 'name'] }, update: { properties: { name: string, force: { type: 'boolean' } }, required: [] }, check: { properties: { name: string }, required: [] }, remove: { properties: { name: string }, required: ['name'] } };
        validateToolArgs(actionSchemas[action]!.properties, actionSchemas[action]!.required, operationArgs); args = operationArgs;
        if (action === 'prepare') return prepare(args.source as string, stagingDirectory);
        if (action === 'install') {
          const skillName = validName(args.name as string);
          const candidate = resolve(args.path as string);
          const stagingReal = await realpath(stagingDirectory);
          const candidateReal = await realpath(candidate);
          assertInside(stagingReal, candidateReal);
          const meta = await skillMetadata(candidateReal);
          if (meta.name !== skillName) throw new ToolUsageError(`Candidate skill name is ${meta.name}, not ${skillName}`);
          const destination = resolve(skillsDirectory, skillName);
          try { await lstat(destination); throw new ToolUsageError(`Skill already exists: ${skillName}`); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
          await mkdir(skillsDirectory, { recursive: true });
          const stage = resolve(stagingReal, relative(stagingReal, candidateReal).split(sep)[0]!);
          await cp(candidateReal, destination, { recursive: true, errorOnExist: true, force: false, dereference: false, filter: src => basename(src) !== '.git' });
          let sourceInfo: { url: string; commit: string } | undefined;
          try { sourceInfo = JSON.parse(await readFile(resolve(stage, 'source.json'), 'utf8')) as { url: string; commit: string }; }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
          if (sourceInfo) {
            const lock = await readLock(lockPath);
            lock.skills[skillName] = { source: { type: 'git', url: sourceInfo.url, path: relative(resolve(stage, 'repo'), candidateReal).split(sep).join('/') }, revision: sourceInfo.commit, hash: await contentHash(destination), updatedAt: new Date().toISOString() };
            await writeLock(lockPath, lock);
          }
          return { installed: skillName, path: relative(workspace, destination) };
        }
        if (action === 'update' || action === 'check') {
          const lock = await readLock(lockPath);
          const selectedName = args.name === undefined ? undefined : validName(args.name as string);
          if (selectedName && !(selectedName in lock.skills)) throw new ToolUsageError(`Skill ${selectedName} has no recorded source`);
          const names = selectedName ? [selectedName] : Object.keys(lock.skills).sort();
          const results = [];
          for (const skillName of names) {
            try { results.push(action === 'update'
              ? await updateOne(skillName, lock.skills[skillName]!, skillsDirectory, stagingDirectory, args.force === true)
              : await checkOne(skillName, lock.skills[skillName]!, skillsDirectory, stagingDirectory)); }
            catch (error) { results.push({ name: skillName, status: 'failed', error: errorMessage(error) }); }
            // Persist after each skill so an interruption cannot leave replaced files with a stale hash.
            if (action === 'update') await writeLock(lockPath, lock);
          }
          if (action === 'check') {
            const installed = await installedSkills(skillsDirectory);
            return { results, untracked: installed.map(skill => skill.name).filter(skillName => !(skillName in lock.skills)) };
          }
          return { results };
        }
        if (action === 'remove') {
          const skill = await installedSkill(args.name as string, skillsDirectory);
          const trash = await trashDirectory();
          const destination = resolve(trash, `${skill.name}-${Date.now()}`);
          await rename(skill.path, destination);
          const lock = await readLock(lockPath);
          if (skill.name in lock.skills) { delete lock.skills[skill.name]; await writeLock(lockPath, lock); }
          return { removed: skill.name, path: relative(projectPath('.'), destination) };
        }
      }
      throw new ToolUsageError(`Unknown skills tool: ${name}`);
    },
  };
}

async function trashDirectory(): Promise<string> {
  const trash = projectPath('backups/skills-trash');
  await mkdir(trash, { recursive: true });
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  for (const entry of await readdir(trash, { withFileTypes: true })) {
    const timestamp = /-(\d+)$/.exec(entry.name)?.[1];
    if (timestamp !== undefined && Number(timestamp) < cutoff) {
      await rm(resolve(trash, entry.name), { recursive: true, force: true });
    }
  }
  return trash;
}

const STAGE_TTL_MS = 24 * 60 * 60 * 1000;

// One prepare can offer several candidates, so a stage stays until it is a day old.
async function pruneStages(staging: string) {
  for (const entry of await readdir(staging, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('candidate-')) continue;
    const path = resolve(staging, entry.name);
    if (Date.now() - (await stat(path)).mtimeMs > STAGE_TTL_MS) await rm(path, { recursive: true, force: true });
  }
}

async function prepare(source: string, staging: string) {
  await mkdir(staging, { recursive: true });
  await pruneStages(staging);
  const stage = await mkdtemp(resolve(staging, 'candidate-'));
  try {
    let root: string;
    if (/^[a-z][a-z\d+.-]*:\/\//i.test(source) || /^[^/]+@[^:]+:/.test(source)) {
      root = resolve(stage, 'repo');
      await execFile('git', ['clone', '--depth', '1', '--', source, root], { maxBuffer: 10 * 1024 * 1024 });
      const { stdout } = await execFile('git', ['-C', root, 'rev-parse', 'HEAD'], { maxBuffer: 10 * 1024 * 1024 });
      await writeFile(resolve(stage, 'source.json'), JSON.stringify({ url: source, commit: stdout.trim() }));
    } else {
      const local = await realpath(source);
      if (!(await stat(local)).isDirectory()) throw new ToolUsageError('Local skill source must be a directory');
      root = resolve(stage, 'local');
      await cp(local, root, { recursive: true, dereference: false });
    }
    const candidates: Array<{ path: string; name: string; description: string; skill_md: string }> = [];
    for (const dir of await findSkillDirectories(root)) {
      const meta = await skillMetadata(dir);
      candidates.push({ path: dir, name: meta.name, description: meta.description, skill_md: meta.content });
    }
    if (!candidates.length) throw new ToolUsageError('No SKILL.md found in source');
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
  if (!match) throw new ToolUsageError('SKILL.md must contain YAML frontmatter');
  let frontmatter: unknown;
  try { frontmatter = parse(match[1]!); } catch { throw new ToolUsageError('SKILL.md frontmatter must be valid YAML'); }
  if (!frontmatter || typeof frontmatter !== 'object' || Array.isArray(frontmatter)) throw new ToolUsageError('SKILL.md frontmatter must be a YAML mapping');
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
    } catch (error) { logWarn('Skipping invalid installed skill', error, { skill: entry.name }); }
  }
  return result;
}

function workspaceRoot(skills: string) { return dirname(skills); }
async function installedSkill(name: string, directory: string) {
  const safeName = validName(name);
  const path = resolve(directory, safeName);
  assertInside(directory, path);
  let real: string;
  try { real = await realpath(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ToolUsageError(`Skill not found: ${safeName}`); throw error; }
  assertInside(await realpath(directory), real);
  return { name: safeName, path: real };
}
function validName(name: string) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(name) || name === '.' || name === '..') throw new ToolUsageError('Skill name must be a simple directory name');
  return name;
}
function assertInside(root: string, target: string) {
  const rel = relative(root, target);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) { if (rel !== '') throw new ToolUsageError('Path must remain inside its skill or staging directory'); }
}

async function readLock(path: string): Promise<SkillLock> {
  let content: string;
  try { content = await readFile(path, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, skills: {} }; throw error; }
  let parsed: unknown;
  try { parsed = JSON.parse(content); } catch { throw new Error(`Invalid skill lock file: ${path}`); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || (parsed as Record<string, unknown>).version !== 1 || !(parsed as Record<string, unknown>).skills || typeof (parsed as Record<string, unknown>).skills !== 'object' || Array.isArray((parsed as Record<string, unknown>).skills)) throw new Error(`Invalid skill lock file: ${path}`);
  return parsed as SkillLock;
}

async function writeLock(path: string, lock: SkillLock): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = resolve(dirname(path), `.lock-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`);
  try { await writeFile(temp, `${JSON.stringify(lock, null, 2)}\n`); await rename(temp, path); }
  finally { await rm(temp, { force: true }); }
}

async function contentHash(directory: string): Promise<string> {
  const hash = createHash('sha256');
  const walk = async (current: string): Promise<void> => {
    const entries = (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const path = resolve(current, entry.name);
      const rel = relative(directory, path).split(sep).join('/');
      const info = await lstat(path);
      if (info.isDirectory()) await walk(path);
      else if (info.isSymbolicLink()) hash.update(rel).update('\0link\0').update(await readlink(path)).update('\0');
      else if (info.isFile()) hash.update(rel).update('\0').update(await readFile(path)).update('\0');
    }
  };
  await walk(directory);
  return hash.digest('hex');
}

function validateSource(entry: SkillLockEntry): SkillSource {
  if (!entry || typeof entry !== 'object' || !entry.source || typeof entry.source !== 'object') throw new Error('Invalid skill lock entry');
  const source = entry.source as Record<string, unknown>;
  if (source.type === 'git' && typeof source.url === 'string' && typeof source.path === 'string') return source as SkillSource;
  if (source.type === 'url' && source.files && typeof source.files === 'object' && !Array.isArray(source.files) && Object.keys(source.files).length > 0) {
    const files: Record<string, string> = {};
    const skillDir = resolve('/skill');
    for (const [key, value] of Object.entries(source.files)) {
      const target = resolve(skillDir, key);
      assertInside(skillDir, target);
      if (typeof value !== 'string' || !value.startsWith('https://')) throw new Error(`Invalid URL source for ${key}`);
      files[key] = value;
    }
    return { type: 'url', files };
  }
  throw new Error('Invalid skill lock source');
}

async function fetchSkill(entry: SkillLockEntry, name: string, staging: string): Promise<{ directory: string; revision: string; hash: string; cleanup: () => Promise<void> }> {
  const source = validateSource(entry);
  await mkdir(staging, { recursive: true });
  const temp = await mkdtemp(resolve(staging, 'update-'));
  try {
    let directory: string;
    let revision = '';
    if (source.type === 'git') {
      const repo = resolve(temp, 'repo');
      await execFile('git', ['clone', '--depth', '1', '--', source.url, repo], { maxBuffer: 10 * 1024 * 1024, timeout: 120000 });
      const result = await execFile('git', ['-C', repo, 'rev-parse', 'HEAD'], { maxBuffer: 10 * 1024 * 1024, timeout: 120000 });
      revision = result.stdout.trim();
      directory = resolve(repo, source.path);
      assertInside(repo, directory);
    } else {
      directory = resolve(temp, 'skill');
      for (const [key, url] of Object.entries(source.files)) {
        const target = resolve(directory, key);
        assertInside(directory, target);
        const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(60000) });
        if (!response.ok) throw new Error(`Failed to fetch ${url}: HTTP ${response.status}`);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, Buffer.from(await response.arrayBuffer()));
      }
    }
    const info = await stat(directory);
    if (!info.isDirectory()) throw new Error(`Skill source directory is missing: ${name}`);
    const metadata = await skillMetadata(directory);
    if (metadata.name !== name) throw new Error(`Fetched skill name is ${metadata.name}, not ${name}`);
    const hash = await contentHash(directory);
    if (source.type === 'url') revision = hash;
    return { directory, revision, hash, cleanup: () => rm(temp, { recursive: true, force: true }) };
  } catch (error) { await rm(temp, { recursive: true, force: true }); throw error; }
}

async function updateOne(name: string, entry: SkillLockEntry, skills: string, staging: string, force: boolean) {
  const safeName = validName(name);
  const installed = resolve(skills, safeName);
  try { await lstat(installed); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { name, status: 'missing' }; throw error; }
  const locallyModified = entry.hash !== undefined && await contentHash(installed) !== entry.hash;
  if (locallyModified && !force) return { name, status: 'locally_modified' };
  const fetched = await fetchSkill(entry, name, staging);
  try {
    if (entry.hash !== undefined && fetched.hash === entry.hash && !locallyModified) {
      if (entry.revision !== fetched.revision) { entry.revision = fetched.revision; entry.updatedAt = new Date().toISOString(); }
      return { name, status: 'up_to_date' };
    }
    // Build the complete replacement first, then swap with renames so the skill is never left half-copied.
    const ready = await mkdtemp(resolve(staging, 'ready-'));
    try {
      const replacement = resolve(ready, 'skill');
      await cp(fetched.directory, replacement, { recursive: true, errorOnExist: true, force: false, dereference: false, filter: src => basename(src) !== '.git' });
      const hash = await contentHash(replacement);
      const trash = await trashDirectory();
      const previous = resolve(trash, `${name}-${Date.now()}`);
      await rename(installed, previous);
      try { await rename(replacement, installed); }
      catch (error) { await rename(previous, installed); throw error; }
      const from = entry.revision;
      entry.revision = fetched.revision;
      entry.hash = hash;
      entry.updatedAt = new Date().toISOString();
      return { name, status: 'updated', ...(from === undefined ? {} : { from }), to: fetched.revision };
    } finally { await rm(ready, { recursive: true, force: true }); }
  } finally { await fetched.cleanup(); }
}

async function checkOne(name: string, entry: SkillLockEntry, skills: string, staging: string) {
  const installed = resolve(skills, validName(name));
  let locallyModified = false;
  if (entry.hash !== undefined) {
    try { locallyModified = await contentHash(installed) !== entry.hash; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') locallyModified = true; else throw error; }
  }
  const fetched = await fetchSkill(entry, name, staging);
  try {
    const status = entry.hash === undefined || fetched.hash !== entry.hash ? 'update_available' : 'up_to_date';
    return { name, status, locallyModified, ...(entry.hash === undefined ? {} : { current: entry.hash }), latest: fetched.hash };
  } finally { await fetched.cleanup(); }
}
