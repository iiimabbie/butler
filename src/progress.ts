export type ProgressEvent =
  | { type: 'tool_start'; callId: string; toolName: string; args?: Record<string, unknown>; description?: string }
  | { type: 'tool_update'; callId: string; toolName: string; message: string }
  | { type: 'tool_end'; callId: string; toolName: string; status: 'completed' | 'failed' }
  | { type: 'status'; message: string };

export interface ProgressMessage {
  edit(content: string): Promise<unknown>;
}

export interface ProgressTransport {
  send(content: string): Promise<ProgressMessage>;
  log(message: string, error?: unknown): void;
}

export interface ProgressRendererOptions extends ProgressTransport {
  debounceMs?: number;
  maxLength?: number;
  maxLines?: number;
}

type Step = { callId?: string; text: string; status: 'running' | 'completed' | 'failed' };

/** Single-message progress UI. Transport failures are logged and never affect the ask or tool execution. */
export class ProgressRenderer {
  private readonly steps: Step[] = [];
  private message: ProgressMessage | undefined;
  private sendAttempted = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private flushing: Promise<void> = Promise.resolve();
  private closed = false;
  private readonly debounce: number;
  private readonly maxLength: number;
  private readonly maxLines: number;

  constructor(private readonly options: ProgressRendererOptions) {
    this.debounce = options.debounceMs ?? 800;
    this.maxLength = Math.min(2000, options.maxLength ?? 1900);
    this.maxLines = options.maxLines ?? 18;
  }

  event(event: ProgressEvent): void {
    if (this.closed) return;
    if (event.type === 'status') {
      const text = safeText(event.message, 180);
      if (!text) return;
      this.steps.push({ text, status: 'running' });
    } else if (event.type === 'tool_start') {
      this.steps.push({ callId: event.callId, text: safeText(event.description ?? describeTool(event.toolName, event.args), 180), status: 'running' });
    } else {
      const row = [...this.steps].reverse().find(step => step.callId === event.callId);
      if (row) {
        if (event.type === 'tool_end') row.status = event.status;
        else row.text = safeText(event.message, 180) || row.text;
      }
    }
    if (this.steps.length > this.maxLines) this.steps.splice(0, this.steps.length - this.maxLines);
    this.scheduleFlush();
  }

  async finish(status: 'completed' | 'failed'): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (status === 'failed') for (const step of this.steps) if (step.status === 'running') step.status = 'failed';
    if (this.steps.length) await this.flush();
  }

  private scheduleFlush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = undefined; void this.flush(); }, this.debounce);
  }

  private flush(): Promise<void> {
    this.flushing = this.flushing.then(async () => {
      const body = renderLines(this.steps, this.maxLength);
      try {
        if (this.message) await this.message.edit(body);
        else if (!this.sendAttempted && this.steps.length) {
          // A rejected send may nevertheless have succeeded remotely; never retry the initial send.
          this.sendAttempted = true;
          try { this.message = await this.options.send(body); }
          catch (error) { this.options.log('Could not send initial progress message; not retrying because delivery is unknown', error); }
        }
      } catch (error) { this.options.log('Could not update progress message', error); }
    }).catch(error => { this.options.log('Progress renderer failed', error); });
    return this.flushing;
  }
}

function describeTool(name: string, args: Record<string, unknown> = {}): string {
  const value = (key: string) => typeof args[key] === 'string' ? safeText(args[key] as string, 64) : '';
  const labels: Record<string, string> = {
    web_search: '搜尋網頁', web_fetch: '讀取網頁', local_read: '讀取檔案', local_search: '搜尋檔案', local_write: '寫入檔案', local_edit: '修改檔案', local_shell: '執行指令',
    google_gmail_search: '搜尋 Gmail', google_gmail_read: '讀取 Gmail', google_gmail_send: '傳送 Gmail', google_gmail_create_draft: '建立 Gmail 草稿', google_drive_search: '搜尋雲端檔案', google_drive_read: '讀取雲端檔案', google_drive_upload: '上傳雲端檔案',
    google_calendar_list_events: '查詢行事曆', google_calendar_create_event: '建立行事曆事件', google_calendar_update_event: '更新行事曆事件', google_calendar_delete_event: '刪除行事曆事件', google_tasks_list: '列出待辦事項', google_tasks_create: '建立待辦事項', google_tasks_update: '更新待辦事項', google_tasks_complete: '完成待辦事項', google_tasks_delete: '刪除待辦事項',
    weather_search: '搜尋地點', weather_forecast: '查詢天氣預報', discord_send_message: '傳送訊息', discord_fetch_message: '讀取訊息', discord_fetch_channel_messages: '讀取頻道訊息', discord_create_forum_post: '建立論壇貼文', discord_rename_post: '重新命名貼文', discord_rename_forum: '重新命名論壇',
    schedule_create: '建立排程', schedule_list: '列出排程', schedule_update: '更新排程', schedule_enable: '啟用排程', schedule_disable: '停用排程', schedule_delete: '刪除排程', people_list: '列出人物資料', people_get: '讀取人物資料', people_upsert: '更新人物資料', people_delete: '刪除人物資料', people_recall: '查詢人物記憶', skills_list: '列出 Skills', skills_read: '讀取 Skill', skills_prepare: '準備 Skill', skills_install: '安裝 Skill', skills_remove: '移除 Skill', image_generate: '生成圖片', history_get: '讀取工具紀錄', history_list: '讀取近期紀錄', history_search: '搜尋紀錄', memory_recall: '查詢共享記憶', memory_reflect: '整理共享記憶', current_time: '查詢時間',
  };
  const label = labels[name] ?? '處理資料';
  const subject = name === 'weather_search' ? value('location') : ['web_search', 'google_gmail_search', 'google_drive_search', 'history_search', 'memory_recall', 'memory_reflect'].includes(name) ? value('query') : ['local_read', 'local_search', 'local_write', 'local_edit', 'skills_read'].includes(name) ? value(name === 'skills_read' ? 'name' : 'path') : name === 'discord_create_forum_post' ? value('title') : '';
  return subject ? `${label}：${subject}` : label;
}

function renderLines(steps: Step[], maxLength: number): string {
  const rows = steps.map(step => `${step.status === 'completed' ? '✓' : step.status === 'failed' ? '✗' : '→'} ${step.text}`);
  const collapsed = rows.length > 8 ? [`…前面還有 ${rows.length - 7} 項進度`, ...rows.slice(-7)] : rows;
  let result = collapsed.join('\n');
  while (result.length > maxLength && collapsed.length > 2) {
    collapsed.splice(collapsed.length > 3 ? 1 : 0, 1);
    if (collapsed[0]?.startsWith('…前面還有')) collapsed[0] = '…另有較早進度';
    result = collapsed.join('\n');
  }
  return result.length > maxLength ? `${result.slice(0, maxLength - 1)}…` : result;
}

function safeText(text: string, maxLength: number): string {
  return text.replace(/[\r\n\0]/g, ' ').replace(/https?:\/\/\S+/gi, '[連結]').replace(/(bearer\s+|api[_ -]?key[=: ]+|token[=: ]+)(\S+)/gi, '$1[已隱藏]').slice(0, maxLength);
}
