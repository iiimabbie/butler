import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { ToolUsageError } from './tool-errors.js';

export type HledgerConfig = { enabled: boolean; journalPath: string; schedules: { load(): unknown[]; save(schedules: ScheduleMetadata[]): void } };
const str = { type: 'string', minLength: 1 };
const date = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' };
const posting = { type: 'object', properties: { account: str, amount: { type: 'string', pattern: '^-?(?:0|[1-9]\\d*)(?:\\.\\d+)?$' }, currency: { type: 'string', pattern: '^[A-Z][A-Z0-9]{2,11}$' }, cost_amount: { type: 'string', pattern: '^-?(?:0|[1-9]\\d*)(?:\\.\\d+)?$' }, cost_currency: { type: 'string', pattern: '^[A-Z][A-Z0-9]{2,11}$' }, cost_type: { type: 'string', enum: ['unit','total'] } }, required: ['account','amount','currency'], additionalProperties: false };
const tool = (name: string, description: string, properties: Record<string, unknown>, required: string[]) => ({ type: 'function', name, description, parameters: { type: 'object', properties, required, additionalProperties: false } });
export const hledgerDefinitions = [
  tool('hledger_accounts', '查詢 hledger 科目 metadata 與指定日期各原幣餘額。', { as_of: date, account: str }, []),
  tool('hledger_account_manage', '建立或更新受控科目 metadata；hide 只隱藏不刪歷史。只接受結構化名稱、類型、幣別與備註，不接受 journal 片段。', { action:{type:'string',enum:['create','update','hide','show']}, name:str, type:{type:'string',enum:['asset','liability','equity','income','expense']}, currency:{type:'string',pattern:'^[A-Z][A-Z0-9]{2,11}$'}, note:{type:'string',maxLength:200} }, ['action','name']),
  tool('hledger_schedules_list', '查詢月／雙月 periodic 規劃與啟停狀態。規則只供 forecast/budget，不代表實際付款。', {}, []),
  tool('hledger_schedule_manage', '新增、修改、啟用、停用或刪除月／雙月規劃。結構化生成 periodic 規則；不自動入帳為實際交易。', {action:{type:'string',enum:['create','update','enable','disable','delete']},schedule_id:{type:'string',pattern:'^[A-Za-z0-9._:-]+$',minLength:1,maxLength:111},name:str,frequency:{type:'string',enum:['monthly','bimonthly']},start_date:date,postings:{type:'array',minItems:2,maxItems:30,items:posting}},['action','schedule_id']),
  tool('hledger_post', '新增、修改或刪除一筆多 postings 帳務交易。source_id 為穩定外部唯一識別；重複建立會拒絕。金額方向依帳戶類型確認。每 posting 一科目，可拆分帳單；換匯／證券以 cost_amount/cost_currency 表示成本，cost_type=unit 為單價（預設），total 為整筆總成本；證券代碼可含數字。', { action: { type: 'string', enum: ['create','update','delete'] }, source_id: { type: 'string', pattern: '^[A-Za-z0-9._:-]{1,120}$' }, date, description: str, postings: { type: 'array', minItems: 2, maxItems: 30, items: posting } }, ['action','source_id']),
  tool('hledger_reconcile', '核對某帳戶指定日期銀行餘額；差額以 equity:reconciliation 新增獨立調整分錄，並在同日 posting 上附 balance assertion。從不改寫既有歷史、絕不記收入/支出。需要來源識別碼。', { account: str, date, currency: { type: 'string', pattern: '^[A-Z][A-Z0-9]{2,11}$' }, target_balance: { type: 'string', pattern: '^-?(?:0|[1-9]\\d*)(?:\\.\\d+)?$' }, source_id: { type: 'string', pattern: '^[A-Za-z0-9._:-]{1,120}$' } }, ['account','date','currency','target_balance','source_id']),
  tool('hledger_reconciliation_reopen', '移除指定帳戶/幣別自 from_date 起由本工具建立的校正分錄，供重新對帳。', {account:str,currency:{type:'string',pattern:'^[A-Z][A-Z0-9]{2,11}$'},from_date:date,reason:{type:'string',minLength:1,maxLength:300}}, ['account','currency','from_date','reason']),
  tool('hledger_forecast', '以 hledger periodic rules 查詢預測；結果是虛擬 forecast，不會寫成實際帳務。', { begin: date, end: date }, ['begin','end']),
  tool('hledger_budget', '依 periodic rules 查詢預算與實際執行；規則本身不會被當成已發生交易。', { begin: date, end: date, account: str }, ['begin','end']),
] as const;

