import fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { DatabaseSync, backup } from 'node:sqlite';
import YAML from 'yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BACKUP_ROOT = path.join(ROOT, 'backups', 'memory-and-chats');
export const CLEAR_TABLES = [
  'memory_batch_sources', 'message_input_attachments', 'message_sources', 'hindsight_pending',
  'discord_outgoing_segments', 'message_preparation', 'memory_batches', 'tool_calls',
  'subagent_inbox', 'subagent_events', 'subagent_runs', 'subagent_windows',
  'session_compact_checkpoints', 'session_opening_context', 'session_context_usage',
  'attachment_deliveries', 'latest_cpa_request', 'model_requests', 'ask_context',
  'restart_notice', 'session_sources', 'messages', 'sessions',
];
export const KEEP_TABLES = [
  'schedule_runtime', 'schedule_runs', 'web_usage',
];
const LINK_TABLES = ['channel_state'];
const HELP = `用法：node scripts/clear-memory-and-chats.mjs [--help] [--bank-id <id>] [--base-url <url>] [--database <absolute-path>] [--execute --confirm-bank <id> --confirm-database <absolute-path>]

預設為唯讀 preview，不建立備份、不修改聊天或記憶。
--bank-id <id>                  精確 Hindsight bank ID
--base-url <url>                Hindsight base URL
--database <absolute-path>      覆寫 .data/config.yaml paths.database
--execute                      清除 Hindsight 記憶與 SQLite 聊天資料
--confirm-bank <id>             必須與 bank ID 完全相同
--confirm-database <path>       必須與解析後絕對 SQLite 路徑完全相同
--help                         顯示說明

執行前停止 Butler 與所有其他寫入來源，等待 Hindsight 背景工作完成。
保留知識頁、心智模型、bank、排程、排程執行紀錄與頻道設定。
清除聊天、上下文、待送記憶、工具與子代理紀錄；頻道改接空白會話。
不刪人物 markdown、附件/journal 等本地檔案或 Discord 遠端訊息。
備份含舊 SQLite 聊天及保留的知識資料，不包含 Hindsight 原始記憶。
腳本不自動停止或重啟服務；兩端無法原子回滾，失敗時不自動重試。`;

