import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, open, readdir, realpath, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { ToolUsageError } from './tool-errors.js';
import type { FinanceIdentity } from './finance-origin.js';
import { isAuthorizedFinanceOrigin } from './finance-origin.js';

export type HledgerConfig = { enabled: boolean; journalPath: string; executablePath: string };
const str = { type: 'string', minLength: 1 };
const date = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' };
const posting = { type: 'object', properties: { account: str, amount: { type: 'string', pattern: '^-?(?:0|[1-9]\\d*)(?:\\.\\d+)?$' }, currency: { type: 'string', pattern: '^[A-Z][A-Z0-9]{2,11}$' }, cost_amount: { type: 'string', pattern: '^-?(?:0|[1-9]\\d*)(?:\\.\\d+)?$' }, cost_currency: { type: 'string', pattern: '^[A-Z][A-Z0-9]{2,11}$' } }, required: ['account','amount','currency'], additionalProperties: false };
const tool = (name: string, description: string, properties: Record<string, unknown>, required: string[]) => ({ type: 'function', name, description, parameters: { type: 'object', properties, required, additionalProperties: false } });
export const hledgerDefinitions = [
  tool('hledger_accounts', '查詢 hledger 科目 metadata 與指定日期各原幣餘額。', { as_of: date, account: str }, []),
  tool('hledger_account_manage', '建立或更新受控科目 metadata；hide 只隱藏不刪歷史。只接受結構化名稱、類型、幣別與備註，不接受 journal 片段。', { action:{type:'string',enum:['create','update','hide','show']}, name:str, type:{type:'string',enum:['asset','liability','equity','income','expense']}, currency:{type:'string',pattern:'^[A-Z][A-Z0-9]{2,11}$'}, note:{type:'string',maxLength:200} }, ['action','name']),
  tool('hledger_schedules_list', '查詢月／雙月 periodic 規劃與啟停狀態。規則只供 forecast/budget，不代表實際付款。', {}, []),
  tool('hledger_schedule_manage', '新增、修改、啟用、停用或刪除月／雙月規劃。結構化生成 periodic 規則；不自動入帳為實際交易。', {action:{type:'string',enum:['create','update','enable','disable','delete']},schedule_id:{type:'string',pattern:'^[A-Za-z0-9._:-]{1,120}$'},name:str,frequency:{type:'string',enum:['monthly','bimonthly']},start_date:date,postings:{type:'array',minItems:2,maxItems:30,items:posting}},['action','schedule_id']),
  tool('hledger_post', '新增、修改或刪除一筆多 postings 帳務交易。source_id 為穩定外部唯一識別；重複建立會拒絕。金額方向依帳戶類型確認。每 posting 一科目，可拆分帳單；換匯以 cost_amount/cost_currency 表示成本。', { action: { type: 'string', enum: ['create','update','delete'] }, source_id: { type: 'string', pattern: '^[A-Za-z0-9._:-]{1,120}$' }, date, description: str, postings: { type: 'array', minItems: 2, maxItems: 30, items: posting } }, ['action','source_id']),
  tool('hledger_reconcile', '核對某帳戶指定日期銀行餘額；差額以 equity:reconciliation 新增獨立調整分錄，並在同日 posting 上附 balance assertion。從不改寫既有歷史、絕不記收入/支出。需要來源識別碼。', { account: str, date, currency: { type: 'string', pattern: '^[A-Z][A-Z0-9]{2,11}$' }, target_balance: { type: 'string', pattern: '^-?(?:0|[1-9]\\d*)(?:\\.\\d+)?$' }, source_id: { type: 'string', pattern: '^[A-Za-z0-9._:-]{1,120}$' } }, ['account','date','currency','target_balance','source_id']),
  tool('hledger_reconciliation_reopen', '明確重開指定帳戶/幣別 from_date 起的 runtime 校正；只移除可精確驗證的本工具校正分錄及 assertion，保留業務交易。外部/不明 assertion 或多帳戶調整會拒絕；成功只回報待重對清單，不代表已對帳。', {account:str,currency:{type:'string',pattern:'^[A-Z][A-Z0-9]{2,11}$'},from_date:date,reason:{type:'string',minLength:1,maxLength:300}}, ['account','currency','from_date','reason']),
  tool('hledger_forecast', '以 hledger periodic rules 查詢預測；結果是虛擬 forecast，不會寫成實際帳務。', { begin: date, end: date }, ['begin','end']),
  tool('hledger_budget', '依 periodic rules 查詢預算與實際執行；規則本身不會被當成已發生交易。', { begin: date, end: date, account: str }, ['begin','end']),
  tool('hledger_backup_list', '列出私有帳本的版本化本機備份。', {}, []),
  tool('hledger_backup_restore', '還原指定備份 ID；先保留現行帳本為回退版本，並檢查候選帳本。獨立操作紀錄與已使用來源 ID 不隨還原回退。', { backup_id: { type: 'string', pattern: '^[A-Za-z0-9-]{1,80}$' } }, ['backup_id']),
  tool('hledger_lock_status', '唯讀檢查帳本鎖；不會自行清除鎖或停止程序。', {}, []),
  tool('hledger_operations_list', '查看獨立持久操作紀錄的狀態與來源 ID；不包含帳本交易內容。', {}, []),
] as const;

type Posting = { account: string; amount: string; currency: string; cost_amount?: string; cost_currency?: string };
type Args = Record<string, unknown>;
const ID = /^[A-Za-z0-9._:-]{1,120}$/;
const ACCOUNT = /^[\p{L}\p{N}][\p{L}\p{N}\p{M} _:-]{0,159}$/u;
const MONEY = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;
const CURRENCY = /^[A-Z][A-Z0-9]{2,11}$/;
const SAFE_OUTPUT = 256 * 1024;
type LedgerOperationStatus = 'pending' | 'completed' | 'rejected' | 'unknown';
type LedgerOperation = { status: LedgerOperationStatus; tool: string; sourceId?: string; result?: unknown; updatedAt: string };
type AccountMetadata = { type?: 'asset'|'liability'|'equity'|'income'|'expense'; currency?: string; note?: string; hidden?: boolean };
type ScheduleMetadata = { id: string; name: string; frequency: 'monthly'|'bimonthly'; startDate: string; enabled: boolean; deleted?: boolean; postings: Posting[] };
type SourceRef = { account: string; currency: string };
type SourceOperation = { status: 'pending' | 'active' | 'voided' | 'unknown'; tool: string; updatedAt: string; date?: string; postings?: SourceRef[] };
type OperationLedger = { version: 1; operations: Record<string, LedgerOperation>; sources: Record<string, SourceOperation>; cuts: Record<string, Record<string, string>>; accounts?: Record<string, AccountMetadata>; schedules?: Record<string, ScheduleMetadata> };

