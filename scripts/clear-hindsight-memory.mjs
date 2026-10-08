import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATH = path.join(ROOT, 'config.yaml');
const BACKUP_ROOT = path.join(ROOT, 'backups', 'hindsight');
const GET_TIMEOUT = 30_000;
const MUTATION_TIMEOUT = 120_000;
const HELP = `用法：node scripts/clear-hindsight-memory.mjs [--help] [--bank-id <id>] [--base-url <url>] [--execute --confirm-bank <id>]

預設讀取 config.yaml 的 memory.bankId 與 memory.baseUrl，僅執行唯讀預覽；不會建立備份或修改服務。
--bank-id <id>       指定精確 bank ID（不接受 alias）
--base-url <url>     指定 Hindsight base URL
--execute            執行完整 bank 刪除與重建
--confirm-bank <id>  執行時必須與 bank ID 完全相同；不可省略
--help               顯示說明

執行前請停止 Butler 與其他所有寫入來源，並等待 Hindsight 背景工作完成。腳本會拒絕進行中的 operation/consolidation；重建後新聊天會重新寫入記憶。腳本不清 Butler 本地待送記憶批次；若仍有舊批次未送出，重啟後仍可能寫入 Hindsight。執行前請先讓 Butler 待送批次送完，再停止 Butler 與其他寫入來源，並等待 Hindsight 作業完成，之後才執行 --execute。此流程刪除並重建整個 bank，包含記憶及知識頁；不操作 Butler SQLite、人物 markdown 或本地聊天紀錄。別名或 webhook 非空時不支援執行，以免遺失。執行前會建立不含記憶、文件或知識頁內容的設定備份。`;

function parseArgs(args) {
  const options = { execute: false, help: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help') options.help = true;
    else if (arg === '--execute') options.execute = true;
    else if (arg === '--bank-id' || arg === '--base-url' || arg === '--confirm-bank') {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`${arg} 需要值`);
      const key = arg === '--bank-id' ? 'bankId' : arg === '--base-url' ? 'baseUrl' : 'confirmBank';
      if (options[key] !== undefined) throw new Error(`參數不可重複：${arg}`);
      options[key] = value;
    } else throw new Error(`未知參數或位置參數：${arg}`);
  }
  if (options.help && args.length !== 1) throw new Error('--help 不可與其他參數併用');
  if (options.execute && !options.confirmBank) throw new Error('--execute 必須搭配 --confirm-bank <bank-id>');
  if (!options.execute && options.confirmBank) throw new Error('--confirm-bank 只能搭配 --execute');
  return options;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
