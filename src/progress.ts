import type { LogMethods } from './log.js';

export type ProgressEvent =
  | { type: 'tool_start'; callId: string; toolName: string; args?: Record<string, unknown>; description?: string }
  | { type: 'tool_update'; callId: string; toolName: string; message: string }
  | { type: 'tool_end'; callId: string; toolName: string; status: 'completed' | 'failed'; error?: string }
  | { type: 'status'; message: string };

export interface ProgressMessage {
  edit(content: string): Promise<unknown>;
  delete(): Promise<unknown>;
}

export interface ProgressTransport {
  send(content: string): Promise<ProgressMessage>;
  log: LogMethods;
}

export interface ProgressRendererOptions extends ProgressTransport {
  debounceMs?: number;
  maxLength?: number;
}

type Step = { callId?: string; memory?: boolean; text: string; status: 'running' | 'completed' | 'failed'; startedAt?: number; elapsedMs?: number; error?: string };

const ANSI = {
  reset: '\u001b[0m', boldBlue: '\u001b[1;34m', boldMagenta: '\u001b[1;35m',
  cyan: '\u001b[36m', green: '\u001b[32m', lightGray: '\u001b[37m', red: '\u001b[31m', yellow: '\u001b[33m',
} as const;
// Tools backed by Hindsight render in their own section.
const MEMORY_TOOLS: ReadonlySet<string> = new Set(['hindsight_bank_setup', 'hindsight_recall', 'memory_recall', 'memory_reflect', 'memory_tags_list', 'knowledge_page_create']);
const TITLE = '☪ 𝐵𝑢𝑡𝑙𝑒𝑟．𝑉𝑜𝑡𝑟𝑒 𝑚𝑎𝑗𝑜𝑟𝑑𝑜𝑚𝑒 𝑒𝑥𝑐𝑙𝑢𝑠𝑖𝑓';

/** Single-message progress UI. Transport failures are logged and never affect the ask or tool execution. */
export class ProgressRenderer {
  private readonly steps: Step[] = [];
  private readonly omitted = { memory: 0, tool: 0 };
  private message: ProgressMessage | undefined;
  private sendAttempted = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private flushing: Promise<void> = Promise.resolve();
  private closed = false;
  private readonly debounce: number;
  private readonly maxLength: number;

  constructor(private readonly options: ProgressRendererOptions) {
    this.debounce = options.debounceMs ?? 800;
    this.maxLength = Math.min(2000, options.maxLength ?? 1900);
  }

  event(event: ProgressEvent): void {
    if (this.closed) return;
    if (event.type === 'status') {
      const text = safeText(event.message, 180);
      if (text) this.steps.push({ text, status: 'running', startedAt: performance.now() });
    } else if (event.type === 'tool_start') {
      this.steps.push({ callId: event.callId, memory: MEMORY_TOOLS.has(event.toolName), text: safeText(event.description ?? describeTool(event.toolName), 180), status: 'running', startedAt: performance.now() });
    } else {
      const row = [...this.steps].reverse().find(step => step.callId === event.callId);
      if (row) {
        if (event.type === 'tool_end') {
          row.status = event.status;
          row.error = event.error ? safeText(event.error, 240) : undefined;
          if (row.startedAt !== undefined) row.elapsedMs = performance.now() - row.startedAt;
        } else row.text = safeText(event.message, 180) || row.text;
      }
    }
    // Each section keeps only its visible rows, so a long tool run never evicts Hindsight rows.
    const last = this.steps[this.steps.length - 1];
    const section = this.steps.filter(step => Boolean(step.memory) === Boolean(last?.memory));
    if (section.length > VISIBLE_STEPS) {
      this.steps.splice(this.steps.indexOf(section[0]!), 1);
      this.omitted[last?.memory ? 'memory' : 'tool']++;
    }
    this.scheduleFlush();
  }

  async finish(_status: 'completed' | 'failed'): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.flushing;
    if (!this.sendAttempted || !this.message) return;
    try { await this.message.delete(); }
    catch (error) { this.options.log.logWarn('Could not delete progress message', error); }
  }

  private scheduleFlush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = undefined; void this.flush(); }, this.debounce);
  }

  private flush(): Promise<void> {
    this.flushing = this.flushing.then(async () => {
      const body = renderProgress(this.steps, this.omitted, this.maxLength);
      try {
        if (this.message) await this.message.edit(body);
        else if (!this.sendAttempted && this.steps.length) {
          // A rejected send may nevertheless have succeeded remotely; never retry the initial send.
          this.sendAttempted = true;
          try { this.message = await this.options.send(body); }
          catch (error) { this.options.log.logWarn('Could not send initial progress message; not retrying because delivery is unknown', error); }
        }
      } catch (error) { this.options.log.logWarn('Could not update progress message', error); }
    }).catch(error => { this.options.log.logWarn('Progress renderer failed', error); });
    return this.flushing;
  }
}

type Omitted = { memory: number; tool: number };

const VISIBLE_STEPS = 3;