type Posting = { account: string; amount: string; currency: string; cost_amount?: string; cost_currency?: string; cost_type?: 'unit' | 'total' };
type Args = Record<string, unknown>;
const ID = /^[A-Za-z0-9._:-]{1,120}$/;
const ACCOUNT = /^[\p{L}\p{N}][\p{L}\p{N}\p{M} _:-]{0,159}$/u;
const MONEY = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;
const CURRENCY = /^[A-Z][A-Z0-9]{2,11}$/;
const SAFE_OUTPUT = 256 * 1024;
type AccountMetadata = { type?: 'asset'|'liability'|'equity'|'income'|'expense'; currency?: string; note?: string; hidden?: boolean };
type ScheduleMetadata = { id: string; name: string; frequency: 'monthly'|'bimonthly'; startDate: string; enabled: boolean; postings: Posting[] };
type SourceRef = { account: string; currency: string };

export type HledgerRuntime = { definitions: Array<(typeof hledgerDefinitions)[number]>; execute(name: string, args: Args): Promise<unknown> };
export function createHledgerToolRuntime(config: HledgerConfig): HledgerRuntime {
  const journal = resolve(config.journalPath), directory = dirname(journal);
  const definitions = config.enabled ? [...hledgerDefinitions] : [];
  let queue: Promise<unknown> = Promise.resolve();
  function serial<T>(work: () => Promise<T>): Promise<T> {
    const next = queue.then(work, work);
    queue = next.catch(() => undefined);
    return next;
  }
  async function check(path: string): Promise<void> { await run(['-f', path, 'check']); }
  async function run(args: string[]): Promise<string> {
    // hledger runs in the butler-hledger container (services/hledger), which mounts the ledger directory at /hledger.
    const containerArgs = args.map(arg => arg.startsWith(`${directory}/`) ? `/hledger/${arg.slice(directory.length + 1)}` : arg);
    const child = spawn('docker', ['exec', 'butler-hledger', 'hledger', ...containerArgs], { stdio: ['ignore','pipe','pipe'] });
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
  async function readJournal(): Promise<string> { return readFile(journal, 'utf8'); }
  function transaction(sourceId: string, day: string, description: string, postings: Posting[], assertion?: { account: string; currency: string; amount: string }): string {
    if (!ID.test(sourceId) || !validDate(day) || !description.trim() || description.length > 300 || postings.length < 2 || postings.length > 30) throw new ToolUsageError('交易欄位無效。');
    const rows = postings.map(p => {
      if (!ACCOUNT.test(p.account) || !MONEY.test(p.amount) || !CURRENCY.test(p.currency)) throw new ToolUsageError('posting 科目、金額或幣別格式無效。');
      if ((p.cost_amount === undefined) !== (p.cost_currency === undefined) || (p.cost_amount !== undefined && (!MONEY.test(p.cost_amount) || !CURRENCY.test(p.cost_currency!)))) throw new ToolUsageError('換匯 cost 欄位須成對且格式正確。');
      if (p.cost_type !== undefined && (!['unit','total'].includes(p.cost_type) || p.cost_amount === undefined)) throw new ToolUsageError('cost_type 須為 unit 或 total，且須提供成本欄位。');
      // hledger requires at least two spaces after an account; a single space
      // silently becomes part of long account names. Digit commodities must be quoted.
      return `    ${p.account.padEnd(40)}  ${commodity(p.currency)} ${p.amount}${p.cost_amount === undefined ? '' : ` ${p.cost_type === 'total' ? '@@' : '@'} ${commodity(p.cost_currency!)} ${p.cost_amount}`}`;
    });
    if (assertion) rows[0] += ` = ${commodity(assertion.currency)} ${assertion.amount}`;
    return `${day} ${description.replace(/[\r\n;]/g, ' ').trim()}  ; source-id=${sourceId}\n${rows.join('\n')}\n`;
  }
  function periodicRule(rule: ScheduleMetadata): string {
    if (!ID.test(rule.id) || !validDate(rule.startDate) || !['monthly','bimonthly'].includes(rule.frequency) || !rule.name.trim() || rule.name.length > 120) throw new ToolUsageError('Periodic rule metadata invalid.');
    const tx = transaction(`schedule-${rule.id}`, rule.startDate, rule.name, rule.postings);
    const rows = tx.split('\n').slice(1).filter(Boolean);
    const period = rule.frequency === 'monthly' ? 'monthly' : 'every 2 months';
    return `~ ${period} from ${rule.startDate}  ${rule.name.replace(/[\r\n;]/g,' ').trim()}  ; schedule-id=${rule.id}\n${rows.join('\n')}\n`;
  }
  async function readSchedules(): Promise<Record<string, ScheduleMetadata>> {
    return Object.fromEntries((config.schedules.load() as ScheduleMetadata[]).map(schedule => [schedule.id, schedule]));
  }
  async function saveSchedules(value: Record<string, ScheduleMetadata>): Promise<void> { config.schedules.save(Object.values(value)); }
  async function withPlanningJournal<T>(fn: (path: string) => Promise<T>): Promise<T> {
    const rules = Object.values(await readSchedules()).filter(rule => rule.enabled).map(periodicRule).join('\n');
    if (!rules) return fn(journal);
    const temporary = `${journal}.forecast`;
    try { await writeFile(temporary, `${await readJournal()}\n${rules}`, { mode: 0o600 }); await check(temporary); return await fn(temporary); }
    finally { await rm(temporary, { force: true }); }
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
    const enabled = schedules.filter(x => x.enabled);
    const rules = enabled.map(periodicRule).join('\n');
    const candidate = `${journal}.schedule`;
    try {
      await writeFile(candidate, `${baseText.trimEnd()}\n${rules}\n`, { mode: 0o600 });
      await check(candidate);
      for (const rule of enabled) {
        const end = nextDate(addDays(rule.startDate,90));
        await run(['-f',candidate,'print',`--forecast=${rule.startDate}..${end}`]);
      }
    } finally { await rm(candidate, { force: true }); }
  }
  async function commit(nextText: string): Promise<void> {
    const candidate = `${journal}.candidate`;
    await writeFile(candidate, nextText, { mode: 0o600 });
    try { await check(candidate); } catch (error) { await rm(candidate, { force: true }); throw error; }
    await rename(candidate, journal);
  }
  function transactionBlocks(text: string): Array<{ id: string; date: string; header: string; index: number; length: number; postings: SourceRef[] }> {
    const lines = text.split('\n');
    const result: Array<{ id: string; date: string; header: string; index: number; length: number; postings: SourceRef[] }> = [];
    let offset = 0;
    for (let i = 0; i < lines.length; i++) {
      const header = /^(\d{4}-\d{2}-\d{2})[^\n]*; source-id=([^\s]+)/.exec(lines[i]!);
      if (header) {
        const start = offset; let end = offset + lines[i]!.length + 1; let j = i + 1;
        const postings: SourceRef[] = [];
        for (; j < lines.length && lines[j]!.trim() !== ''; j++) {
          const ref = postingReference(lines[j]!);
          if (ref) postings.push(ref);
          end += lines[j]!.length + 1;
        }
        result.push({ id: header[2]!, date: header[1]!, header: lines[i]!, index: start, length: end - start, postings });
      }
      offset += lines[i]!.length + 1;
    }
    return result;
  }
  async function execute(name: string, args: Args): Promise<unknown> {
    if (!config.enabled) throw new ToolUsageError('hledger tools are disabled');
    if (!definitions.some(x => x.name === name)) throw new ToolUsageError('Unknown or disabled hledger tool');
    return serial(() => dispatch(name, args));
  }
  async function dispatch(name: string, args: Args): Promise<unknown> {
    if (name === 'hledger_accounts') {
      const argsList = ['-f', journal, 'balance', '--flat']; if (args.as_of !== undefined) { const d = requiredString(args.as_of,'as_of'); if (!validDate(d)) throw new ToolUsageError('Invalid date'); argsList.push('--end', nextDate(d)); }
      if (args.account !== undefined) { const account=requiredString(args.account,'account'); if(!ACCOUNT.test(account)) throw new ToolUsageError('Invalid account name'); argsList.push(account); }
      const text=await readJournal(), metadata=accountMetadata(text), names=(await run(['-f',journal,'accounts','--flat'])).split('\n').map(x=>x.trim()).filter(Boolean);
      return { as_of: args.as_of ?? 'current', balances: await run(argsList), accounts:names.map(name=>({name,...(metadata.get(name)??{}),hidden:metadata.get(name)?.hidden??false})) };
    }
    if (name === 'hledger_account_manage') {
      const action=requiredString(args.action,'action'), accountName=requiredString(args.name,'name');
      if(!['create','update','hide','show'].includes(action)||!ACCOUNT.test(accountName)||accountName.includes(' ')) throw new ToolUsageError('Invalid account management fields.');
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
      await commit(next);
      return {action,name:accountName,...nextMeta,verified:true};
    }
    if(name==='hledger_schedules_list') { return {schedules:Object.values(await readSchedules()).map(({id,name,frequency,startDate,enabled})=>({id,name,frequency,start_date:startDate,enabled})).sort((a,b)=>a.id.localeCompare(b.id))}; }
    if(name==='hledger_schedule_manage') {
      const action=requiredString(args.action,'action'), id=requiredString(args.schedule_id,'schedule_id');
      if(!['create','update','enable','disable','delete'].includes(action)||!ID.test(id)||id.length>111) throw new ToolUsageError('Invalid schedule action or id.');
      const schedules=await readSchedules(), prior=schedules[id], updated={...schedules};
      let schedule: ScheduleMetadata;
      if(action==='delete') {
        if(!prior) throw new ToolUsageError('Schedule not found.');
        delete updated[id]; schedule=prior;
      } else if(action==='create') {
        if(prior) throw new ToolUsageError('Schedule ID already exists; no write performed.');
        const scheduleName=requiredString(args.name,'name'), frequency=requiredString(args.frequency,'frequency'), startDate=requiredString(args.start_date,'start_date');
        if(!validDate(startDate)||!['monthly','bimonthly'].includes(frequency)||!Array.isArray(args.postings)) throw new ToolUsageError('Invalid periodic schedule fields.');
        schedule={id,name:scheduleName,frequency:frequency as ScheduleMetadata['frequency'],startDate,enabled:true,postings:args.postings as Posting[]};
        periodicRule(schedule); updated[id]=schedule;
      } else {
        if(!prior) throw new ToolUsageError('Schedule not found.');
        if(action==='update') {
          const scheduleName=args.name === undefined ? prior.name : requiredString(args.name,'name');
          const frequency=args.frequency === undefined ? prior.frequency : requiredString(args.frequency,'frequency');
          const startDate=args.start_date === undefined ? prior.startDate : requiredString(args.start_date,'start_date');
          const postings=args.postings === undefined ? prior.postings : args.postings;
          if(!validDate(startDate)||!['monthly','bimonthly'].includes(frequency)||!Array.isArray(postings)) throw new ToolUsageError('Invalid periodic schedule fields.');
          schedule={...prior,name:scheduleName,frequency:frequency as ScheduleMetadata['frequency'],startDate,postings:postings as Posting[]};
        } else schedule={...prior,enabled:action==='enable'};
        periodicRule(schedule); updated[id]=schedule;
      }
      await checkScheduleRules(await readJournal(),Object.values(updated));
      await saveSchedules(updated);
      return {schedule,schedules:Object.values(updated)};
    }
    if (name === 'hledger_forecast' || name === 'hledger_budget') {
      const begin = requiredString(args.begin,'begin'), end = requiredString(args.end,'end'); if (!validDate(begin)||!validDate(end)||begin>=end) throw new ToolUsageError('Invalid date range');
      const command = name === 'hledger_forecast' ? ['print', `--forecast=${begin}..${end}`] : ['balance','--budget','-M','--begin',begin,'--end',end, ...(args.account === undefined ? [] : [validAccount(requiredString(args.account,'account'))])];
      return { kind: name === 'hledger_forecast' ? 'forecast_only_not_actual' : 'budget_vs_actual', output: await withPlanningJournal(path=>run(['-f',path,...command])) };
    }
    if (name === 'hledger_reconciliation_reopen') {
      const account=requiredString(args.account,'account'), currency=requiredString(args.currency,'currency'), fromDate=requiredString(args.from_date,'from_date'), reason=requiredString(args.reason,'reason');
      if(!ACCOUNT.test(account)||!CURRENCY.test(currency)||!validDate(fromDate)||reason.length>300) throw new ToolUsageError('Invalid reconciliation reopen fields.');
      const text = await readJournal();
      const removals = transactionBlocks(text).filter(block => {
        const description = block.header.slice(11).replace(/\s*; source-id=.*$/, '');
        return (description === 'Balance reconciliation adjustment' || description === 'Balance assertion') && block.date >= fromDate && block.postings[0]?.account === account && block.postings[0]?.currency === currency;
      });
      if (!removals.length) throw new ToolUsageError('No reconciliation adjustments found for this account/currency from that date; no write performed.');
      let next = text;
      for (const block of [...removals].sort((a, b) => b.index - a.index)) next = next.slice(0, block.index) + next.slice(block.index + block.length);
      await commit(next);
      return { account, currency, from_date: fromDate, reason, removed: removals.map(x => ({ source_id: x.id, date: x.date })), pending_reconcile: true };
    }
    if (name === 'hledger_reconcile') {
      const account = requiredString(args.account,'account'), day = requiredString(args.date,'date'), currency = requiredString(args.currency,'currency'), target = requiredString(args.target_balance,'target_balance'), sourceId = requiredString(args.source_id,'source_id');
      if (!ACCOUNT.test(account)||!validDate(day)||!CURRENCY.test(currency)||!MONEY.test(target)||!ID.test(sourceId)) throw new ToolUsageError('Invalid reconciliation fields');
      const text = await readJournal(); if (transactionBlocks(text).some(x => x.id === sourceId)) throw new ToolUsageError('source_id already exists; no write performed.');
      const actualOutput = await run(['-f',journal,'balance','--flat','--end',nextDate(day),account]);
      const escapedAccount = account.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
      const balances = actualOutput.split(/\r?\n/).map(line => new RegExp(`^\\s*"?${currency}"?\\s+(-?(?:\\d+)(?:\\.\\d+)?)\\s+${escapedAccount}\\s*$`).exec(line)?.[1]).filter((x): x is string => x !== undefined);
      if (balances.length !== 1) throw new ToolUsageError(`Could not unambiguously read ${currency} balance for ${account}; no adjustment made.`);
      const current = Number(balances[0]), desired = Number(target), delta = desired-current; if (!Number.isFinite(delta)) throw new ToolUsageError('Balance calculation failed.');
      if (delta === 0) {
        await commit(`${text.trimEnd()}\n\n${day} Balance assertion  ; source-id=${sourceId}\n    ${account.padEnd(40)}  ${commodity(currency)} 0 = ${commodity(currency)} ${target}\n`);
        return { adjusted: false, account, date: day, currency, current_balance: balances[0], target_balance: target };
      }
      const adjustment = transaction(sourceId,day,'Balance reconciliation adjustment', [{account,amount:decimal(delta),currency},{account:'equity:reconciliation',amount:decimal(-delta),currency}], {account,currency,amount:target});
      await commit(text.trimEnd()+'\n\n'+adjustment);
      return { adjusted: true, account,date:day,currency,prior_balance:balances[0],delta:decimal(delta),target_balance:target,equity_account:'equity:reconciliation',income_expense_unchanged:true };
    }
    if (name === 'hledger_post') {
      const action = String(args.action); if (!['create','update','delete'].includes(action)) throw new ToolUsageError('Invalid action');
      const sourceId = requiredString(args.source_id,'source_id'); if (!ID.test(sourceId)) throw new ToolUsageError('Invalid source_id');
      const text = await readJournal(); const matches = transactionBlocks(text).filter(x => x.id === sourceId);
      if (action === 'create' && matches.length) throw new ToolUsageError('source_id 已存在；未寫入。');
      if (action !== 'create' && matches.length !== 1) throw new ToolUsageError(matches.length ? 'source_id is ambiguous; no write performed.' : 'source_id not found; no write performed.');
      let next = text;
      if (action !== 'create') { const m = matches[0]!; next = next.slice(0, m.index) + next.slice(m.index + m.length); }
      if (action !== 'delete') {
        if (!Array.isArray(args.postings)) throw new ToolUsageError('postings required');
        next = next.trimEnd() + '\n\n' + transaction(sourceId, requiredString(args.date,'date'), requiredString(args.description,'description'), args.postings as Posting[]);
      }
      await commit(next);
      return { action, source_id: sourceId, verified: true, postings: (args.postings as unknown[]|undefined)?.length ?? null };
    }
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

// Only digit-bearing commodities need quoting; preserve established money output.
function commodity(value: string): string { return /\d/.test(value) ? `"${value}"` : value; }
function postingReference(line: string): SourceRef | undefined {
  // Accept both current two-space separation and historical one-space output.
  // Anchor the amount, rather than mistaking an uppercase word in an account for a commodity.
  const match = /^\s+(.+?)\s+(?:"([A-Z][A-Z0-9]{2,11})"|([A-Z][A-Z0-9]{2,11}))\s+(-?(?:0|[1-9]\d*)(?:\.\d+)?)(?=\s|$)/.exec(line);
  if (!match || !ACCOUNT.test(match[1]!)) return undefined;
  return { account: match[1]!, currency: (match[2] ?? match[3])! };
}
