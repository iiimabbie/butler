import { ToolUsageError } from './tool-errors.js';

export const catalogDefinition = {
  type: 'function', name: 'tools_catalog', strict: false,
  description: '依名稱／關鍵字載入工具的完整定義。可用工具清單已在上下文的工具索引中，不需要先列清單；用 names 一次載入這件事需要的所有工具，因為每次載入都會讓下一輪的提示快取失效。',
  parameters: { type: 'object', properties: { query: { type: 'string', maxLength: 200 }, names: { type: 'array', maxItems: 30, items: { type: 'string', maxLength: 100 } }, label: { type: 'string', maxLength: 200 } }, required: [], additionalProperties: false },
} as const;

// The most frequently loaded tools stay resident: loading one mid-ask changes the tool list and invalidates the prompt cache.
export const residentToolNames: ReadonlySet<string> = new Set(['code_execute','memory_recall','discord_fetch_message','discord_fetch_channel_messages','discord_react','web_search','web_fetch','skills_list','skills_read','local_read','local_search','local_write','local_edit','local_shell','subagent_run','subagent_send']);
const shortDescriptions: Record<string, string> = {
  tools_catalog: '列出可用工具並按名稱或關鍵字載入完整定義',
  agent_reach: '搜尋、閱讀小紅書、Bilibili、YouTube、V2EX 等平台內容與查詢唯讀能力',
  code_execute: '以隔離 JavaScript 串接唯讀工具並整理結果',
  memory_recall: '搜尋跨對話長期記憶', memory_reflect: '綜合長期記憶回答問題', memory_tags_list: '列出記憶標籤', knowledge_page_create: '建立知識頁',
  history_list: '列出工具操作紀錄', history_get: '讀取指定工具操作紀錄', history_search: '搜尋工具操作紀錄', journal_transcript_by_date: '按日期讀取已捕捉的 Discord 對話',
  subagent_run: '派遣子代理執行獨立任務', subagent_send: '向子代理傳送訊息', subagent_list: '列出子代理工作', subagent_status: '查詢子代理狀態', subagent_stop: '停止子代理',
  discord_fetch_message: '讀取 Discord 訊息', discord_react: '對 Discord 訊息加表情', discord_fetch_channel_messages: '讀取頻道訊息', discord_fetch_channel: '查閱 Discord 頻道', discord_send_message: '在 Discord 傳送訊息', discord_attach_to_reply: '將附件加入 Discord 回覆', discord_send_buttons: '傳送 Discord 按鈕', discord_edit_message: '編輯 Discord 訊息', discord_delete_message: '刪除 Discord 訊息', discord_pin: '置頂 Discord 訊息', discord_unpin: '取消置頂 Discord 訊息', discord_create_forum_post: '建立論壇文章', discord_archive_thread: '封存討論串', discord_delete_thread: '刪除討論串', discord_rename_post: '重新命名文章', discord_rename_forum: '重新命名論壇',
  google_gmail_search: '搜尋 Gmail 郵件', google_gmail_read: '讀取 Gmail 郵件', google_gmail_send: '傳送 Gmail 郵件', google_gmail_create_draft: '建立 Gmail 草稿', google_calendar_list_events: '查詢日曆活動', google_calendar_create_event: '建立日曆活動', google_calendar_update_event: '更新日曆活動', google_calendar_delete_event: '刪除日曆活動', google_tasks_lists: '列出 Tasks 清單', google_tasks_list: '查詢 Tasks 項目', google_tasks_create: '建立 Tasks 項目', google_tasks_update: '更新 Tasks 項目', google_tasks_complete: '完成 Tasks 項目', google_tasks_delete: '刪除 Tasks 項目', google_drive_search: '搜尋 Drive 檔案', google_drive_read: '讀取 Drive 檔案', google_drive_upload: '上傳 Drive 檔案',
  local_read: '讀取本機檔案', local_search: '搜尋本機檔案或內容', local_write: '寫入本機檔案', local_edit: '精確修改本機檔案', local_shell: '執行本機命令', local_process_output: '讀取背景程序輸出', local_process_stop: '停止背景程序', butler_deploy: '部署 Butler 更新',
  web_search: '搜尋公開網頁', web_fetch: '擷取單一網頁', web_extract: '擷取網頁內容', web_map: '探索網站頁面', web_usage: '查詢網頁工具用量', weather_search: '搜尋地點天氣', weather_forecast: '查詢天氣預報',
  skills_list: '列出已安裝 Skills', skills_read: '讀取 Skill 檔案', skills_prepare: '準備 Skill 候選項', skills_install: '安裝 Skill', skills_remove: '移除 Skill',
  schedule_create: '建立排程', schedule_list: '列出排程', schedule_update: '更新排程', schedule_enable: '啟用排程', schedule_disable: '停用排程', schedule_delete: '刪除排程',
  image_generate: '生成圖像', image_generate_self: '生成自畫像', image_save: '保存生成圖像',
  hledger_accounts: '查詢私有 hledger 帳戶及原幣餘額', hledger_post: '新增、更正或刪除多分錄帳務交易', hledger_reconcile: '按指定日期以 equity 校正並核對餘額', hledger_reconciliation_reopen: '移除指定帳戶自某日起的本工具校正分錄', hledger_forecast: '查詢不入帳的固定收支預測', hledger_budget: '比較預算規則與實際支出', hledger_backup_list: '列出私有帳本版本備份', hledger_backup_restore: '以備份取代現行帳本',hledger_account_manage: '管理帳戶 metadata', hledger_schedules_list: '查詢固定收支規劃', hledger_schedule_manage: '管理月雙月 forecast 規則',

};