function renderProgress(steps: Step[], omitted: Omitted, maxLength: number): string {
  // Every text field is cut to textLimit, so a limit of 1 adds exactly one character per text row.
  const overhead = renderFrame(steps, omitted, 0).length;
  const textRows = renderFrame(steps, omitted, 1).length - overhead;
  return renderFrame(steps, omitted, Math.min(180, Math.floor((maxLength - overhead) / Math.max(1, textRows))));
}

function renderFrame(steps: Step[], omitted: Omitted, textLimit: number): string {
  const sections: string[] = [span(ANSI.boldMagenta, TITLE)];
  const memorySteps = steps.filter(step => step.memory);
  const toolSteps = steps.filter(step => !step.memory);
  if (memorySteps.length || omitted.memory) sections.push(`${span(ANSI.boldBlue, '❖ Hindsight 記憶')}\n${renderSteps(memorySteps, omitted.memory, textLimit)}`);
  if (toolSteps.length || omitted.tool) sections.push(`${span(ANSI.boldBlue, '❖ 執行軌跡')}\n${renderSteps(toolSteps, omitted.tool, textLimit)}`);
  return `\`\`\`ansi\n${sections.join('\n\n')}\n\`\`\``;
}

function renderSteps(visible: Step[], omitted: number, textLimit: number): string {
  const rows: string[] = [];
  if (omitted > 0) rows.push(`${span(ANSI.lightGray, visible.length ? '├─' : '╰─')} ${span(ANSI.lightGray, `…略過 ${omitted} 項較早紀錄`)}`);
  visible.forEach((step, index) => {
    const isLast = index === visible.length - 1;
    const connector = isLast ? '╰─' : '├─';
    const childIndent = isLast ? '   ' : '│  ';
    const marker = step.status === 'completed' ? '✓' : step.status === 'failed' ? '✗' : '→';
    const markerStyle = step.status === 'completed' ? ANSI.green : step.status === 'failed' ? ANSI.red : ANSI.yellow;
    const elapsed = step.elapsedMs ?? (step.startedAt === undefined ? undefined : performance.now() - step.startedAt);
    const duration = elapsed === undefined ? '' : ` ${span(ANSI.yellow, `[${formatDuration(elapsed)}]`)}`;
    rows.push(`${span(ANSI.lightGray, connector)} ${span(markerStyle, marker)} ${span(ANSI.cyan, safeText(step.text, textLimit))}${duration}`);
    if (step.status === 'failed' && step.error) rows.push(`${span(ANSI.lightGray, `${childIndent}╰─`)} ${span(ANSI.red, `原因：${safeText(step.error, textLimit)}`)}`);
  });
  return rows.join('\n');
}

function describeTool(name: string): string {
  const labels: Record<string, string> = {
    code_execute: '編排查詢與整理資料', web_search: '搜尋網頁', web_fetch: '讀取網頁', local_read: '讀取檔案', local_search: '搜尋檔案', local_write: '寫入檔案', local_edit: '修改檔案', local_shell: '執行指令', local_process_output: '查看工作輸出', local_process_stop: '停止背景工作', butler_deploy: '部署更新',
    google_accounts_list: '列出 Google 帳號', google_gmail_manage: '處理郵件', google_gmail_search: '搜尋郵件', google_gmail_read: '讀取郵件', google_drive_search: '搜尋雲端檔案', google_drive_read: '讀取雲端檔案', google_drive_upload: '上傳雲端檔案',
    google_calendar_list_events: '查看行程', google_calendar_manage: '處理行程', google_tasks_read: '查看待辦事項', google_tasks_manage: '處理待辦事項',
    weather_forecast: '查看天氣預報', discord_read: '讀取 Discord', discord_message: '處理 Discord 訊息', discord_thread: '處理討論串', discord_react: '新增表情回應', discord_attach_to_reply: '附加檔案至回覆', discord_handoff: '交接到其他頻道',
    schedule_manage: '管理排程', schedule_list: '查看排程', skills_read: '讀取技能', skills_manage: '管理技能', image_generate: '生成圖片', image_generate_self: '生成本人形象圖片', image_save: '命名保存圖片', history_get: '查看過往操作紀錄', history_list: '查看過往操作紀錄', history_search: '查找過往操作紀錄', memory_recall: '查找相關的過往對話', memory_reflect: '整理過往對話中的資訊',
  };
  return labels[name] ?? '處理資料';
}

function span(style: string, text: string): string { return `${style}${text}${ANSI.reset}`; }
function formatDuration(ms: number): string { return ms <= 1000 ? `${Math.max(0, Math.round(ms))}ms` : ms < 10_000 ? `${Math.round(ms / 10) / 100}s` : `${Math.round(ms / 100) / 10}s`; }
function safeText(text: string, maxLength: number): string {
  return text.replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '').replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\u001b/g, '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '').replace(/[\r\n\t]+/g, ' ').replace(/`/g, 'ˋ').replace(/https?:\/\/\S+/gi, '[連結]').replace(/(bearer\s+|api[_ -]?key[=: ]+|token[=: ]+)(\S+)/gi, '$1[已隱藏]').trim().slice(0, maxLength);
}