export type HledgerRuntime = { definitions: Array<(typeof hledgerDefinitions)[number]>; execute(name: string, args: Args, origin?: FinanceIdentity): Promise<unknown> };
export function createHledgerToolRuntime(config: HledgerConfig): HledgerRuntime {
  const journal = resolve(config.journalPath), directory = dirname(journal), backups = resolve(directory, 'backups'), operationLedgerPath = resolve(directory, 'operations.json');
  if (!isAbsolute(config.journalPath) || !isAbsolute(config.executablePath) || !journal.includes(`${sep}.data${sep}finance${sep}`) || journal.includes(`${sep}public${sep}`)) throw new Error('hledger journal must be inside private .data/finance and executable path absolute');
  const executable = resolve(config.executablePath);
  const definitions = config.enabled ? [...hledgerDefinitions] : [];
  let inProcess = false;
  async function withLock<T>(fn: () => Promise<T>): Promise<T> {
    if (inProcess) throw new ToolUsageError('帳本已有操作進行中；本次未寫入。');
    inProcess = true;
    const lock = `${journal}.lock`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      if (await realpath(directory) !== directory) throw new ToolUsageError('Private ledger directory contains a symlink; no write performed.');
      await chmod(directory, 0o700);
      try { handle = await open(lock, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); }
      catch { throw new ToolUsageError('帳本鎖定中或鎖狀態未知；本次未寫入，不會自動重試。'); }
      await handle.writeFile(`${process.pid} ${new Date().toISOString()}\n`); await handle.sync();
      return await fn();
    } finally {
      await handle?.close().catch(() => undefined);
      if (handle) await rm(lock, { force: true }).catch(() => undefined);
      inProcess = false;
    }
  }
  async function check(path: string): Promise<void> { await run(['-f', path, 'check']); }
  async function run(args: string[]): Promise<string> {
    if (args.some(x => x.includes('\0')) || args.length > 40) throw new ToolUsageError('Invalid hledger arguments');
    const binaryStat = await lstat(executable);
    if (!binaryStat.isFile() || binaryStat.isSymbolicLink() || (binaryStat.mode & 0o022) !== 0 || (binaryStat.mode & 0o111) === 0) throw new ToolUsageError('Configured hledger executable is not a trusted regular executable.');
    const child = spawn(executable, args, { cwd: directory, shell: false, env: { PATH: '/usr/bin:/bin', HOME: directory, LANG: 'C.UTF-8' }, stdio: ['ignore','pipe','pipe'] });
    let out = '', err = '', size = 0;
    child.stdout.setEncoding('utf8').on('data', chunk => { size += Buffer.byteLength(chunk); if (size <= SAFE_OUTPUT) out += chunk; else child.kill('SIGTERM'); });
    child.stderr.setEncoding('utf8').on('data', chunk => { size += Buffer.byteLength(chunk); if (size <= SAFE_OUTPUT) err += chunk; else child.kill('SIGTERM'); });
    const code: number = await new Promise((resolveCode, reject) => {
      const timer = setTimeout(() => child.kill('SIGTERM'), 30_000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', c => { clearTimeout(timer); resolveCode(c ?? 1); });
    });
    if (size > SAFE_OUTPUT) throw new ToolUsageError('hledger output exceeded limit; command stopped.');
    if (code !== 0) throw new ToolUsageError(`hledger rejected the command or candidate (exit ${code}); output withheld to protect private ledger data.`);
    return out;
  }
  async function readJournal(): Promise<string> {
    const st = await lstat(journal);
    if (!st.isFile() || st.isSymbolicLink() || st.size > 20 * 1024 * 1024 || (st.mode & 0o077) !== 0) throw new ToolUsageError('帳本檔案不是受控私有檔案，已停止。');
    const actual = await realpath(journal);
    if (actual !== journal) throw new ToolUsageError('帳本路徑有符號連結，已停止。');
    const handle = await open(journal, constants.O_RDONLY | constants.O_NOFOLLOW); let text: string; try { text = await handle.readFile('utf8'); } finally { await handle.close(); }
    if (/^\s*(?:include|source)\s+/im.test(text)) throw new ToolUsageError('目前不接受 include/source 外部帳本檔，避免寫入範圍外。');
    return text;
  }
  function transaction(sourceId: string, day: string, description: string, postings: Posting[], assertion?: { account: string; currency: string; amount: string }): string {
    if (!ID.test(sourceId) || !validDate(day) || !description.trim() || description.length > 300 || postings.length < 2 || postings.length > 30) throw new ToolUsageError('交易欄位無效。');
    const rows = postings.map(p => {
      if (!ACCOUNT.test(p.account) || !MONEY.test(p.amount) || !CURRENCY.test(p.currency)) throw new ToolUsageError('posting 科目、金額或幣別格式無效。');
      if ((p.cost_amount === undefined) !== (p.cost_currency === undefined) || (p.cost_amount !== undefined && (!MONEY.test(p.cost_amount) || !CURRENCY.test(p.cost_currency!)))) throw new ToolUsageError('換匯 cost 欄位須成對且格式正確。');
      return `    ${p.account.padEnd(40)} ${p.currency} ${p.amount}${p.cost_amount === undefined ? '' : ` @ ${p.cost_currency} ${p.cost_amount}`}`;
    });
    if (assertion) rows[0] += ` = ${assertion.currency} ${assertion.amount}`;
    return `${day} ${description.replace(/[\r\n;]/g, ' ').trim()}  ; source-id=${sourceId}\n${rows.join('\n')}\n`;
  }
  function periodicRule(rule: ScheduleMetadata): string {
    if (!ID.test(rule.id) || !validDate(rule.startDate) || !['monthly','bimonthly'].includes(rule.frequency) || !rule.name.trim() || rule.name.length > 120) throw new ToolUsageError('Periodic rule metadata invalid.');
    const tx = transaction(`schedule-${rule.id}`, rule.startDate, rule.name, rule.postings);
    const rows = tx.split('\n').slice(1).filter(Boolean);
    const period = rule.frequency === 'monthly' ? 'monthly' : 'every 2 months';
    return `~ ${period} from ${rule.startDate}  ${rule.name.replace(/[\r\n;]/g,' ').trim()}  ; schedule-id=${rule.id}\n${rows.join('\n')}\n`;
  }
  async function withPlanningJournal<T>(fn: (path: string) => Promise<T>): Promise<T> {
    const ledger = await readOperationLedger(), rules = Object.values(ledger.schedules ?? {}).filter(rule => rule.enabled && !rule.deleted).map(periodicRule).join('\n');
    if (!rules) return fn(journal);
    const temporary = `${journal}.${randomUUID()}.forecast`;
    const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(`${await readJournal()}\n${rules}`, 'utf8'); await handle.sync(); await handle.close(); await check(temporary); return await fn(temporary); }
    finally { await handle.close().catch(() => undefined); await rm(temporary, { force: true }).catch(() => undefined); }
  }
  function accountMetaLine(name: string, metadata: AccountMetadata): string {
    return `account ${name}  ; renee-account-meta=${Buffer.from(JSON.stringify({name,...metadata}),'utf8').toString('base64url')}`;
  }
  function accountMetadata(text: string): Map<string, AccountMetadata> {
    const result = new Map<string,AccountMetadata>();
    for (const line of text.split('\n')) {
      const token = /; renee-account-meta=([A-Za-z0-9_-]+)$/.exec(line)?.[1]; if (!token) continue;
      try { const x=JSON.parse(Buffer.from(token,'base64url').toString('utf8')); if (x && typeof x.name==='string' && ACCOUNT.test(x.name)) result.set(x.name,{type:x.type,currency:x.currency,note:typeof x.note==='string'?x.note:'',hidden:x.hidden===true}); } catch { throw new ToolUsageError('Account metadata is malformed; no write performed.'); }
    }
    return result;
  }
  function replaceTaggedEntry(text: string, marker: string, keyOf: (value: any)=>string, wanted: string, replacement: string): string {
    const lines=text.split('\n'); const out:string[]=[]; let found=false;
    for (const line of lines) {
      if (line.includes(marker)) {
        let key=''; try { key=keyOf(JSON.parse(Buffer.from(line.slice(line.indexOf(marker)+marker.length),'base64url').toString('utf8'))); } catch { throw new ToolUsageError('Managed metadata is malformed; no write performed.'); }
        if (key===wanted) { found=true; if(replacement) out.push(replacement); continue; }
      }
      out.push(line);
    }
    if(!found && replacement) out.push(replacement);
    return out.join('\n').replace(/\n*$/,'\n');
  }
  async function checkScheduleRules(baseText: string, schedules: ScheduleMetadata[]): Promise<void> {
    const rules = schedules.filter(x=>x.enabled&&!x.deleted).map(periodicRule).join('\n');
    const candidate = `${journal}.${randomUUID()}.schedule`;
    let handle;
    try {
      handle = await open(candidate,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
      await handle.writeFile(`${baseText.trimEnd()}\n${rules}\n`,'utf8'); await handle.sync(); await handle.close(); handle=undefined;
      await check(candidate);
      for (const rule of schedules.filter(x=>x.enabled&&!x.deleted)) {
        const end = nextDate(addDays(rule.startDate,90));
        await run(['-f',candidate,'print',`--forecast=${rule.startDate}..${end}`]);
      }
    } finally { await handle?.close().catch(()=>undefined); await rm(candidate,{force:true}).catch(()=>undefined); }
  }
  async function commit(oldText: string, nextText: string): Promise<void> {
    if (await readJournal() !== oldText) throw new ToolUsageError('帳本在本次操作期間已變更；候選未套用。');
    const candidate = `${journal}.${randomUUID()}.candidate`;
    const previous = resolve(backups, `${new Date().toISOString().replace(/[:.]/g,'-')}-${randomUUID().slice(0,8)}.bak`);
    let file;
    let swapped = false;
    try {
      file = await open(candidate, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      await file.writeFile(nextText, 'utf8'); await file.sync(); await file.close(); file = undefined;
      await check(candidate);
      await mkdir(backups, { recursive: true, mode: 0o700 }); await chmod(backups, 0o700);
      await copyFile(journal, previous, constants.COPYFILE_EXCL); await chmod(previous, 0o600);
      const backupHandle = await open(previous, constants.O_RDONLY | constants.O_NOFOLLOW); await backupHandle.sync(); await backupHandle.close();
      await rename(candidate, journal); swapped = true;
      const dirHandle = await open(directory, constants.O_RDONLY); await dirHandle.sync(); await dirHandle.close();
    } catch (error) {
      await file?.close().catch(() => undefined); await rm(candidate, { force: true }).catch(() => undefined);
      if (swapped) {
        const rollback = `${journal}.${randomUUID()}.rollback`;
        try { await copyFile(previous, rollback, constants.COPYFILE_EXCL); await chmod(rollback, 0o600); await rename(rollback, journal); const dirHandle = await open(directory, constants.O_RDONLY); await dirHandle.sync(); await dirHandle.close(); }
        catch { await rm(rollback, { force: true }).catch(() => undefined); throw Object.assign(new ToolUsageError('帳本寫入結果未知，回復亦未確認；禁止重送，需人工核對版本備份。'), { unknown: true }); }
      }
      throw error;
    }
  }
  const blankOperationLedger = (): OperationLedger => ({ version: 1, operations: {}, sources: {}, cuts: {}, accounts: {}, schedules: {} });
  type AssertionRecord = { account: string; currency: string; date: string; sourceId?: string; raw: string };
  function journalAssertions(text: string): AssertionRecord[] {
    const records: AssertionRecord[] = [];
    let date: string | undefined, sourceId: string | undefined;
    for (const raw of text.split('\n')) {
      const line = raw.replace(/\r$/, '');
      if (validDate(line.slice(0,10))) { date=line.slice(0,10); sourceId=/; source-id=([^\s]+)/.exec(line)?.[1]; continue; }
      if (!line.trim() || line.trimStart().startsWith('~')) { date=undefined; sourceId=undefined; continue; }
      if (!date || !line.includes('=')) continue;
      const tokens=line.trim().split(/\s+/), index=tokens.findIndex((token,i)=>i>0&&CURRENCY.test(token)&&i+2<tokens.length&&MONEY.test(tokens[i+1]!));
      if(index<1||!tokens.includes('=',index+2)) continue;
      records.push({account:tokens.slice(0,index).join(' '),currency:tokens[index]!,date,raw:line,...(sourceId?{sourceId}:{})});
    }
    return records;
  }
  function journalAssertionCuts(text: string, ignoredSourceIds = new Set<string>()): Record<string, Record<string, string>> {
    const cuts: Record<string, Record<string, string>> = {};
    for (const record of journalAssertions(text)) {
      if (record.sourceId && ignoredSourceIds.has(record.sourceId)) continue;
      cuts[record.account] ??= {};
      if (!cuts[record.account]![record.currency] || cuts[record.account]![record.currency]! < record.date) cuts[record.account]![record.currency] = record.date;
    }
    return cuts;
  }
  function reopenedReconciliationIds(ledger: OperationLedger): Set<string> {
    const ids=new Set<string>();
    for (const op of Object.values(ledger.operations)) if(op.status==='completed'&&op.tool==='hledger_reconciliation_reopen') {
      const result=op.result as {reopened_targets?:Array<{source_id:string}>}|undefined;
      for(const target of result?.reopened_targets??[]) ids.add(target.source_id);
    }
    return ids;
  }
  function deriveCuts(ledger: OperationLedger, text: string): Record<string, Record<string,string>> {
    const reopenedIds=reopenedReconciliationIds(ledger);
    const cuts=journalAssertionCuts(text,reopenedIds);
    for(const op of Object.values(ledger.operations)) {
      const result=op.result as {account?:string;currency?:string;date?:string}|undefined;
      if(op.status==='completed'&&op.tool==='hledger_reconcile'&&op.sourceId&&ledger.sources[op.sourceId]?.status==='active'&&!reopenedIds.has(op.sourceId)&&result?.account&&result.currency&&result.date&&validDate(result.date)) {
        cuts[result.account]??={};
        if(!cuts[result.account]![result.currency]||cuts[result.account]![result.currency]!<result.date) cuts[result.account]![result.currency]=result.date;
      }
    }
    return cuts;
  }
  async function readOperationLedger(): Promise<OperationLedger> {
    let ledger: OperationLedger;
    try {
      const st = await lstat(operationLedgerPath);
      if (!st.isFile() || st.isSymbolicLink() || st.size > 20 * 1024 * 1024 || (st.mode & 0o077) !== 0 || await realpath(operationLedgerPath) !== operationLedgerPath) throw new Error();
      const handle = await open(operationLedgerPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      let value: unknown; try { value = JSON.parse(await handle.readFile('utf8')); } finally { await handle.close(); }
      if (!value || typeof value !== 'object' || (value as any).version !== 1 || !(value as any).operations || typeof (value as any).operations !== 'object' || !(value as any).sources || typeof (value as any).sources !== 'object') throw new Error();
      if (!(value as any).cuts) (value as any).cuts = {};
      if (!(value as any).accounts) (value as any).accounts = {};
      if (!(value as any).schedules) (value as any).schedules = {};
      if (typeof (value as any).cuts !== 'object' || Array.isArray((value as any).cuts) || typeof (value as any).accounts !== 'object' || Array.isArray((value as any).accounts) || typeof (value as any).schedules !== 'object' || Array.isArray((value as any).schedules)) throw new Error();
      ledger = value as OperationLedger;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') ledger = blankOperationLedger();
      else throw new ToolUsageError('持久帳本操作紀錄無法安全讀取；所有寫入已停用，請管理者核對，不可刪除此紀錄。');
    }
    ledger.cuts=deriveCuts(ledger,await readJournal());
    return ledger;
  }
  async function saveOperationLedger(ledger: OperationLedger): Promise<void> {
    const temporary = `${operationLedgerPath}.${randomUUID()}.tmp`;
    let handle;
    try {
      handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      await handle.writeFile(JSON.stringify(ledger), 'utf8'); await handle.sync(); await handle.close(); handle = undefined;
      await mkdir(backups, { recursive: true, mode: 0o700 }); await chmod(backups, 0o700);
      try { await lstat(operationLedgerPath); const version = resolve(backups, `${new Date().toISOString().replace(/[:.]/g,'-')}-${randomUUID().slice(0,8)}.operations.bak`); await copyFile(operationLedgerPath, version, constants.COPYFILE_EXCL); await chmod(version, 0o600); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      await rename(temporary, operationLedgerPath);
      const dirHandle = await open(directory, constants.O_RDONLY); await dirHandle.sync(); await dirHandle.close();
    } catch {
      await handle?.close().catch(() => undefined); await rm(temporary, { force: true }).catch(() => undefined);
      throw new ToolUsageError('持久操作紀錄保存失敗；禁止重送，請先人工核對帳本與 operation ledger。');
    }
  }
  function canonical(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
    return JSON.stringify(value);
  }
  async function ledgerOperation<T>(name: string, args: Args, origin: FinanceIdentity, sourceId: string | undefined, action: 'create' | 'update' | 'delete' | 'reconcile' | 'restore' | 'metadata' | 'reopen', work: () => Promise<T>, cut?: { account: string; currency: string; date: string }, sourceMetadata?: { date: string; postings: SourceRef[] }, applyLedger?: (ledger: OperationLedger, result: T) => void): Promise<T> {
    const ledger = await readOperationLedger();
    const digest = createHash('sha256').update(canonical(args)).digest('hex');
    const key = createHash('sha256').update(`${origin.messageId}\\0${name}\\0${digest}`).digest('hex');
    const previous = ledger.operations[key];
    if (previous) {
      if (previous.status === 'completed') return previous.result as T;
      throw new ToolUsageError('此 hledger 操作已有拒絕、待確認或未知結果；禁止自動重送，請先查帳本及操作紀錄。');
    }
    let priorSourceStatus: SourceOperation['status'] | undefined;
    if (sourceId) {
      const prior = ledger.sources[sourceId];
      const text = await readJournal();
      const existsInJournal = text.includes(`source-id=${sourceId}`) || text.includes(`voided-source-id=${sourceId}`);
      if ((action === 'create' || action === 'reconcile') && (prior || existsInJournal)) throw new ToolUsageError('source_id 已存在或曾使用；禁止重複入帳。');
      if (action === 'reopen' && prior) throw new ToolUsageError(prior.status === 'unknown' || prior.status === 'pending' ? 'Reopen operation status is unknown; inspect before retry.' : '此核對範圍已重開或已使用；請以明確新範圍建立另一筆操作。');
      if ((action === 'update' || action === 'delete') && (prior?.status === 'voided' || prior?.status === 'unknown' || prior?.status === 'pending')) throw new ToolUsageError('source_id 已刪除或結果未知；禁止重送。');
      if ((action === 'update' || action === 'delete') && !prior && !existsInJournal) throw new ToolUsageError('source_id 不在操作紀錄或帳本中。');
      priorSourceStatus = prior?.status ?? (existsInJournal ? 'active' : undefined);
      ledger.sources[sourceId] = { status: action === 'create' || action === 'reconcile' || action === 'reopen' ? 'pending' : priorSourceStatus ?? 'pending', tool: name, updatedAt: new Date().toISOString(), ...(sourceMetadata ? { date: sourceMetadata.date, postings: sourceMetadata.postings } : {}) };
    }
    ledger.operations[key] = { status: 'pending', tool: name, sourceId, updatedAt: new Date().toISOString() };
    await saveOperationLedger(ledger);
    try {
      const result = await work();
      ledger.operations[key] = { status: 'completed', tool: name, sourceId, result, updatedAt: new Date().toISOString() };
      if (sourceId) ledger.sources[sourceId] = { ...ledger.sources[sourceId], status: action === 'delete' ? 'voided' : 'active', tool: name, updatedAt: new Date().toISOString(), ...(sourceMetadata ? { date: sourceMetadata.date, postings: sourceMetadata.postings } : {}) };
      if (cut) { ledger.cuts[cut.account] ??= {}; if (!ledger.cuts[cut.account]![cut.currency] || ledger.cuts[cut.account]![cut.currency]! < cut.date) ledger.cuts[cut.account]![cut.currency] = cut.date; }
      applyLedger?.(ledger, result);
      if (action === 'restore' && result && typeof result === 'object' && Array.isArray((result as any).restoredActiveSourceIds) && Array.isArray((result as any).restoredVoidedSourceIds)) {
        const activeIds = new Set<string>((result as any).restoredActiveSourceIds.filter((x: unknown): x is string => typeof x === 'string'));
        const voidedIds = new Set<string>((result as any).restoredVoidedSourceIds.filter((x: unknown): x is string => typeof x === 'string'));
        const preservedIds = new Set<string>(((result as any).preservedReconcileSourceIds??[]).filter((x:unknown):x is string=>typeof x==='string'));
        const reopenedIds = reopenedReconciliationIds(ledger);
        for (const [id, prior] of Object.entries(ledger.sources)) ledger.sources[id] = { ...prior, status: prior.status === 'unknown' ? 'unknown' : reopenedIds.has(id) || voidedIds.has(id) ? 'voided' : activeIds.has(id) || preservedIds.has(id) ? 'active' : 'voided', updatedAt: new Date().toISOString() };
        for (const id of activeIds) if (!ledger.sources[id]) ledger.sources[id] = { status: 'active', tool: name, updatedAt: new Date().toISOString() };
        for (const id of voidedIds) if (!ledger.sources[id]) ledger.sources[id] = { status: 'voided', tool: name, updatedAt: new Date().toISOString() };
        for (const id of preservedIds) ledger.sources[id] = { ...(ledger.sources[id]??{}), status: 'active', tool:name, updatedAt:new Date().toISOString() };
      }
      await saveOperationLedger(ledger);
      return result;
    } catch (error) {
      const unknown = Boolean((error as { unknown?: boolean })?.unknown);
      ledger.operations[key] = { status: unknown ? 'unknown' : 'rejected', tool: name, sourceId, updatedAt: new Date().toISOString() };
      if (sourceId) {
        if (unknown) ledger.sources[sourceId] = { status: 'unknown', tool: name, updatedAt: new Date().toISOString() };
        else if (action === 'create' || action === 'reconcile' || action === 'reopen') delete ledger.sources[sourceId];
        else ledger.sources[sourceId] = { status: priorSourceStatus ?? 'active', tool: name, updatedAt: new Date().toISOString() };
      }
      await saveOperationLedger(ledger).catch(() => undefined);
      throw error;
    }
  }
  async function verifyRestoreCutoffs(candidatePath:string, ledger:OperationLedger):Promise<string[]> {
    const reopened=reopenedReconciliationIds(ledger), handle=await open(candidatePath,constants.O_RDONLY|constants.O_NOFOLLOW);
    let candidateText:string; try { candidateText=await handle.readFile('utf8'); } finally { await handle.close(); }
    const candidateCuts=journalAssertionCuts(candidateText,reopened), preserve:string[]=[];
    for(const [account,currencies] of Object.entries(ledger.cuts)) for(const [currency,day] of Object.entries(currencies)) {
      if(candidateCuts[account]?.[currency] && candidateCuts[account]![currency]!>=day) continue;
      const targetOp=Object.values(ledger.operations).find(op=>op.status==='completed'&&op.tool==='hledger_reconcile'&&op.sourceId&&!reopened.has(op.sourceId)&&ledger.sources[op.sourceId]?.status==='active'&&(op.result as any)?.account===account&&(op.result as any)?.currency===currency&&(op.result as any)?.date===day);
      if(!targetOp || !(targetOp.result as any)?.target_balance) throw new ToolUsageError(`備份會移除 ${account} ${currency} 的 cutoff ${day}；拒絕還原以免暗中解除校正。`);
      const output=await run(['-f',candidatePath,'balance','--flat','--end',nextDate(day),account]);
      const escaped=account.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
      const pattern=new RegExp(`^\\s*${currency}\\s+(-?(?:\\d+)(?:\\.\\d+)?)\\s+${escaped}\\s*$`);
      const values=output.split('\n').map(line=>pattern.exec(line)?.[1]).filter((x):x is string=>x!==undefined);
      if(values.length!==1 || values[0]!==String((targetOp.result as any).target_balance)) throw new ToolUsageError(`備份無法證明還原後 ${account} ${currency} ${day} 仍符合校正目標；拒絕還原。`);
      preserve.push(targetOp.sourceId!);
    }
    return preserve;
  }
  function transactionBlocks(text: string): Array<{ id: string; date: string; index: number; length: number; postings: SourceRef[] }> {
    const lines = text.split('\n');
    const result: Array<{ id: string; date: string; index: number; length: number; postings: SourceRef[] }> = [];
    let offset = 0;
    for (let i = 0; i < lines.length; i++) {
      const header = /^(\d{4}-\d{2}-\d{2})[^\n]*; source-id=([^\s]+)/.exec(lines[i]!);
      if (header) {
        const start = offset; let end = offset + lines[i]!.length + 1; let j = i + 1;
        const postings: SourceRef[] = [];
        for (; j < lines.length && lines[j]!.trim() !== ''; j++) {
          const tokens = lines[j]!.trim().split(/\s+/);
          const currencyIndex = tokens.findIndex((token, index) => index > 0 && CURRENCY.test(token));
          if (currencyIndex > 0) postings.push({ account: tokens.slice(0,currencyIndex).join(' '), currency: tokens[currencyIndex]! });
          end += lines[j]!.length + 1;
        }
        result.push({ id: header[2]!, date: header[1]!, index: start, length: end - start, postings });
      }
      offset += lines[i]!.length + 1;
    }
    return result;
  }
  async function execute(name: string, args: Args, origin?: FinanceIdentity): Promise<unknown> {
    if (!config.enabled || !isAuthorizedFinanceOrigin(origin)) throw new ToolUsageError('hledger tools require an authorized interactive Discord message; scheduled/subagent execution is not allowed.');
    if (!definitions.some(x => x.name === name)) throw new ToolUsageError('Unknown or disabled hledger tool');
    if (name === 'hledger_lock_status') {
      try { const st = await lstat(`${journal}.lock`); if (!st.isFile() || st.isSymbolicLink()) return { lock: 'unsafe_object', automatic_recovery: false }; const handle=await open(`${journal}.lock`,constants.O_RDONLY|constants.O_NOFOLLOW); let owner=''; try { owner=(await handle.readFile('utf8')).slice(0,120); } finally { await handle.close(); } return { lock:'present',created_at:st.mtime.toISOString(),owner,automatic_recovery:false,administrator_action:'Verify no writer process is active, inspect journal and operation ledger, preserve lock copy, then remove only after explicit administrator approval.' }; }
      catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { lock:'absent',automatic_recovery:false }; throw new ToolUsageError('Lock diagnostic failed safely.'); }
    }
    if (name === 'hledger_operations_list') { const ledger=await readOperationLedger(); return { operations:Object.entries(ledger.operations).map(([id,row])=>({id,status:row.status,tool:row.tool,source_id:row.sourceId??null,updated_at:row.updatedAt})).slice(-200),sources:Object.entries(ledger.sources).map(([id,row])=>({source_id:id,status:row.status,tool:row.tool,updated_at:row.updatedAt})).slice(-500) }; }
    if (name === 'hledger_backup_list') {
      let files: string[]; try { files = await readdir(backups); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { backups: [] }; throw e; }
      return { backups: files.filter(x => /^[0-9T-Z-]+-[0-9a-f-]+\.bak$/.test(x)).sort().map(file => ({ id: file.slice(0,-4) })) };
    }
    if (name === 'hledger_backup_restore') return withLock(async () => ledgerOperation(name, args, origin!, undefined, 'restore', async () => {
      const id = requiredString(args.backup_id, 'backup_id'); if (!/^[A-Za-z0-9-]{1,80}$/.test(id)) throw new ToolUsageError('Invalid backup ID');
      const source = resolve(backups, `${id}.bak`); if (dirname(source) !== backups) throw new ToolUsageError('Invalid backup path');
      const st = await lstat(source); if (!st.isFile() || st.isSymbolicLink() || (st.mode & 0o077) !== 0) throw new ToolUsageError('Backup is not a private regular file');
      const content = await (await open(source, constants.O_RDONLY | constants.O_NOFOLLOW)).readFile('utf8'); const candidate = `${journal}.${randomUUID()}.restore`;
      const restoredActiveSourceIds = [...new Set(transactionBlocks(content).map(x=>x.id))];
      const restoredVoidedSourceIds = [...new Set(content.split('\n').map(line=>/^; voided-source-id=([^\s]+)/.exec(line)?.[1]).filter((x):x is string=>Boolean(x)))];
      const priorLedger=await readOperationLedger(); const reopenedIds=reopenedReconciliationIds(priorLedger);
      if(restoredActiveSourceIds.some(sourceId=>reopenedIds.has(sourceId))) throw new ToolUsageError('此備份含已明確重開的 runtime 校正；拒絕還原，避免復活舊 cutoff 調整。');
      const fh = await open(candidate, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); await fh.writeFile(content); await fh.sync(); await fh.close();
      let preservedReconcileSourceIds:string[]=[];
      try { await check(candidate); preservedReconcileSourceIds=await verifyRestoreCutoffs(candidate,priorLedger); await commit(await readJournal(), content); } finally { await rm(candidate, { force: true }).catch(() => undefined); }
      return { restored: id, validated: true, restoredActiveSourceIds, restoredVoidedSourceIds, preservedReconcileSourceIds };
    }));
    if (name === 'hledger_accounts') {
      const argsList = ['-f', journal, 'balance', '--flat']; if (args.as_of !== undefined) { const d = requiredString(args.as_of,'as_of'); if (!validDate(d)) throw new ToolUsageError('Invalid date'); argsList.push('--end', nextDate(d)); }
      if (args.account !== undefined) { const account=requiredString(args.account,'account'); if(!ACCOUNT.test(account)) throw new ToolUsageError('Invalid account name'); argsList.push(account); }
      const text=await readJournal(), metadata=accountMetadata(text), names=(await run(['-f',journal,'accounts','--flat'])).split('\n').map(x=>x.trim()).filter(Boolean);
      return { as_of: args.as_of ?? 'current', balances: await run(argsList), accounts:names.map(name=>({name,...(metadata.get(name)??{}),hidden:metadata.get(name)?.hidden??false})) };
    }
    if (name === 'hledger_account_manage') return withLock(async()=>{
      const action=requiredString(args.action,'action'), accountName=requiredString(args.name,'name');
      if(!['create','update','hide','show'].includes(action)||!ACCOUNT.test(accountName)||accountName.includes(' ')) throw new ToolUsageError('Invalid account management fields.');
      return ledgerOperation('hledger_account_manage',args,origin!,undefined,'metadata',async()=>{
        const text=await readJournal(), existing=(await run(['-f',journal,'accounts','--flat'])).split('\n').map(x=>x.trim()).filter(Boolean), metadata=accountMetadata(text), prior=metadata.get(accountName);
        if(action==='create'&&existing.includes(accountName)) throw new ToolUsageError('Account already exists; no write performed.');
        if(action!=='create'&&!existing.includes(accountName)) throw new ToolUsageError('Account not found; no write performed.');
        let nextMeta:AccountMetadata;
        if(action==='create') {
          const type=requiredString(args.type,'type'), currency=requiredString(args.currency,'currency');
          if(!['asset','liability','equity','income','expense'].includes(type)||!CURRENCY.test(currency)) throw new ToolUsageError('Invalid account type or currency.');
          nextMeta={type:type as AccountMetadata['type'],currency,note:typeof args.note==='string'?args.note.slice(0,200):'',hidden:false};
        } else {
          if(args.type!==undefined||args.currency!==undefined) throw new ToolUsageError('Account type/currency is immutable after creation.');
          nextMeta={...(prior??{}),...(args.note===undefined?{}:{note:requiredString(args.note,'note').slice(0,200)}),hidden:action==='hide'?true:action==='show'?false:prior?.hidden??false};
        }
        const next=replaceTaggedEntry(text,'; renee-account-meta=',x=>String(x.name??''),accountName,accountMetaLine(accountName,nextMeta));
        await commit(text,next);
        return {action,name:accountName,...nextMeta,verified:true};
      },undefined,undefined,(target,result)=>{ target.accounts ??= {}; target.accounts[accountName]={type:result.type,currency:result.currency,note:result.note,hidden:result.hidden}; });
    });
    if(name==='hledger_schedules_list') { const ledger=await readOperationLedger(); return {schedules:Object.values(ledger.schedules??{}).map(({id,name,frequency,startDate,enabled,deleted})=>({id,name,frequency,start_date:startDate,enabled,deleted:deleted??false})).sort((a,b)=>a.id.localeCompare(b.id))}; }
    if(name==='hledger_schedule_manage') return withLock(async()=>{
      const action=requiredString(args.action,'action'), id=requiredString(args.schedule_id,'schedule_id');
      if(!['create','update','enable','disable','delete'].includes(action)||!ID.test(id)) throw new ToolUsageError('Invalid schedule action or id.');
      return ledgerOperation(name,args,origin!,undefined,'metadata',async()=>{
        const ledger=await readOperationLedger(), schedules={...(ledger.schedules??{})}; const prior=schedules[id];
        let next:ScheduleMetadata;
        if(action==='create') {
          if(prior) throw new ToolUsageError('Schedule ID already exists or was deleted; no write performed.');
          const name=requiredString(args.name,'name'), frequency=requiredString(args.frequency,'frequency'), startDate=requiredString(args.start_date,'start_date');
          if(!validDate(startDate)||!['monthly','bimonthly'].includes(frequency)||!Array.isArray(args.postings)) throw new ToolUsageError('Invalid periodic schedule fields.');
          next={id,name,frequency:frequency as ScheduleMetadata['frequency'],startDate,enabled:true,postings:args.postings as Posting[]}; periodicRule(next); schedules[id]=next;
        } else {
          if(!prior) throw new ToolUsageError('Schedule not found.');
          if(action==='update') {
            const name=requiredString(args.name,'name'), frequency=requiredString(args.frequency,'frequency'), startDate=requiredString(args.start_date,'start_date');
            if(!validDate(startDate)||!['monthly','bimonthly'].includes(frequency)||!Array.isArray(args.postings)) throw new ToolUsageError('Invalid periodic schedule fields.');
            next={...prior,name,frequency:frequency as ScheduleMetadata['frequency'],startDate,postings:args.postings as Posting[]}; periodicRule(next); schedules[id]=next;
          } else if(action==='delete') { next={...prior,enabled:false,deleted:true}; schedules[id]=next; }
          else { if(prior.deleted) throw new ToolUsageError('Deleted schedule cannot be re-enabled.'); next={...prior,enabled:action==='enable'}; schedules[id]=next; }
        }
        await checkScheduleRules(await readJournal(),Object.values(schedules));
        return {schedule:next,schedules:Object.values(schedules)};
      },undefined,undefined,(target,result)=>{ target.schedules=Object.fromEntries(result.schedules.map(x=>[x.id,x])); });
    });
    if (name === 'hledger_forecast' || name === 'hledger_budget') {
      const begin = requiredString(args.begin,'begin'), end = requiredString(args.end,'end'); if (!validDate(begin)||!validDate(end)||begin>=end) throw new ToolUsageError('Invalid date range');
      const command = name === 'hledger_forecast' ? ['print', `--forecast=${begin}..${end}`] : ['balance','--budget','-M','--begin',begin,'--end',end, ...(args.account === undefined ? [] : [validAccount(requiredString(args.account,'account'))])];
      return { kind: name === 'hledger_forecast' ? 'forecast_only_not_actual' : 'budget_vs_actual', output: await withPlanningJournal(path=>run(['-f',path,...command])) };
    }
    if (name === 'hledger_reconciliation_reopen') return withLock(async()=>{
      const account=requiredString(args.account,'account'), currency=requiredString(args.currency,'currency'), fromDate=requiredString(args.from_date,'from_date'), reason=requiredString(args.reason,'reason');
      if(!ACCOUNT.test(account)||!CURRENCY.test(currency)||!validDate(fromDate)||reason.length>300) throw new ToolUsageError('Invalid reconciliation reopen fields.');
      let reopenedJournal='';
      return ledgerOperation(name,args,origin!,undefined,'reopen',async()=>{
        const text=await readJournal(), ledger=await readOperationLedger(), alreadyReopened=reopenedReconciliationIds(ledger);
        const candidateOps=Object.entries(ledger.operations).filter(([_,op])=>{
          const result=op.result as {account?:string;currency?:string;date?:string}|undefined;
          return op.status==='completed'&&op.tool==='hledger_reconcile'&&op.sourceId&&!alreadyReopened.has(op.sourceId)&&ledger.sources[op.sourceId]?.status==='active'&&result?.account===account&&result.currency===currency&&typeof result.date==='string'&&result.date>=fromDate;
        });
        const targets:Array<{source_id:string;date:string;target_balance:string;delta:string;adjusted:boolean}> = [];
        const blocks=transactionBlocks(text), removeBlocks:Array<{index:number;length:number;sourceId:string}>=[];
        const allowedAssertions=new Set<string>();
        for(const [_,op] of candidateOps){
          const result=op.result as {account:string;currency:string;date:string;target_balance:string;delta?:string;adjusted?:boolean};
          const sourceId=op.sourceId!; const matches=blocks.filter(x=>x.id===sourceId);
          if(result.adjusted){
            if(matches.length!==1||typeof result.delta!=='string'||typeof result.target_balance!=='string') throw new ToolUsageError(`Runtime reconciliation ${sourceId} cannot be uniquely verified; no changes made.`);
            const expected=transaction(sourceId,result.date,'Balance reconciliation adjustment',[{account,amount:result.delta,currency},{account:'equity:reconciliation',amount:decimal(-Number(result.delta)),currency}],{account,currency,amount:result.target_balance});
            const block=matches[0]!; if(text.slice(block.index,block.index+block.length)!==expected) throw new ToolUsageError(`Runtime reconciliation ${sourceId} was changed or is not the expected single-account adjustment; no changes made.`);
            removeBlocks.push({index:block.index,length:block.length,sourceId}); allowedAssertions.add(sourceId);
          } else if(matches.length) throw new ToolUsageError(`Zero-difference reconciliation ${sourceId} unexpectedly has a journal transaction; no changes made.`);
          targets.push({source_id:sourceId,date:result.date,target_balance:result.target_balance,delta:result.delta??'0',adjusted:result.adjusted===true});
        }
        if(!targets.length) throw new ToolUsageError('No eligible runtime reconciliation targets found for this account/currency/date.');
        const assertionRecords=journalAssertions(text), recognizedAssertionLines=new Set(assertionRecords.map(x=>x.raw));
        for(const assertion of assertionRecords) if(assertion.account===account&&assertion.currency===currency&&assertion.date>=fromDate&&(!assertion.sourceId||!allowedAssertions.has(assertion.sourceId))) throw new ToolUsageError(`External or unrecognized assertion at ${assertion.date} cannot be safely reopened; no changes made.`);
        let currentDate='';
        for(const line of text.split('\n')) { if(validDate(line.slice(0,10))) currentDate=line.slice(0,10); if(currentDate>=fromDate&&/^\s+/.test(line)&&!line.trimStart().startsWith(';')&&line.includes('=')&&!recognizedAssertionLines.has(line)) throw new ToolUsageError(`Complex or unrecognized assertion at ${currentDate}; no changes made.`); }
        for(const line of text.split('\n')){ if(validDate(line.slice(0,10))) currentDate=line.slice(0,10); if(currentDate>=fromDate&&line.trimStart().startsWith('balance ')) throw new ToolUsageError(`Unrecognized balance directive at ${currentDate}; no changes made.`); }
        let next=text;
        for(const block of removeBlocks.sort((a,b)=>b.index-a.index)) next=next.slice(0,block.index)+next.slice(block.index+block.length);
        next=next.trimEnd()+`\n\n${targets.map(x=>`; voided-source-id=${x.source_id}`).join('\n')}\n`;
        if(next!==text){await commit(text,next);await check(journal);}
        reopenedJournal=next;
        let remainingCut:string|undefined;
        for(const op of Object.values(ledger.operations)) {
          const result=op.result as {account?:string;currency?:string;date?:string}|undefined;
          if(op.status==='completed'&&op.tool==='hledger_reconcile'&&op.sourceId&&ledger.sources[op.sourceId]?.status==='active'&&result?.account===account&&result.currency===currency&&result.date&&result.date<fromDate&&(!remainingCut||remainingCut<result.date)) remainingCut=result.date;
        }
        for(const a of journalAssertions(text)) if(a.account===account&&a.currency===currency&&a.date<fromDate&&(!remainingCut||remainingCut<a.date)) remainingCut=a.date;
        return {account,currency,from_date:fromDate,reason,reopened_targets:targets,pending_reconcile:true,already_reconciled:false,remaining_cutoff:remainingCut};
      },undefined,undefined,(target,result)=>{for(const item of result.reopened_targets)target.sources[item.source_id]={status:'voided',tool:'hledger_reconcile',updatedAt:new Date().toISOString()};if(result.remaining_cutoff)target.cuts[account]={[currency]:result.remaining_cutoff};else delete target.cuts[account]?.[currency];for(const k of Object.keys(target.cuts))if(!Object.keys(target.cuts[k]!).length)delete target.cuts[k]; target.cuts=deriveCuts(target,reopenedJournal);});
    });
    if (name === 'hledger_reconcile') return withLock(async () => {
      const account = requiredString(args.account,'account'), day = requiredString(args.date,'date'), currency = requiredString(args.currency,'currency'), target = requiredString(args.target_balance,'target_balance'), sourceId = requiredString(args.source_id,'source_id');
      if (!ACCOUNT.test(account)||!validDate(day)||!CURRENCY.test(currency)||!MONEY.test(target)||!ID.test(sourceId)) throw new ToolUsageError('Invalid reconciliation fields');
      const ledger = await readOperationLedger();
      const existingCut = ledger.cuts[account]?.[currency];
      if (existingCut && day <= existingCut) throw new ToolUsageError(`此帳戶 ${currency} 已核對至 ${existingCut}（含日終）；需管理者重新開啟核對，本次未寫入。`);
      return ledgerOperation(name,args,origin!,sourceId,'reconcile',async()=>{
      const text = await readJournal(); if (text.includes(`source-id=${sourceId}`)) throw new ToolUsageError('source_id already exists; no write performed.');
      const actualOutput = await run(['-f',journal,'balance','--flat','--end',nextDate(day),account]);
      const escapedAccount = account.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
      const balances = actualOutput.split(/\r?\n/).map(line => new RegExp(`^\\s*${currency}\\s+(-?(?:\\d+)(?:\\.\\d+)?)\\s+${escapedAccount}\\s*$`).exec(line)?.[1]).filter((x): x is string => x !== undefined);
      if (balances.length !== 1) throw new ToolUsageError(`Could not unambiguously read ${currency} balance for ${account}; no adjustment made.`);
      const current = Number(balances[0]), desired = Number(target), delta = desired-current; if (!Number.isFinite(delta)) throw new ToolUsageError('Balance calculation failed.');
      if (delta === 0) return { adjusted: false, account, date: day, currency, current_balance: balances[0], target_balance: target };
      const adjustment = transaction(sourceId,day,'Balance reconciliation adjustment', [{account,amount:decimal(delta),currency},{account:'equity:reconciliation',amount:decimal(-delta),currency}], {account,currency,amount:target});
      await commit(text, text.trimEnd()+'\n\n'+adjustment); await check(journal);
      return { adjusted: true, account,date:day,currency,prior_balance:balances[0],delta:decimal(delta),target_balance:target,equity_account:'equity:reconciliation',income_expense_unchanged:true };
      }, { account, currency, date: day });
    });
    if (name === 'hledger_post') return withLock(async () => {
      const action = args.action; if (!['create','update','delete'].includes(String(action))) throw new ToolUsageError('Invalid action');
      const sourceId = requiredString(args.source_id,'source_id'); if (!ID.test(sourceId)) throw new ToolUsageError('Invalid source_id');
      const guardLedger = await readOperationLedger();
      const guardText = await readJournal();
      const priorBlocks = transactionBlocks(guardText).filter(x => x.id === sourceId);
      const previousBlock = priorBlocks.length === 1 ? priorBlocks[0] : undefined;
      const proposedDate = action === 'delete' ? previousBlock?.date : requiredString(args.date,'date');
      if (!proposedDate || !validDate(proposedDate)) throw new ToolUsageError('Cannot determine transaction date; no write performed.');
      const proposedPostings: SourceRef[] = action === 'delete' ? [] : Array.isArray(args.postings) ? (args.postings as Posting[]).map(p => ({account:p.account,currency:p.currency})) : [];
      const affected = [...(previousBlock?.postings ?? []), ...proposedPostings];
      const dates = action === 'update' && previousBlock ? [previousBlock.date, proposedDate] : [proposedDate];
      for (const ref of affected) for (const day of dates) {
        const cutoff = guardLedger.cuts[ref.account]?.[ref.currency];
        if (cutoff && day <= cutoff) throw new ToolUsageError(`此帳戶 ${ref.account} ${ref.currency} 已核對至 ${cutoff}（含日終）；新交易、修改或刪除須先由管理者重新開啟核對。本次未寫入。`);
      }
      const sourceMetadata = { date: proposedDate, postings: proposedPostings.length ? proposedPostings : previousBlock?.postings ?? [] };
      return ledgerOperation(name,args,origin!,sourceId,String(action) as 'create'|'update'|'delete',async()=>{
      const text = await readJournal(); const matches = transactionBlocks(text).filter(x => x.id===sourceId);
      if (action==='create' && (matches.length || text.includes(`voided-source-id=${sourceId}`))) throw new ToolUsageError('Duplicate or voided source_id; no write performed.');
      if (action!=='create' && matches.length!==1) throw new ToolUsageError(matches.length?'source_id is ambiguous; no write performed.':'source_id not found; no write performed.');
      let next = text;
      if (action!=='create') { const m=matches[0]!; next = next.slice(0,m.index)+next.slice(m.index+m.length); }
      if (action==='delete') next=next.trimEnd()+`\n\n; voided-source-id=${sourceId}\n`;
      else {
        if (!Array.isArray(args.postings)) throw new ToolUsageError('postings required');
        const entry=transaction(sourceId,requiredString(args.date,'date'),requiredString(args.description,'description'),args.postings as Posting[]);
        next=next.trimEnd()+'\n\n'+entry;
      }
      await commit(text,next); await check(journal);
      return { action,source_id:sourceId,verified:true,postings:(args.postings as unknown[]|undefined)?.length ?? null };
      }, undefined, sourceMetadata);
    });
    throw new ToolUsageError('Unknown hledger tool');
  }
  return { definitions, execute };
}
function validAccount(value: string): string { if (!ACCOUNT.test(value)) throw new ToolUsageError('Invalid account name'); return value; }
function requiredString(value: unknown, name: string): string { if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw new ToolUsageError(`${name} must be a non-empty string`); return value.trim(); }
function validDate(value: string): boolean { const m=/^(\d{4})-(\d{2})-(\d{2})$/.exec(value); if(!m)return false;const d=new Date(Date.UTC(+m[1]!,+m[2]!-1,+m[3]!));return d.toISOString().slice(0,10)===value; }
function nextDate(value: string): string { const d=new Date(`${value}T00:00:00Z`); d.setUTCDate(d.getUTCDate()+1); return d.toISOString().slice(0,10); }
function addDays(value: string, days: number): string { const d=new Date(`${value}T00:00:00Z`); d.setUTCDate(d.getUTCDate()+days); return d.toISOString().slice(0,10); }
function decimal(value: number): string { return value.toFixed(8).replace(/\.?0+$/,'') || '0'; }
