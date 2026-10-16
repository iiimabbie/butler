import { promises as fs } from 'node:fs';
import path from 'node:path';

const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const RETAINED_RUNS = 3;

export async function pruneDeploymentRuns(deployDir, protectedIds = []) {
  const runsDir = path.join(deployDir, 'runs');
  let rootStat;
  try { rootStat = await fs.lstat(runsDir); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return [];

  const protectedSet = new Set(protectedIds);
  const candidates = [];
  for (const entry of await fs.readdir(runsDir, { withFileTypes: true })) {
    if (!SAFE_RUN_ID.test(entry.name)) continue;
    const runPath = path.join(runsDir, entry.name);
    const runStat = await fs.lstat(runPath);
    if (!runStat.isDirectory() || runStat.isSymbolicLink()) continue;
    const resultPath = path.join(runPath, 'result.json');
    let resultStat;
    try { resultStat = await fs.lstat(resultPath); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (!resultStat.isFile() || resultStat.isSymbolicLink()) continue;
    let result;
    try { result = JSON.parse(await fs.readFile(resultPath, 'utf8')); }
    catch { continue; }
    if (result?.id !== entry.name || !['completed', 'failed'].includes(result.status)) continue;
    const parsedAt = typeof result.at === 'string' ? Date.parse(result.at) : Number.NaN;
    candidates.push({ id: entry.name, path: runPath, timestamp: Number.isFinite(parsedAt) ? parsedAt : resultStat.mtimeMs });
  }

  candidates.sort((a, b) => b.timestamp - a.timestamp || a.id.localeCompare(b.id));
  const deleted = [];
  for (const run of candidates.slice(RETAINED_RUNS)) {
    if (protectedSet.has(run.id)) continue;
    await fs.rm(run.path, { recursive: true, force: false });
    deleted.push(run.id);
  }
  return deleted;
}
