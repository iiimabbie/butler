export type ProgressEvent =
  | { type: 'tool_start'; toolName: string; args?: Record<string, unknown> }
  | { type: 'tool_update'; toolName: string; message: string }
  | { type: 'tool_end'; toolName: string; status: 'completed' | 'failed' }
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

const SAFE_ARGUMENT_KEYS: Record<string, readonly string[]> = {
  web_search: ['query'], web_fetch: ['url'],
  local_read: ['path'], local_search: ['path', 'query', 'mode'], local_write: ['path'], local_edit: ['path'],
  google_gmail_search: ['query'], google_gmail_read: ['message_id'], google_calendar_list_events: ['start', 'end'],
  google_drive_search: ['query'], google_drive_read: ['file_id'], google_calendar_list: ['time_min', 'time_max'],
  weather_search: ['location'], weather_forecast: ['latitude', 'longitude', 'days'],
  discord_fetch_message: ['channelId', 'messageId'], discord_fetch_channel_messages: ['channelId'],
  discord_send_message: ['channelId'], discord_edit_message: ['channelId', 'messageId'], discord_create_forum_post: ['channelId', 'title'], discord_rename_post: ['threadId'], discord_rename_forum: ['channelId'],
  schedule_create: ['kind', 'outputChannelId', 'cron', 'runAt', 'timezone'], schedule_update: ['id'],
  schedule_list: [], schedule_enable: ['id'], schedule_disable: ['id'], schedule_delete: ['id'],
  people_list: ['limit', 'offset'], people_get: ['key'], people_upsert: ['key'], people_delete: ['key'], people_recall: ['key'],
  skills_list: [], skills_read: ['name', 'path'], skills_prepare: [], skills_install: ['name'], skills_remove: ['name'],
  image_generate: [], history_get: ['id', 'offset', 'limit'], history_list: ['offset', 'limit'], history_search: ['query', 'offset', 'limit'],
};

