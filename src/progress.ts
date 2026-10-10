export type ProgressEvent =
  | { type: 'tool_start'; callId: string; toolName: string; args?: Record<string, unknown>; description?: string }
  | { type: 'tool_update'; callId: string; toolName: string; message: string }
  | { type: 'tool_end'; callId: string; toolName: string; status: 'completed' | 'failed' }
  | { type: 'status'; message: string };

export interface ProgressMessage {
  edit(content: string): Promise<unknown>;
  delete(): Promise<unknown>;
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

type Step = { callId?: string; text: string; status: 'running' | 'completed' | 'failed'; startedAt?: number; elapsedMs?: number };

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
      this.steps.push({ callId: event.callId, text: safeText(event.description ?? describeTool(event.toolName), 180), status: 'running', startedAt: performance.now() });
    } else {
      const row = [...this.steps].reverse().find(step => step.callId === event.callId);
      if (row) {
        if (event.type === 'tool_end') {
          row.status = event.status;
          if (row.startedAt !== undefined) row.elapsedMs = performance.now() - row.startedAt;
        } else row.text = safeText(event.message, 180) || row.text;
      }
    }
    if (this.steps.length > this.maxLines) this.steps.splice(0, this.steps.length - this.maxLines);
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
    catch (error) { this.options.log('Could not delete progress message', error); }
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

function describeTool(name: string): string {
  const labels: Record<string, string> = {
    web_search: '搜尋網頁', web_fetch: '讀取網頁', local_read: '讀取檔案', local_search: '搜尋檔案', local_write: '寫入檔案', local_edit: '修改檔案', local_shell: '執行指令', local_process_output: '查看工作輸出', local_process_stop: '停止背景工作', butler_deploy: '部署更新',
    google_gmail_search: '搜尋郵件', google_gmail_read: '讀取郵件', google_gmail_send: '傳送郵件', google_gmail_create_draft: '建立郵件草稿', google_drive_search: '搜尋雲端檔案', google_drive_read: '讀取雲端檔案', google_drive_upload: '上傳雲端檔案',
    google_calendar_list_events: '查看行程', google_calendar_create_event: '建立行程', google_calendar_update_event: '更新行程', google_calendar_delete_event: '刪除行程', google_tasks_list: '查看待辦事項', google_tasks_create: '建立待辦事項', google_tasks_update: '更新待辦事項', google_tasks_complete: '完成待辦事項', google_tasks_delete: '刪除待辦事項',
    weather_search: '搜尋地點', weather_forecast: '查看天氣預報', discord_send_message: '傳送訊息', discord_fetch_message: '讀取訊息', discord_fetch_channel_messages: '讀取頻道訊息', discord_edit_message: '編輯訊息', discord_delete_message: '刪除訊息', discord_react: '新增表情回應', discord_pin: '釘選訊息', discord_unpin: '取消釘選訊息', discord_fetch_channel: '讀取頻道', discord_create_forum_post: '建立論壇貼文', discord_archive_thread: '封存討論串', discord_delete_thread: '刪除討論串', discord_rename_post: '重新命名貼文', discord_rename_forum: '重新命名論壇', discord_attach_to_reply: '附加檔案至回覆', discord_send_buttons: '傳送互動按鈕',
    schedule_create: '建立排程', schedule_list: '查看排程', schedule_update: '更新排程', schedule_enable: '啟用排程', schedule_disable: '停用排程', schedule_delete: '刪除排程', people_list: '查看人物資料', people_get: '讀取人物資料', people_upsert: '更新人物資料', skills_list: '查看技能', skills_read: '讀取技能', skills_prepare: '準備技能', skills_install: '安裝技能', skills_remove: '移除技能', image_generate: '生成圖片', image_generate_self: '生成本人形象圖片', image_save: '命名保存圖片', history_get: '查看過往操作紀錄', history_list: '查看過往操作紀錄', history_search: '查找過往操作紀錄', memory_recall: '查找相關的過往對話', memory_reflect: '整理過往對話中的資訊', current_time: '查看目前時間',
  };
  return labels[name] ?? '處理資料';
}

function renderLines(steps: Step[], maxLength: number): string {
  const rows = steps.map(step => {
    const marker = step.status === 'completed' ? '✓' : step.status === 'failed' ? '✗' : '→';
    const elapsed = step.elapsedMs === undefined ? '' : ` (${step.elapsedMs.toFixed(1)}ms)`;
    return `${marker} ${step.text}${elapsed}`;
  });
  const collapsed = rows.length > 5 ? [`…前面還有 ${rows.length - 5} 項進度`, ...rows.slice(-5)] : rows;
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