function same(a, b) { return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b)); }
function requiredString(value, label) { if (typeof value !== 'string' || !value) throw new Error(`${label} 欄位無效`); return value; }
function requiredObject(value, label) { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} 欄位無效`); return value; }
function requiredCount(value, label) { if (!Number.isFinite(value) || value < 0) throw new Error(`${label} 欄位無效`); return value; }

async function request(url, method = 'GET', body, timeoutMs = GET_TIMEOUT) {
  let response;
  try {
    response = await fetch(url, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw new Error(`${method} ${url} 連線失敗${method === 'GET' ? '' : '；結果未知'}：${error.message}`);
  }
  let text;
  try { text = await response.text(); } catch (error) { throw new Error(`${method} HTTP ${response.status} 讀取回應失敗${method === 'GET' ? '' : '；結果未知'}：${error.message}`); }
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { throw new Error(`${method} HTTP ${response.status} 回應不是有效 JSON${method === 'GET' ? '' : '；結果未知'}`); } }
  if (!response.ok) throw new Error(`${method} HTTP ${response.status}${response.status >= 500 && method !== 'GET' ? '；結果未知' : ''}`);
  return data;
}
function bankUrl(baseUrl, bankId) { return `${baseUrl.replace(/\/$/, '')}/v1/default/banks/${encodeURIComponent(bankId)}`; }
async function getConfig(baseUrl, bankId) {
  const data = requiredObject(await request(`${bankUrl(baseUrl, bankId)}/config`), 'config');
  if (data.bank_id !== bankId) throw new Error(`config.bank_id 與目標不符：${String(data.bank_id)}`);
  return { resolvedConfig: requiredObject(data.config, 'config.config'), overrides: requiredObject(data.overrides, 'config.overrides') };
}
async function getStats(baseUrl, bankId) {
  const data = requiredObject(await request(`${bankUrl(baseUrl, bankId)}/stats?refresh=true`), 'stats');
  const stats = { nodes: requiredCount(data.total_nodes, 'stats.total_nodes'), documents: requiredCount(data.total_documents, 'stats.total_documents'), pendingOperations: requiredCount(data.pending_operations, 'stats.pending_operations'), pendingConsolidation: requiredCount(data.pending_consolidation, 'stats.pending_consolidation') };
  const statuses = requiredObject(data.operations_by_status, 'stats.operations_by_status');
  stats.pendingByStatus = requiredCount(statuses.pending ?? 0, 'stats.operations_by_status.pending');
  stats.processingByStatus = requiredCount(statuses.processing ?? 0, 'stats.operations_by_status.processing');
  return stats;
}
function assertIdle(stats) {
  if (stats.pendingOperations || stats.pendingByStatus || stats.processingByStatus || stats.pendingConsolidation > 0) {
    throw new Error(`Hindsight 有背景工作尚未完成：pending_operations=${stats.pendingOperations}，pending=${stats.pendingByStatus}，processing=${stats.processingByStatus}，pending_consolidation=${JSON.stringify(stats.pendingConsolidation)}`);
  }
}
async function getBank(baseUrl, bankId) {
  let offset = 0;
  while (true) {
    const data = requiredObject(await request(`${baseUrl.replace(/\/$/, '')}/v1/default/banks?limit=100&offset=${offset}`), 'banks');
    if (!Array.isArray(data.banks)) throw new Error('banks.banks 欄位無效');
    const found = data.banks.find(bank => bank?.bank_id === bankId);
    if (found) return requiredString(found.name, 'bank.name');
    const total = requiredCount(data.total, 'banks.total');
    if (offset + data.banks.length >= total) break;
    if (data.banks.length === 0) throw new Error('bank 清單分頁未前進');
    offset += data.banks.length;
  }
  throw new Error(`找不到精確 bank ID：${bankId}；不會自動建立 bank`);
}
async function getDirectives(baseUrl, bankId) {
  const items = [];
  let offset = 0;
  while (true) {
    const data = requiredObject(await request(`${bankUrl(baseUrl, bankId)}/directives?limit=100&offset=${offset}`), 'directives');
    if (!Array.isArray(data.items)) throw new Error('directives.items 欄位無效');
    const total = requiredCount(data.total, 'directives.total');
    for (const item of data.items) {
      requiredObject(item, 'directive');
      requiredString(item.name, 'directive.name');
      requiredString(item.content, 'directive.content');
      if (!Number.isInteger(item.priority)) throw new Error('directive.priority 欄位無效');
      if (typeof item.is_active !== 'boolean' || !Array.isArray(item.tags) || item.tags.some(tag => typeof tag !== 'string')) throw new Error('directive.is_active/tags 欄位無效');
      items.push({ name: item.name, content: item.content, priority: item.priority, is_active: item.is_active, tags: item.tags });
    }
    if (items.length >= total) break;
    if (data.items.length === 0) throw new Error('directives 分頁未前進');
    offset += data.items.length;
  }
  return items;
}
async function getNonemptyCollection(baseUrl, url, label) {
  const data = requiredObject(await request(url), label);
  if (Array.isArray(data)) return data.length > 0;
  if (Array.isArray(data.items)) return data.items.length > 0;
  if (Array.isArray(data.aliases)) return data.aliases.length > 0;
  throw new Error(`${label} 回應欄位無效`);
}
async function getAliases(baseUrl, bankId) { return getNonemptyCollection(baseUrl, `${bankUrl(baseUrl, bankId)}/aliases`, 'aliases'); }
async function getWebhooks(baseUrl, bankId) {
  let offset = 0;
  while (true) {
    const data = requiredObject(await request(`${bankUrl(baseUrl, bankId)}/webhooks?limit=100&offset=${offset}`), 'webhooks');
    if (!Array.isArray(data.items)) throw new Error('webhooks.items 欄位無效');
    const total = requiredCount(data.total, 'webhooks.total');
    if (data.items.length) return true;
    if (offset + data.items.length >= total) return false;
    throw new Error('webhooks 分頁未前進');
  }
}
async function saveBackup(bankId, backup) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safeId = bankId.replace(/[^a-zA-Z0-9._-]/g, '_') || 'bank';
  const directory = path.join(BACKUP_ROOT, timestamp);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700);
  const file = path.join(directory, `${safeId}-before-reset.json`);
  const handle = await fs.open(file, 'wx', 0o600);
  try { await handle.writeFile(`${JSON.stringify(backup, null, 2)}\n`, { encoding: 'utf8' }); await handle.sync(); }
  finally { await handle.close(); }
  await fs.chmod(file, 0o600);
  const saved = JSON.parse(await fs.readFile(file, 'utf8'));
  if (!same(saved, backup)) throw new Error(`備份寫入後驗證不符：${file}`);
  return file;
}
function directiveView(items) {
  return items.map(item => ({ name: item.name, content: item.content, priority: item.priority, is_active: item.is_active, tags: item.tags })).sort((a, b) => JSON.stringify(canonical(a)).localeCompare(JSON.stringify(canonical(b))));
}
async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { console.log(HELP); return; }
  const parsed = YAML.parse(await fs.readFile(CONFIG_PATH, 'utf8'));
  const memory = requiredObject(parsed?.memory, 'config.yaml memory');
  const bankId = options.bankId ?? requiredString(memory.bankId, 'memory.bankId');
  const baseUrl = options.baseUrl ?? requiredString(memory.baseUrl, 'memory.baseUrl');
  if (!/^https?:\/\//.test(baseUrl)) throw new Error('--base-url 必須是 http(s) URL');
  if (options.execute && options.confirmBank !== bankId) throw new Error('--confirm-bank 必須與目標 bank ID 完全相同');
  const base = baseUrl.replace(/\/$/, '');
  const [bankName, initialConfig, initialStats, directives, aliases, webhooks] = await Promise.all([
    getBank(base, bankId), getConfig(base, bankId), getStats(base, bankId), getDirectives(base, bankId), getAliases(base, bankId), getWebhooks(base, bankId),
  ]);
  console.log(`模式：${options.execute ? 'execute' : 'preview'}\nURL：${base}\nBank ID：${bankId}\nBank 名稱：${bankName}\n記憶節點：${initialStats.nodes}\n文件：${initialStats.documents}\nDirectives：${directives.length}\nAliases：${aliases ? '非空' : '空'}\nWebhooks：${webhooks ? '非空' : '空'}\n刪除範圍：刪除並重建整個 bank（包含記憶與知識頁）\n保留設定 overrides 欄位數：${Object.keys(initialConfig.overrides).length}\n保留 directives：${directives.length} 項\n請先讓 Butler 待送記憶批次送完，再停止 Butler 與其他寫入來源，並等待 Hindsight 背景工作完成。腳本不清本地待送批次；重啟後舊批次仍可能寫入。`);
  if (!options.execute) {
    if (aliases || webhooks) console.log('限制：aliases 或 webhooks 非空時，execute 會拒絕以免遺失。');
    return;
  }
  if (aliases || webhooks) throw new Error('拒絕執行：目前腳本不支援保留非空 aliases 或 webhooks');
  assertIdle(initialStats);
  const backup = {
    backed_up_at: new Date().toISOString(), source: { base_url: base, bank_id: bankId }, bank_name: bankName,
    overrides: initialConfig.overrides, resolved_config: initialConfig.resolvedConfig, directives,
    restore_bank_request: { method: 'PUT', path: `/v1/default/banks/${encodeURIComponent(bankId)}`, body: { name: bankName } },
    restore_config_request: { method: 'PATCH', path: `/v1/default/banks/${encodeURIComponent(bankId)}/config`, body: { updates: initialConfig.overrides } },
  };
  const backupPath = await saveBackup(bankId, backup);
  console.log(`備份：${backupPath}`);
  assertIdle(await getStats(base, bankId));
  let stage = 'DELETE bank';
  try {
    const deletion = requiredObject(await request(`${bankUrl(base, bankId)}`, 'DELETE', undefined, MUTATION_TIMEOUT), 'DELETE response');
    if (deletion.success !== true) throw new Error('DELETE 回應未確認 success=true；結果未知');
    stage = 'PUT bank';
    const created = requiredObject(await request(bankUrl(base, bankId), 'PUT', { name: bankName }, MUTATION_TIMEOUT), 'PUT response');
    if (created.bank_id !== bankId) throw new Error('PUT 回應 bank_id 與目標不符；結果未知');
    stage = 'PATCH config';
    const patched = requiredObject(await request(`${bankUrl(base, bankId)}/config`, 'PATCH', { updates: initialConfig.overrides }, MUTATION_TIMEOUT), 'PATCH config response');
    if (patched.bank_id !== bankId) throw new Error('PATCH config 回應 bank_id 與目標不符；結果未知');
    stage = 'POST directives';
    for (const directive of directives) {
      const restored = requiredObject(await request(`${bankUrl(base, bankId)}/directives`, 'POST', directive, MUTATION_TIMEOUT), 'POST directive response');
      if (restored.name !== directive.name) throw new Error(`directive ${directive.name} 回應身分不符；結果未知`);
    }
    stage = 'verify config';
    const finalConfig = await getConfig(base, bankId);
    if (!same(finalConfig.overrides, initialConfig.overrides)) throw new Error('重建後 overrides 與備份不同');
    stage = 'verify directives';
    const finalDirectives = await getDirectives(base, bankId);
    if (!same(directiveView(finalDirectives), directiveView(directives))) throw new Error('重建後 directives 與備份不同');
    stage = 'verify stats';
    const finalStats = await getStats(base, bankId);
    if (finalStats.nodes !== 0 || finalStats.documents !== 0) throw new Error(`重建後仍有記憶：nodes=${finalStats.nodes} documents=${finalStats.documents}`);
    stage = 'verify knowledge tree';
    const tree = requiredObject(await request(`${bankUrl(base, bankId)}/knowledge-base/tree`), 'knowledge tree');
    if (!Array.isArray(tree.roots) || tree.roots.length !== 0) throw new Error('重建後 knowledge-base roots 非空或欄位無效');
    console.log('完成：bank 已重建，設定、directives 已還原，記憶與知識頁為空。');
  } catch (error) {
    throw new Error(`失敗階段：${stage}。備份：${backupPath}。資料可能已刪除或設定未完整還原；已停止，未回滾、未重試。${stage === 'DELETE bank' ? ' DELETE 後 HTTP 5xx/timeout 時結果尤其未知。' : ''}原因：${error.message}`);
  }
}
main().catch(error => { console.error(`停止：${error.message}`); process.exitCode = 1; });