export type ToolCatalog = { definitions: Array<Record<string, unknown>>; execute(args: Record<string, unknown>): unknown; loadedDefinitions(): Array<Record<string, unknown>>; index(): Array<{ name: string; description: string }>; getDefinition(name: string): Record<string, unknown> | undefined };

export function createToolCatalog(fullDefinitions: Array<Record<string, unknown>>): ToolCatalog {
  const available = fullDefinitions.filter(t => typeof t.name === 'string' && t.name !== 'tools_catalog');
  const byName = new Map<string, Record<string, unknown>>();
  for (const tool of available) {
    const name = tool.name as string;
    if (byName.has(name)) throw new Error(`Duplicate tool definition: ${name}`);
    byName.set(name, tool);
  }
  const loaded = new Set<string>();
  const definitions = [catalogDefinition as unknown as Record<string, unknown>];
  const index = () => [
    { name: 'tools_catalog', description: '列出可用工具並按名稱或關鍵字載入完整定義' },
    ...fullDefinitions.filter(t => typeof t.name === 'string' && t.name !== 'tools_catalog').map(tool => {
      const name = tool.name as string;
      const description = String(tool.description ?? '').split(/(?<=[.!?。！？])\s|\n/)[0]?.trim() || '此工具可用於執行相關操作';
      return { name, description: shortDescriptions[name] ?? (description.length > 100 ? `${description.slice(0, 97)}…` : description) };
    }),
  ];
  const execute = (args: Record<string, unknown>) => {
    const allowed = new Set(['query','names','label']);
    if (Object.keys(args).some(key => !allowed.has(key))) throw new ToolUsageError('Invalid tools_catalog arguments');
    if (args.query !== undefined && (typeof args.query !== 'string' || args.query.length > 200)) throw new ToolUsageError('query must be a string of at most 200 characters');
    if (args.names !== undefined && (!Array.isArray(args.names) || args.names.length > 30 || args.names.some(v => typeof v !== 'string' || v.length > 100))) throw new ToolUsageError('names must contain at most 30 strings of at most 100 characters');
    if (args.label !== undefined && (typeof args.label !== 'string' || args.label.length > 200)) throw new ToolUsageError('label must be a string of at most 200 characters');
    const requestedNames = (args.names as string[] | undefined) ?? [];
    for (const name of requestedNames) if (!byName.has(name) && !residentToolNames.has(name)) throw new ToolUsageError(`Unknown or unavailable tool name: ${name}`);
    const matches: string[] = [];
    const query = args.query as string | undefined;
    if (query?.trim()) {
      const q = query.toLowerCase();
      for (const [name, tool] of byName) {
        const short = shortDescriptions[name] ?? '';
        if (`${name} ${short} ${String(tool.description ?? '')}`.toLowerCase().includes(q)) matches.push(name);
      }
    }
    for (const name of requestedNames) if (!residentToolNames.has(name)) loaded.add(name);
    for (const name of matches) if (!residentToolNames.has(name)) loaded.add(name);
    if (args.query === undefined && args.names === undefined) return { tools: index() };
    return { query_matches: matches, loaded_names: [...loaded] };
  };
  return { definitions, execute, loadedDefinitions: () => [...loaded].map(name => byName.get(name)!), index, getDefinition: name => byName.get(name) };
}