function parseArgs(argv) {
  const options = { execute: false, help: false };
  const keys = { '--bank-id': 'bankId', '--base-url': 'baseUrl', '--database': 'database', '--confirm-bank': 'confirmBank', '--confirm-database': 'confirmDatabase' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help') options.help = true;
    else if (arg === '--execute') options.execute = true;
    else if (keys[arg]) {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error(`${arg} 需要值`);
      if (options[keys[arg]] !== undefined) throw new Error(`參數不可重複：${arg}`);
      options[keys[arg]] = value;
    } else throw new Error(`未知參數：${arg}`);
  }
  if (options.help && argv.length !== 1) throw new Error('--help 不可與其他參數併用');
  if (options.execute && (!options.confirmBank || !options.confirmDatabase)) throw new Error('--execute 必須搭配兩項確認參數');
  if (!options.execute && (options.confirmBank || options.confirmDatabase)) throw new Error('確認參數只能搭配 --execute');
  return options;
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
function same(a, b) { return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b)); }
function sorted(rows) { return [...rows].sort((a, b) => JSON.stringify(canonical(a)).localeCompare(JSON.stringify(canonical(b)))); }
function storedKnowledge(value) {
  if (Array.isArray(value)) return value.map(storedKnowledge);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'is_stale').map(([key, item]) => [key, storedKnowledge(item)]));
  return value;
}
function samePreserved(a, b) { return same(storedKnowledge(a), storedKnowledge(b)); }
function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} 欄位無效`);
  return value;
}
function string(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} 欄位無效`);
  return value;
}
function count(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} 欄位無效`);
  return value;
}
async function request(url, method = 'GET') {
  const uncertain = method === 'GET' ? '' : '；結果未知';
  let response;
  try { response = await fetch(url, { method, signal: AbortSignal.timeout(method === 'GET' ? 30_000 : 120_000) }); }
  catch (error) { throw new Error(`${method} 連線失敗${uncertain}：${error.message}`); }
  let text;
  try { text = await response.text(); }
  catch (error) { throw new Error(`${method} HTTP ${response.status} 讀取回應失敗${uncertain}：${error.message}`); }
  if (!response.ok) throw new Error(`${method} HTTP ${response.status}${response.status >= 500 ? uncertain : ''}`);
  try { return object(JSON.parse(text), `${method} response`); }
  catch (error) { throw new Error(`${method} 回應無效${uncertain}：${error.message}`); }
}
async function list(url, key = 'items') {
  const rows = [];
  let offset = 0;
  while (true) {
    const target = new URL(url);
    target.searchParams.set('limit', '100');
    target.searchParams.set('offset', String(offset));
    const result = await request(target);
    if (!Array.isArray(result[key])) throw new Error(`${key} 清單無效`);
    const total = count(result.total, `${key}.total`);
    rows.push(...result[key]);
    if (rows.length >= total) return sorted(rows);
    if (!result[key].length) throw new Error(`${key} 分頁未前進`);
    offset += result[key].length;
  }
}
async function getStats(bank) {
  const stats = await request(`${bank}/stats?refresh=true`);
  count(stats.total_nodes, 'stats.total_nodes');
  count(stats.total_documents, 'stats.total_documents');
  count(stats.pending_operations, 'stats.pending_operations');
  count(stats.pending_consolidation, 'stats.pending_consolidation');
  const statuses = object(stats.operations_by_status, 'stats.operations_by_status');
  count(statuses.pending ?? 0, 'operations.pending');
  count(statuses.processing ?? 0, 'operations.processing');
  return stats;
}
function assertIdle(stats) {
  if (stats.pending_operations || stats.pending_consolidation || stats.operations_by_status.pending || stats.operations_by_status.processing) throw new Error('Hindsight 尚有 operation/consolidation，拒絕清除');
}
async function getPreserved(bank, bankId) {
  const [config, models, tree, directives, aliases, webhooks] = await Promise.all([
    request(`${bank}/config`), list(`${bank}/mental-models?detail=full`),
    request(`${bank}/knowledge-base/tree`), list(`${bank}/directives?active_only=false`),
    request(`${bank}/aliases`), list(`${bank}/webhooks`),
  ]);
  if (config.bank_id !== bankId) throw new Error('config.bank_id 與目標不符');
  object(config.config, 'config.config');
  object(config.overrides, 'config.overrides');
  for (const model of models) {
    string(model.id, 'model.id');
    if (model.bank_id !== bankId) throw new Error('心智模型 bank_id 不符');
  }
  const pages = [];
  async function walk(nodes) {
    if (!Array.isArray(nodes)) throw new Error('knowledge tree 無效');
    for (const node of nodes) {
      string(node.id, 'knowledge.id');
      if (node.kind === 'page') {
        const page = await request(`${bank}/knowledge-base/pages/${encodeURIComponent(node.id)}`);
        if (page.id !== node.id || typeof page.markdown !== 'string') throw new Error('knowledge page 無效');
        pages.push(page);
      } else if (node.kind !== 'folder') throw new Error('knowledge.kind 無效');
      if (node.children !== undefined) await walk(node.children);
    }
  }
  await walk(tree.roots);
  return { config, models, tree, pages: sorted(pages), directives, aliases, webhooks };
}
async function assertStopped() {
  if (spawnSync('systemctl', ['is-active', '--quiet', 'butler']).status === 0) throw new Error('Butler 仍在執行，請先停止服務（npm stop）');
}
function rows(db, table) { return sorted(db.prepare(`SELECT * FROM "${table}"`).all()); }
function counts(db) { return Object.fromEntries(CLEAR_TABLES.map(table => [table, Number(db.prepare(`SELECT COUNT(*) n FROM "${table}"`).get().n)])); }
function preservedSqlite(db) { return Object.fromEntries(KEEP_TABLES.map(table => [table, rows(db, table)])); }
export function checkSchema(db) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(row => row.name);
  for (const table of [...CLEAR_TABLES, ...KEEP_TABLES, ...LINK_TABLES]) {
    if (!tables.includes(table)) throw new Error(`SQLite 缺少資料表：${table}`);
  }
  if (db.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all().length) throw new Error('SQLite 有 trigger，拒絕額外清除副作用');
  for (const table of tables) {
    if (CLEAR_TABLES.includes(table)) continue;
    for (const foreignKey of db.prepare(`PRAGMA foreign_key_list("${table}")`).all()) {
      if (CLEAR_TABLES.includes(foreignKey.table)) throw new Error(`${table} 外鍵指向清除表，拒絕連帶影響保留資料`);
    }
  }
  if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('SQLite 原有外鍵違規，停止');
}
export function resetChats(db, channels, sources = []) {
  for (const table of CLEAR_TABLES) db.exec(`DELETE FROM "${table}"`);
  const mapping = new Map();
  for (const row of channels) {
    if (mapping.has(row.session_id)) continue;
    const id = randomUUID();
    mapping.set(row.session_id, id);
    db.prepare('INSERT INTO sessions(id,created_at) VALUES(?,?)').run(id, new Date().toISOString());
  }
  for (const row of channels) db.prepare('UPDATE channel_state SET session_id=? WHERE channel_id=?').run(mapping.get(row.session_id), row.channel_id);
  for (const source of sources) {
    if (!mapping.has(source.session_id)) continue;
    db.prepare('INSERT INTO session_sources(session_id,channel_id,source_type,owner_id,bot_id) VALUES(?,?,?,?,?)').run(mapping.get(source.session_id), source.channel_id, source.source_type, source.owner_id, source.bot_id);
  }
  for (const table of CLEAR_TABLES) {
    if (table !== 'sessions' && table !== 'session_sources' && countsFor(db, table) !== 0) throw new Error(`清除表仍有資料：${table}`);
  }
  if (!same(rows(db, 'channel_state'), sorted(channels.map(row => ({ ...row, session_id: mapping.get(row.session_id) }))))) throw new Error('頻道設定核對失敗');
  if (countsFor(db, 'sessions') !== mapping.size || db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('新會話或外鍵核對失敗');
}
function countsFor(db, table) { return Number(db.prepare(`SELECT COUNT(*) n FROM "${table}"`).get().n); }
async function saveBackup(db, bankId, snapshot) {
  const dir = path.join(BACKUP_ROOT, new Date().toISOString().replace(/[:.]/g, '-'));
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700);
  const database = path.join(dir, 'butler-before-reset.sqlite');
  await backup(db, database);
  await fs.chmod(database, 0o600);
  const check = new DatabaseSync(database, { readOnly: true });
  try {
    if (check.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw new Error('SQLite 備份完整性檢查失敗');
    if (!same(counts(check), counts(db)) || !same(preservedSqlite(check), preservedSqlite(db))) throw new Error('SQLite 備份核對失敗');
  } finally { check.close(); }
  const json = path.join(dir, `${bankId.replace(/[^\w.-]/g, '_')}-preserved-hindsight.json`);
  await fs.writeFile(json, `${JSON.stringify(snapshot, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  if (!same(JSON.parse(await fs.readFile(json, 'utf8')), snapshot)) throw new Error('知識快照備份核對失敗');
  return dir;
}
async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { console.log(HELP); return; }
  const config = YAML.parse(await fs.readFile(path.join(ROOT, '.data/config.yaml'), 'utf8'));
  const bankId = string(options.bankId ?? config?.memory?.bankId, 'memory.bankId');
  const base = string(options.baseUrl ?? config?.memory?.baseUrl, 'memory.baseUrl').replace(/\/$/, '');
  const url = new URL(base);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('base URL 必須為無憑證的 http(s) URL');
  const rawDatabase = string(options.database ?? config?.paths?.database, 'paths.database');
  if (!path.isAbsolute(rawDatabase)) throw new Error('SQLite 路徑必須是絕對路徑');
  const database = path.resolve(rawDatabase);
  if (options.execute && (options.confirmBank !== bankId || options.confirmDatabase !== database)) throw new Error('確認值必須與目標 bank ID、絕對 SQLite 路徑完全相同');
  if (!(await fs.stat(database)).isFile()) throw new Error('SQLite 不是一般檔案');
  if (options.execute) await assertStopped();
  const db = new DatabaseSync(database, { readOnly: !options.execute });
  try {
    checkSchema(db);
    const beforeCounts = counts(db);
    const kept = preservedSqlite(db);
    const channels = rows(db, 'channel_state');
    const sources = rows(db, 'session_sources');
    const bank = `${base}/v1/default/banks/${encodeURIComponent(bankId)}`;
    const banks = await list(`${base}/v1/default/banks`, 'banks');
    const profile = banks.find(row => row.bank_id === bankId);
    if (!profile) throw new Error('找不到精確 bank ID；不接受 alias 或自動建立');
    const stats = await getStats(bank);
    const snapshot = await getPreserved(bank, bankId);
    console.log(`模式：${options.execute ? 'execute' : 'preview'}\nURL：${base}\nBank：${bankId}\nSQLite：${database}\nHindsight nodes/documents：${stats.total_nodes}/${stats.total_documents}\nPending operations/consolidation：${stats.pending_operations}/${stats.pending_consolidation}\n清除表筆數：${JSON.stringify(beforeCounts)}\n保留排程/設定表：${KEEP_TABLES.join(', ')}\n保留心智模型：${snapshot.models.length}；知識頁：${snapshot.pages.length}\n不刪 bank、人物 markdown、本地附件/journal 或 Discord 遠端訊息。`);
    if (!options.execute) return;
    assertIdle(stats);
    const backupDir = await saveBackup(db, bankId, { source: { base, bankId, database }, bankProfile: profile, ...snapshot });
    console.log(`備份（含旧聊天與知識，非 Hindsight 原始記憶備份）：${backupDir}`);
    let transaction = false;
    let remoteAttempted = false;
    let remoteDone = false;
    let stage = 'SQLite 清除';
    try {
      db.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE');
      transaction = true;
      if (!same(counts(db), beforeCounts) || !same(preservedSqlite(db), kept) || !same(rows(db, 'channel_state'), channels) || !same(rows(db, 'session_sources'), sources)) throw new Error('備份後 SQLite 資料改變，停止');
      resetChats(db, channels, sources);
      if (!same(preservedSqlite(db), kept)) throw new Error('SQLite 保留資料改變');
      await assertStopped();
      assertIdle(await getStats(bank));
      if (!samePreserved(await getPreserved(bank, bankId), snapshot)) throw new Error('清除前 Hindsight 保留資料改變');
      stage = 'Hindsight DELETE memories';
      remoteAttempted = true;
      const deletion = await request(`${bank}/memories`, 'DELETE');
      if (deletion.success !== true) throw new Error('DELETE 未確認 success=true；結果未知');
      remoteDone = true;
      stage = '核對 Hindsight 與提交 SQLite';
      const after = await getStats(bank);
      if (after.total_nodes !== 0 || after.total_documents !== 0) throw new Error('Hindsight 記憶/文件未歸零');
      assertIdle(after);
      if (!samePreserved(await getPreserved(bank, bankId), snapshot)) throw new Error('Hindsight 知識頁、心智模型或設定核對失敗');
      if (!same(preservedSqlite(db), kept)) throw new Error('SQLite 保留資料核對失敗');
      db.exec('COMMIT');
      transaction = false;
      console.log('完成：Hindsight 記憶/文件=0，SQLite 聊天與待送批次=0；知識頁、心智模型、排程與頻道設定保留。');
    } catch (error) {
      if (transaction) db.exec('ROLLBACK');
      const remote = remoteDone ? 'Hindsight 已執行清空' : remoteAttempted ? 'Hindsight 清除結果未知' : '尚未修改 Hindsight';
      throw new Error(`失敗階段：${stage}；${remote}，SQLite 未提交。備份：${backupDir}。未自動重試。原因：${error.message}`);
    }
  } finally { db.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(`停止：${error.message}`); process.exitCode = 1; });
}