/** Single-message progress UI. Transport failures are logged and never affect the ask or tool execution. */
export class ProgressRenderer {
  private readonly lines: string[] = [];
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
    const text = formatProgressEvent(event);
    if (!text) return;
    this.lines.push(text);
    if (this.lines.length > this.maxLines) this.lines.splice(0, this.lines.length - this.maxLines);
    this.scheduleFlush();
  }

  async finish(status: 'completed' | 'failed'): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.lines.push(status === 'completed' ? '已完成，回覆已送出。' : '處理未完成，請查看錯誤記錄。');
    if (this.lines.length > this.maxLines) this.lines.splice(0, this.lines.length - this.maxLines);
    await this.flush();
  }

  private scheduleFlush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = undefined; void this.flush(); }, this.debounce);
  }

  private flush(): Promise<void> {
    this.flushing = this.flushing.then(async () => {
      const body = renderLines(this.lines, this.maxLength);
      try {
        if (this.message) await this.message.edit(body);
        else if (!this.sendAttempted) {
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

export function formatProgressEvent(event: ProgressEvent): string {
  if (event.type === 'status') return safeText(event.message, 180);
  if (event.type === 'tool_update') return `${toolLabel(event.toolName)}：${safeText(event.message, 150)}`;
  if (event.type === 'tool_end') return `${toolLabel(event.toolName)}${event.status === 'completed' ? '：已完成' : '：失敗'}`;
  const args = event.args ?? {};
  const safeKeys = SAFE_ARGUMENT_KEYS[event.toolName];
  if (!safeKeys?.length) return `正在使用 ${toolLabel(event.toolName)}…`;
  const details = safeKeys.flatMap(key => {
    const value = args[key];
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') return [];
    return [`${key} ${safeText(String(value), 64)}`];
  }).join('、');
  return details ? `正在${verb(event.toolName)}（${details}）…` : `正在${verb(event.toolName)}…`;
}

function renderLines(lines: string[], maxLength: number): string {
  if (!lines.length) return '正在處理…';
  const collapsed = lines.length > 8 ? [`…前面還有 ${lines.length - 7} 項進度`, ...lines.slice(-7)] : [...lines];
  let result = collapsed.join('\n');
  while (result.length > maxLength && collapsed.length > 2) {
    collapsed.splice(collapsed.length > 3 ? 1 : 0, 1);
    if (collapsed[0]?.startsWith('…前面還有')) collapsed[0] = `…另有較早進度`;
    result = collapsed.join('\n');
  }
  if (result.length > maxLength) result = `${result.slice(0, maxLength - 1)}…`;
  return result;
}

function toolLabel(name: string): string {
  const labels: Record<string, string> = {
    web_search: '搜尋網頁', web_fetch: '讀取網頁', local_read: '讀取檔案', local_search: '搜尋檔案', local_write: '寫入檔案', local_edit: '修改檔案', local_shell: '執行指令',
    google_gmail_search: '搜尋 Gmail', google_gmail_read: '讀取 Gmail', google_gmail_send: '傳送 Gmail', google_gmail_create_draft: '建立 Gmail 草稿', google_drive_search: '搜尋 Google Drive', google_drive_read: '讀取 Google Drive 檔案', google_drive_upload: '上傳 Google Drive', google_calendar_list_events: '查詢 Google 行事曆', google_calendar_create_event: '建立行事曆事件', google_calendar_update_event: '更新行事曆事件', google_calendar_delete_event: '刪除行事曆事件', google_tasks_list: '列出 Google Tasks', google_tasks_create: '建立 Google Task', google_tasks_update: '更新 Google Task', google_tasks_complete: '完成 Google Task', google_tasks_delete: '刪除 Google Task',
    weather_search: '搜尋地點', weather_forecast: '查詢天氣預報', discord_send_message: '傳送 Discord 訊息', discord_fetch_message: '讀取 Discord 訊息', discord_create_forum_post: '建立論壇貼文', discord_rename_post: '重新命名論壇貼文', discord_rename_forum: '重新命名論壇',
    schedule_create: '建立排程', schedule_list: '列出排程', schedule_update: '更新排程', schedule_enable: '啟用排程', schedule_disable: '停用排程', schedule_delete: '刪除排程',
    people_list: '列出人物資料', people_get: '讀取人物資料', people_upsert: '更新人物資料', people_delete: '刪除人物資料', people_recall: '查詢人物記憶',
    skills_list: '列出 Skills', skills_read: '讀取 Skill', skills_prepare: '準備 Skill', skills_install: '安裝 Skill', skills_remove: '移除 Skill', image_generate: '生成圖片', history_get: '讀取工具紀錄', memory_recall: '查詢共享記憶', memory_reflect: '整理共享記憶', current_time: '查詢時間',
  };
  return labels[name] ?? '工具';
}

function verb(name: string): string {
  const labels: Record<string, string> = { web_search: '搜尋網頁', web_fetch: '讀取網頁', local_read: '讀取檔案', local_search: '搜尋檔案', local_write: '寫入檔案', local_edit: '修改檔案', local_shell: '執行指令', google_gmail_search: '搜尋 Gmail', google_gmail_read: '讀取 Gmail', google_drive_search: '搜尋 Google Drive', google_drive_read: '讀取 Google Drive 檔案', google_calendar_list_events: '查詢 Google 行事曆', weather_search: '搜尋地點', weather_forecast: '查詢天氣預報', discord_send_message: '傳送 Discord 訊息', discord_create_forum_post: '建立論壇貼文', discord_rename_post: '重新命名論壇貼文', discord_rename_forum: '重新命名論壇', schedule_create: '建立排程', schedule_list: '列出排程', schedule_update: '更新排程', people_list: '列出人物資料', people_get: '讀取人物資料', people_upsert: '更新人物資料', people_delete: '刪除人物資料', people_recall: '查詢人物記憶', skills_list: '列出 Skills', skills_read: '讀取 Skill', skills_prepare: '準備 Skill', skills_install: '安裝 Skill', skills_remove: '移除 Skill', image_generate: '生成圖片', history_get: '讀取工具紀錄', memory_recall: '查詢共享記憶', memory_reflect: '整理共享記憶', current_time: '查詢時間' };
  return labels[name] ?? `使用 ${toolLabel(name)}`;
}

function safeText(text: string, maxLength: number): string {
  return text.replace(/[\r\n\0]/g, ' ').replace(/https?:\/\/\S+/gi, '[連結]').replace(/(bearer\s+|api[_ -]?key[=: ]+|token[=: ]+)\S+/gi, '$1[已隱藏]').slice(0, maxLength);
}
