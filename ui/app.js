const $ = selector => document.querySelector(selector);

let selectedSession = null;
let sessionDetails = new Map();
let selectedKind = 'messages';
let activeTab = 'channels';
let channelView = 'settings';
let sessionScope = 'channels';
let sessionChannelId = null;
let sessionSnapshot = '';
let selectedChannelId = null;
let sessionOffset = 0;
let sessionState = 'active';
let recordOffset = 0;
let rawRequestBody = null;
let sessionRequestId = 0;
let recordRequestId = 0;
let latestRequestId = 0;
let channelRequestId = 0;
let channelRows = [];
let channelModels = { models: [], imageModels: [] };
const channelDrafts = new Map();
const busyChannels = new Set();
const pendingSessionPages = new Set();
const pendingRecordPages = new Set();

const recordsWorkspaceTemplate = $('#records-workspace-template');
$('#channel-records-slot').append(recordsWorkspaceTemplate.content.cloneNode(true));

async function getJson(url) {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function element(tag, text, className) {
  const result = document.createElement(tag);
  if (text !== undefined) result.textContent = String(text);
  if (className) result.className = className;
  return result;
}

function setStatus(text) {
  $('#status').textContent = text;
}

function isCurrentRecord(requestId, sessionId, kind) {
  return requestId === recordRequestId && selectedSession === sessionId && selectedKind === kind;
}

function formatTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function recordsWorkspace() { return $('#session-list')?.closest('.records-workspace'); }
function moveRecordsWorkspace() {
  const workspace = recordsWorkspace();
  if (!workspace) return;
  const slot = sessionScope === 'history' ? $('#history-records-slot') : $('#channel-records-slot');
  slot.replaceChildren(workspace);
  workspace.classList.toggle('history-workspace', sessionScope === 'history');
  workspace.querySelector('[data-session-heading]').textContent = sessionScope === 'history' ? '歷史 Session' : '頻道 Session';
}
function resetSessionSelection() {
  selectedSession = null; sessionDetails = new Map(); recordOffset = 0;
  sessionRequestId++; recordRequestId++;
  $('#session-list')?.replaceChildren(); $('#more-sessions').hidden = true;
  $('#session-title').textContent = '選擇一個 Session'; $('#session-title').removeAttribute('title');
  $('#records').replaceChildren(); $('#more-records').hidden = true;
}
async function loadSessions(append = false) {
  const scope = sessionScope, channelId = sessionChannelId, state = sessionState;
  const snapshot = `${scope}:${channelId ?? ''}:${state}`;
  if (snapshot !== sessionSnapshot) { sessionSnapshot = snapshot; resetSessionSelection(); append = false; }
  if (scope === 'channels' && !channelId) { resetSessionSelection(); setStatus('先選取頻道以檢視 Session。'); return; }
  const offset = append ? sessionOffset : 0;
  const pageKey = `${scope}:${channelId ?? ''}:${state}:${offset}`;
  if (append && pendingSessionPages.has(pageKey)) return;
  const requestId = ++sessionRequestId;
  if (append) pendingSessionPages.add(pageKey);
  else sessionOffset = 0;

  try {
    setStatus(`載入${sessionState === 'active' ? '目前' : '封存'} Session…`);
    const params = new URLSearchParams({ state, offset: String(offset) });
    if (scope === 'channels') params.set('channel_id', channelId);
    else params.set('scope', 'history');
    const data = await getJson(`api/sessions?${params}`);
    if (requestId !== sessionRequestId || snapshot !== sessionSnapshot) return;

    const host = $('#session-list');
    if (!append) { host.replaceChildren(); sessionDetails = new Map(); }
    for (const session of data.items) {
      sessionDetails.set(session.id, session);
      const button = element('button', undefined, 'session');
      button.classList.toggle('selected', selectedSession === session.id);
      button.dataset.sessionId = session.id;
      button.title = session.id;
      button.append(element('strong', sessionScope === 'history' ? (session.channel_name || (session.channel_id ? '無法取得頻道名稱' : '未知頻道')) : `Session ${formatTime(session.created_at)}`),
        ...(sessionScope === 'history' ? [element('small', `頻道 ID：${session.channel_id ?? '未知'}`)] : []),
        element('small', `最後活動：${formatTime(session.last_active_at)}`));
      button.onclick = () => openSession(session.id);
      host.append(button);
    }
    sessionOffset = data.next_offset ?? offset;
    $('#more-sessions').hidden = data.next_offset === null;
    setStatus(data.items.length ? 'Session 已載入。' : sessionState === 'active' ? '目前沒有使用中的 Session。' : '目前沒有封存 Session。');
    if (!append && selectedSession && !sessionDetails.has(selectedSession)) { selectedSession = null; recordRequestId++; $('#records').replaceChildren(); $('#more-records').hidden = true; }
    if (!append && data.items.length) await openSession(selectedSession ?? data.items[0].id);
    if (!append && !data.items.length) { $('#records').replaceChildren(element('p', scope === 'history' ? '此狀態下沒有歷史紀錄。' : '此頻道在此狀態下沒有對話紀錄。', 'empty-state')); $('#session-title').textContent = '沒有對話紀錄'; $('#session-title').removeAttribute('title'); }
  } catch (error) {
    if (requestId === sessionRequestId) setStatus(`載入 Session 失敗：${error.message}`);
  } finally {
    if (append) pendingSessionPages.delete(pageKey);
  }
}

async function openSession(sessionId) {
  selectedSession = sessionId;
  document.querySelectorAll('.session').forEach(button => button.classList.toggle('selected', button.dataset.sessionId === sessionId));
  recordOffset = 0;
  const session = sessionDetails.get(sessionId);
  const title = $('#session-title');
  title.textContent = session?.channel_name || (session?.channel_id ? '無法取得頻道名稱' : '未知頻道');
  title.title = sessionId;
  $('#records').replaceChildren();
  await loadRecords(false);
}

function downloadBlob(contents, filename, type) {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function safeFilePart(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 100) || 'record';
}

function renderMessage(row) {
  const card = element('article', undefined, `record message${row.role === 'assistant' ? ' assistant' : ''}`);
  const author = row.role === 'assistant'
    ? 'Butler'
    : row.author_name ? `${row.author_name}${row.author_id ? ` · ${row.author_id}` : ''}` : row.author_id ? `作者 · ${row.author_id}` : '未知來源';
  const rawTime = row.event_time ?? row.created_at;
  const header = element('header', undefined, 'message-header');
  const time = element('time', formatTime(rawTime));
  time.dateTime = rawTime;
  time.title = rawTime;
  header.append(element('strong', author), time);
  const body = element('div', row.content ?? '（空）', 'message-body');
  card.append(header, body);

  if (row.attachments) {
    let attachments = [];
    try { attachments = JSON.parse(row.attachments); } catch { /* malformed metadata is not rendered */ }
    for (const file of attachments) card.append(element('div', `附件：${file.filename} · ${file.mimeType} · ${file.status}`, 'attachment'));
  }

  const details = element('details', undefined, 'metadata');
  details.append(element('summary', '技術資訊與完整訊息'));
  const fields = [['ID', row.id], ['角色', row.role], ['作者 ID', row.author_id ?? '未知'], ['作者名稱', row.author_name ?? '未知'], ['原始時間', rawTime]];
  for (const [label, value] of fields) {
    const line = element('div', undefined, 'metadata-line');
    line.append(element('strong', `${label}：`), element('span', value ?? '（空）'));
    details.append(line);
  }
  const download = element('button', '下載完整訊息');
  download.onclick = () => downloadBlob(row.content, `message-${safeFilePart(row.id)}.txt`, 'text/plain;charset=utf-8');
  details.append(download);
  card.append(details);
  return card;
}

function renderTool(row) {
  const card = element('div', undefined, 'record tool-record');
  const fields = [['ID', row.id], ['工具', row.name], ['狀態', row.status], ['建立', row.created_at], ['完成', row.finished_at ?? '尚未完成'], ['參數', row.arguments], ['結果', row.result ?? (row.status === 'pending' ? '等待中' : '無結果')]];
  for (const [label, value] of fields) {
    card.append(element('strong', `${label}：`));
    card.append(element(['結果', '參數'].includes(label) ? 'pre' : 'div', value ?? '（空）'));
  }
  if (row.name === 'discord_attach_to_reply') {
    card.append(element('div', row.delivery_status
      ? `附件傳送：${row.delivery_status} · ${row.delivery_updated_at}`
      : '附件尚無傳送狀態。'));
  }
  const download = element('button', '下載完整工具紀錄');
  download.onclick = () => downloadBlob(JSON.stringify(row, null, 2), `tool-${safeFilePart(row.id)}.json`, 'application/json');
  card.append(download);
  return card;
}

async function loadRecords(append = false) {
  if (!selectedSession) return;
  if (!append) recordOffset = 0;
  const sessionId = selectedSession;
  const kind = selectedKind;
  const offset = recordOffset;
  const pageKey = `${sessionId}:${kind}:${offset}`;
  if (append && pendingRecordPages.has(pageKey)) return;
  const requestId = ++recordRequestId;
  if (append) pendingRecordPages.add(pageKey);

  try {
    setStatus(`載入${kind === 'messages' ? '對話' : '工具呼叫'}…`);
    const data = await getJson(`api/sessions/${encodeURIComponent(sessionId)}/${kind}?offset=${offset}`);
    if (!isCurrentRecord(requestId, sessionId, kind)) return;

    const host = $('#records');
    if (!append) host.replaceChildren();
    for (const row of data.items) host.append(kind === 'messages' ? renderMessage(row) : renderTool(row));
    recordOffset = data.next_offset ?? offset;
    $('#more-records').hidden = data.next_offset === null;
    setStatus(data.items.length ? '內容已載入。' : '這裡目前沒有紀錄。');
  } catch (error) {
    if (isCurrentRecord(requestId, sessionId, kind)) setStatus(`載入內容失敗：${error.message}`);
  } finally {
    if (append) pendingRecordPages.delete(pageKey);
  }
}

async function loadLatestRequest() {
  if (activeTab !== 'request') return;
  const requestId = ++latestRequestId;
  try {
    setStatus('載入最新請求…');
    const data = await getJson('api/latest-request');
    if (requestId !== latestRequestId || activeTab !== 'request') return;

    rawRequestBody = data?.body_json ?? null;
    $('#request-meta').textContent = data
      ? `送出嘗試：${data.attempted_at} · Session：${data.session_id} · 附件內容已去除（不代表 CPA 已收到）`
      : '尚未有 CPA 請求快照。';
    $('#request-body').textContent = rawRequestBody ? JSON.stringify(JSON.parse(rawRequestBody), null, 2) : '';
    $('#copy').disabled = !rawRequestBody;
    $('#download').disabled = !rawRequestBody;
    setStatus('最新請求已更新。');
  } catch (error) {
    if (requestId === latestRequestId && activeTab === 'request') setStatus(`載入最新請求失敗：${error.message}`);
  }
}

function isChannelDirty(id) {
  const draft = channelDrafts.get(id);
  const channel = channelRows.find(item => item.channelId === id);
  return !!draft && !!channel && JSON.stringify(draft) !== JSON.stringify(channelSettings(channel));
}

function channelSettings(channel) {
  return {
    botReply: channel.raw.botReply,
    hindsightWrite: channel.raw.hindsightWrite,
    replyMode: channel.raw.replyMode,
    mode: channel.raw.mode,
    model: channel.raw.model,
    effort: channel.raw.effort,
    imageModel: channel.raw.imageModel,
  };
}

function ensureChannelDraft(channel) {
  if (!channelDrafts.has(channel.channelId)) channelDrafts.set(channel.channelId, channelSettings(channel));
  return channelDrafts.get(channel.channelId);
}

function channelSettingSource(channel, key) {
  const source = channel.sources[key];
  if (source === 'default') return '全域預設';
  if (source.startsWith('alert:')) return `告警頻道固定規則（${source.slice(6)}）`;
  if (source === channel.channelId) return '此頻道設定';
  return '全域預設';
}

function settingSelect(channel, draft, key, label, options, effectiveText) {
  const wrap = element('label', undefined, 'channel-field');
  wrap.append(element('span', label));
  const select = element('select');
  select.dataset.key = key;
  for (const [value, title] of options) {
    const option = element('option', title);
    option.value = value;
    select.append(option);
  }
  const raw = channel.alert && ['replyMode','mode'].includes(key) ? effectiveText : draft[key];
  const desired = raw == null ? '' : String(raw);
  if (desired && !options.some(([value]) => value === desired)) {
    const unknown = element('option', `${desired}（目前設定）`);
    unknown.value = desired;
    select.append(unknown);
  }
  select.value = desired;
  select.onchange = () => { draft[key] = select.value === '' ? null : select.value; updateChannelDirty(channel.channelId); };
  wrap.append(select, element('small', `生效值：${effectiveText} · ${channelSettingSource(channel, key)}`));
  return wrap;
}

function booleanField(channel, draft, key, label, effectiveValue) {
  const wrap = element('div', undefined, 'channel-field boolean-field');
  const labelElement = element('label', undefined, 'checkbox-label');
  const input = element('input');
  input.type = 'checkbox';
  input.dataset.key = key;
  input.checked = channel.alert ? effectiveValue : draft[key] === null ? effectiveValue : draft[key];
  input.onchange = () => { draft[key] = input.checked; updateChannelDirty(channel.channelId); };
  labelElement.append(input, document.createTextNode(label));
  wrap.append(labelElement, element('small', `生效值：${effectiveValue ? '開' : '關'} · ${channelSettingSource(channel, key)}`));
  return wrap;
}

function updateChannelDirty(id) {
  const dirty = isChannelDirty(id);
  const treeRow = document.querySelector(`#channel-tree [data-tree-channel-id="${CSS.escape(id)}"]`);
  if (treeRow) {
    treeRow.querySelector('[data-tree-dirty]').hidden = !dirty;
    treeRow.classList.toggle('dirty', dirty);
  }
  const panel = $('#channel-panel');
  if (panel.dataset.channelId !== id) return;
  const marker = panel.querySelector('[data-dirty]');
  const save = panel.querySelector('[data-save]');
  if (marker) marker.textContent = dirty ? '有未儲存變更' : '已儲存';
  if (save) save.disabled = !dirty || !channelRows.find(channel => channel.channelId === id)?.authorized || busyChannels.has(id);
}

function renderChannels() {
  const tree = $('#channel-tree');
  tree.replaceChildren();
  const compare = (a, b) => (a.name || '').localeCompare(b.name || '') || a.channelId.localeCompare(b.channelId);
  const byId = new Map(channelRows.map(channel => [channel.channelId, channel]));
  const children = new Map();
  for (const channel of channelRows) {
    const key = channel.parentChannelId && byId.has(channel.parentChannelId) ? channel.parentChannelId : null;
    if (!children.has(key)) children.set(key, []);
    children.get(key).push(channel);
  }
  for (const group of children.values()) group.sort(compare);
  const ordered = [], visited = new Set();
  const visit = (channel, branches = []) => {
    if (visited.has(channel.channelId)) return;
    visited.add(channel.channelId); ordered.push({channel, branches});
    const group = children.get(channel.channelId) || [];
    group.forEach((child, index) => visit(child, [...branches, index === group.length - 1]));
  };
  for (const root of children.get(null) || []) visit(root);
  for (const channel of [...channelRows].sort(compare)) visit(channel);
  for (const {channel, branches} of ordered) {
    const row = element('div', undefined, `channel-tree-row${selectedChannelId === channel.channelId ? ' selected' : ''}${channel.tracked ? '' : ' untracked'}`);
    row.dataset.treeChannelId = channel.channelId;
    row.style.setProperty('--channel-depth', branches.length);
    branches.forEach((last, level) => {
      const current = level === branches.length - 1;
      if (!current && last) return;
      const branch = element('span', undefined, `tree-branch${current ? ' tree-branch-current' : ''}${current && last ? ' tree-branch-last' : ''}`);
      branch.style.setProperty('--branch-level', level);
      branch.setAttribute('aria-hidden', 'true');
      row.append(branch);
    });
    const button = element('button', undefined, 'channel-tree-select');
    button.type = 'button';
    button.setAttribute('aria-current', selectedChannelId === channel.channelId ? 'true' : 'false');
    const name = element('strong', channel.name || '未取得頻道名稱');
    const title = element('span', undefined, 'channel-tree-title');
    const kinds = { forum: '論壇', post: '貼文', channel: '頻道' };
    title.append(element('span', kinds[channel.kind] ?? '未知', `channel-kind channel-kind-${channel.kind ?? 'unknown'}`), name);
    const state = channel.authorized ? (channel.alert ? 'Alert 固定政策' : channel.tracked ? '追蹤中' : '已停止追蹤') : '僅歷史';
    const details = element('span', state, 'tree-state');
    const dirty = element('span', '未儲存', 'tree-dirty'); dirty.dataset.treeDirty = ''; dirty.hidden = !isChannelDirty(channel.channelId);
    button.append(title, details, dirty);
    button.onclick = () => selectChannel(channel.channelId);
    const action = element('button', channel.tracked ? '停止追蹤' : '恢復追蹤', 'channel-tree-tracking');
    action.type = 'button';
    action.disabled = channel.alert || busyChannels.has(channel.channelId);
    action.setAttribute('aria-label', `${action.textContent}：${channel.name || channel.channelId}`);
    action.onclick = () => {
      if (channel.tracked) {
        if (window.confirm('停止追蹤此頻道？歷史紀錄會保留。')) void mutateChannel(channel, 'DELETE');
      } else void mutateChannel(channel, 'POST', { channelId: channel.channelId });
    };
    row.append(button, action);
    tree.append(row);
  }
  const panel = $('#channel-panel');
  const channel = channelRows.find(item => item.channelId === selectedChannelId);
  if (!channel) {
    panel.removeAttribute('data-channel-id');
    panel.replaceChildren(element('p', channelRows.length ? '選取左側頻道以檢視或編輯設定。' : '目前沒有可管理的頻道。', 'empty-state'));
    return;
  }
  panel.dataset.channelId = channel.channelId;
  panel.replaceChildren();
  const draft = ensureChannelDraft(channel);
  const effective = channel.effective;
  const heading = element('header', undefined, 'channel-panel-heading');
  const identity = element('div'); identity.append(element('p', '頻道設定', 'eyebrow'), element('h3', channel.name || '未取得頻道名稱'));
  const state = element('span', channel.authorized ? (channel.tracked ? '追蹤中' : '已停止追蹤') : '不再授權（僅歷史）', 'channel-state'); heading.append(identity, state); panel.append(heading);
  const meta = element('dl', undefined, 'channel-meta');
  for (const [label, value] of [['頻道 ID', channel.channelId], ['父頻道', channel.parentChannelId || '無（僅 Discord 資訊）'], ['追蹤狀態', state.textContent]]) { meta.append(element('dt', label), element('dd', value)); }
  panel.append(meta);
  if (channel.alert) panel.append(element('p', 'Alert 頻道固定政策：追蹤、Bot 回覆、Hindsight 寫入、僅 @ 觸發、Steer；個別設定不會覆蓋。請由 .data/config.yaml 的 webhook 設定管理。', 'muted'));
  if (!channel.authorized) { panel.append(element('p', '此頻道已不再授權，僅保留歷史資料供檢視。', 'empty-state')); return; }
  const fieldset = (title, className='') => { const section=element('section',undefined,`channel-group ${className}`); section.append(element('h4',title)); const grid=element('div',undefined,'channel-fields'); section.append(grid); panel.append(section); return grid; };
  const reply = fieldset('回應','reply-group');
  const memory = fieldset('記憶','memory-group');
  const model = fieldset('模型','model-group');
  const addSelect = (host,key,label,options,effectiveValue) => { const field=settingSelect(channel,draft,key,label,options,effectiveValue); host.append(field); };
  addSelect(reply,'replyMode','回應模式',[['','全域預設'],['none','不回應'],['mention','僅 @'],['all','所有訊息']],effective.replyMode);
  reply.append(booleanField(channel,draft,'botReply','回應其他 bot',effective.botReply));
  addSelect(reply,'mode','處理模式',[['','全域預設'],['queue','Queue'],['steer','Steer']],effective.mode);
  memory.append(booleanField(channel,draft,'hindsightWrite','寫入 Hindsight',effective.hindsightWrite));
  memory.append(element('p','停用寫入時仍可查詢既有記憶。','muted'));
  addSelect(model,'model','對話模型',[['','沿用預設'],...channelModels.models.map(value=>[value,value])],effective.model);
  addSelect(model,'effort','Effort',[['','沿用預設'],...['none','minimal','low','medium','high','xhigh','auto'].map(value=>[value,value])],effective.effort);
  addSelect(model,'imageModel','圖片模型',[['','沿用預設'],...channelModels.imageModels.map(value=>[value,value])],effective.imageModel ?? '停用');
  for (const control of panel.querySelectorAll('select,input')) control.disabled = busyChannels.has(channel.channelId) || channel.alert;
  const footer=element('div',undefined,'channel-footer'); const dirty=element('span','已儲存'); dirty.dataset.dirty='';
  const save=element('button','儲存設定'); save.type='button'; save.dataset.save=''; save.disabled=!isChannelDirty(channel.channelId)||busyChannels.has(channel.channelId);
  save.onclick=()=>{const saved=channelSettings(channel);const settings=Object.fromEntries(Object.entries(draft).filter(([key,value])=>value!==saved[key]));if(Object.keys(settings).length)void mutateChannel(channel,'PATCH',settings);}; footer.append(dirty,save); panel.append(footer);
  updateChannelDirty(channel.channelId);
  if(busyChannels.has(channel.channelId)){panel.dataset.busy='true';panel.querySelectorAll('button,select,input').forEach(control=>control.disabled=true);}else delete panel.dataset.busy;
}

function selectChannel(id) {
  if (selectedChannelId === id) { renderChannels(); return; }
  selectedChannelId = id;
  sessionScope = 'channels'; sessionChannelId = id; sessionSnapshot = '';
  resetSessionSelection(); renderChannels();
  if (activeTab === 'channels' && channelView === 'records') void loadSessions(false);
}
async function loadChannels(force = false) {
  if (channelDrafts.size && [...channelDrafts.keys()].some(isChannelDirty)) {
    if (!force || !window.confirm('有未儲存的頻道變更。重新載入會捨棄這些草稿，確定繼續嗎？')) {
      setStatus('保留未儲存變更；未重新載入頻道。');
      return;
    }
    channelDrafts.clear();
  }
  const requestId = ++channelRequestId;
  try {
    setStatus('載入頻道設定…');
    const [data, models] = await Promise.all([getJson('api/channels'), getJson('api/models')]);
    if (requestId !== channelRequestId) return;
    if (!Array.isArray(data.channels) || !Array.isArray(models.models) || !Array.isArray(models.imageModels)) throw new Error('頻道或模型資料格式無效');
    channelRows = data.channels;
    channelModels = models;
    if (!channelRows.some(channel => channel.channelId === selectedChannelId)) selectedChannelId = channelRows[0]?.channelId ?? null;
    if (activeTab === 'channels') { sessionScope = 'channels'; sessionChannelId = selectedChannelId; }
    for (const channel of channelRows) if (!channelDrafts.has(channel.channelId)) channelDrafts.set(channel.channelId, channelSettings(channel));
    renderChannels();
    if (activeTab === 'channels' && channelView === 'records') void loadSessions(false);
    setStatus('頻道設定已載入。')
  } catch (error) {
    if (requestId === channelRequestId) setStatus(`載入頻道設定失敗：${error.message}`);
  }
}

async function mutateChannel(channel, method, body) {
  if (busyChannels.has(channel.channelId)) return;
  busyChannels.add(channel.channelId);
  renderChannels();
  try {
    const headers = {};
    const options = { method, headers, cache: 'no-store', credentials: 'same-origin' };
    if (body !== undefined) { headers['content-type'] = 'application/json'; options.body = JSON.stringify(body); }
    const response = await fetch(method === 'POST' ? 'api/channels' : method === 'DELETE' ? `api/channels/${encodeURIComponent(channel.channelId)}/tracking` : `api/channels/${encodeURIComponent(channel.channelId)}`, options);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
    if (!data.channel) throw new Error('回應缺少 channel');
    const previous = channelRows.find(item => item.channelId === channel.channelId);
    const previousSettings = channelSettings(previous);
    const draft = channelDrafts.get(channel.channelId) ?? previousSettings;
    channelRows = channelRows.map(item => item.channelId === channel.channelId ? data.channel : item);
    const updatedSettings = channelSettings(data.channel);
    for (const key of Object.keys(updatedSettings)) if (draft[key] === previousSettings[key] || (body && Object.hasOwn(body, key) && draft[key] === body[key])) draft[key] = updatedSettings[key];
    channelDrafts.set(channel.channelId, draft);
    if ((method === 'DELETE' || method === 'POST') && selectedChannelId === channel.channelId && activeTab === 'channels' && channelView === 'records') { sessionSnapshot = ''; resetSessionSelection(); void loadSessions(false); }
    setStatus(method === 'DELETE' ? '已停止追蹤；歷史保留。' : '頻道設定已儲存。');
  } catch (error) { setStatus(`頻道操作失敗：${error.message}`); }
  finally { busyChannels.delete(channel.channelId); renderChannels(); }
}

$('#channel-add-toggle').onclick = () => {
  const form=$('#channel-add'); form.hidden=!form.hidden;
  $('#channel-add-toggle').setAttribute('aria-expanded',String(!form.hidden));
  if(!form.hidden) $('#channel-new-id').focus();
};

$('#channel-add').onsubmit = async event => {
  event.preventDefault();
  const input = $('#channel-new-id');
  const button = event.submitter;
  const channelId = input.value.trim();
  if (!channelId) return;
  button.disabled = true;
  try {
    const response = await fetch('api/channels', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ channelId }), cache: 'no-store', credentials: 'same-origin' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
    if (!data.channel) throw new Error('回應缺少 channel');
    input.value = '';
    channelRows = [data.channel, ...channelRows.filter(channel => channel.channelId !== data.channel.channelId)];
    selectedChannelId = data.channel.channelId;
    channelDrafts.set(data.channel.channelId, channelSettings(data.channel));
    renderChannels();
    sessionScope = 'channels'; sessionChannelId = data.channel.channelId; sessionSnapshot = '';
    resetSessionSelection(); if (activeTab === 'channels' && channelView === 'records') void loadSessions(false);
    setStatus('頻道已新增。');
  } catch (error) { setStatus(`新增頻道失敗：${error.message}`); }
  finally { button.disabled = false; }
};

document.querySelectorAll('[data-tab]').forEach(button => {
  button.onclick = () => {
    if (activeTab === button.dataset.tab) return;
    activeTab = button.dataset.tab;
    document.querySelectorAll('[data-tab]').forEach(tab => { const selected = tab === button; tab.setAttribute('aria-selected', String(selected)); tab.tabIndex = selected ? 0 : -1; });
    for (const [tab, id] of Object.entries({ channels: 'channels', history: 'history', request: 'request', google: 'google-auth' })) $('#'+id).hidden = tab !== activeTab;
    resetSessionSelection();
    if (activeTab === 'request') void loadLatestRequest();
    else {
      latestRequestId++;
      if (activeTab === 'channels') {
        sessionScope = 'channels'; sessionChannelId = selectedChannelId; sessionSnapshot = '';
        moveRecordsWorkspace();
        if (!channelRows.length) void loadChannels();
        else if (channelView === 'records' && selectedChannelId && !selectedSession) void loadSessions(false);
      } else if (activeTab === 'history') {
        sessionScope = 'history'; sessionChannelId = null; sessionSnapshot = '';
        resetSessionSelection(); moveRecordsWorkspace(); void loadSessions(false);
      } else if (activeTab === 'google') {
        setStatus('Google 設定。'); if (!googleCsrf && !googleBusy) void loadGoogleStatus();
      }
    }
  };
});
document.querySelectorAll('[data-channel-view]').forEach(button => button.onclick = () => {
  channelView = button.dataset.channelView;
  document.querySelectorAll('[data-channel-view]').forEach(tab => { const selected = tab === button; tab.setAttribute('aria-pressed', String(selected)); tab.classList.toggle('selected', selected); });
  $('#channel-records-view').hidden = channelView !== 'records'; $('#channel-settings-view').hidden = channelView !== 'settings';
  if (channelView === 'records' && activeTab === 'channels') { moveRecordsWorkspace(); if (selectedChannelId && !sessionSnapshot) void loadSessions(false); }
});

document.querySelectorAll('[data-session-state]').forEach(button => {
  button.onclick = () => {
    const nextState = button.dataset.sessionState;
    if (nextState === sessionState) return;
    sessionState = nextState;
    selectedSession = null;
    sessionOffset = 0;
    recordOffset = 0;
    sessionDetails = new Map();
    $('#session-list').replaceChildren();
    $('#more-sessions').hidden = true;
    recordRequestId++;
    $('#session-title').textContent = '選擇一個 Session';
    $('#session-title').removeAttribute('title');
    $('#records').replaceChildren();
    $('#more-records').hidden = true;
    document.querySelectorAll('[data-session-state]').forEach(tab => {
      const selected = tab === button;
      tab.classList.toggle('selected', selected);
      tab.setAttribute('aria-pressed', String(selected));
    });
    void loadSessions(false);
  };
});

document.querySelectorAll('[data-kind]').forEach(button => {
  button.onclick = () => {
    selectedKind = button.dataset.kind;
    recordOffset = 0;
    $('#records').replaceChildren();
    document.querySelectorAll('[data-kind]').forEach(tab => { tab.classList.toggle('selected', tab === button); tab.setAttribute('aria-pressed', String(tab === button)); });
    void loadRecords(false);
  };
});

$('#refresh').onclick = () => {
  if (activeTab === 'google') { if (!googleCsrf && !googleBusy) void loadGoogleStatus(); }
  else if (activeTab === 'request') void loadLatestRequest();
  else if (activeTab === 'channels') {
    void loadChannels(true);
  } else { sessionSnapshot = ''; resetSessionSelection(); void loadSessions(false); }
};
$('#more-sessions').onclick = () => void loadSessions(true);
$('#more-records').onclick = () => void loadRecords(true);
$('#copy').onclick = () => rawRequestBody && navigator.clipboard.writeText(rawRequestBody)
  .then(() => setStatus('已複製去除附件內容的請求檢視 JSON。'))
  .catch(error => setStatus(`複製失敗：${error.message}`));
$('#download').onclick = () => {
  if (rawRequestBody) downloadBlob(rawRequestBody, 'latest-cpa-request.json', 'application/json');
};

let googleCsrf = null;
let googleBusy = false;
let googleExpiry;
function clearGoogleTransaction() {
  googleCsrf = null;
  clearTimeout(googleExpiry);
  $('#google-url').value = '';
  $('#google-csrf-url')?.remove();
  $('#google-complete').hidden = true;
}
async function loadGoogleStatus() {
  try {
    const { status, accounts } = await getJson('api/google/status');
    const list = $('#google-accounts');
    list.replaceChildren();
    for (const account of accounts) {
      const row = element('div');
      row.append(element('span', `${account.email} — ${account.status === 'connected' ? '已連線' : '需要重新授權'}${account.default ? '（預設）' : ''}；gmail.modify：${account.gmail_modify ? '已授權' : '未授權'} `));
      if (!account.default) { const button = element('button', '設為預設'); button.type = 'button'; button.onclick = () => void manageGoogleAccount('default', account.email); row.append(button); }
      const remove = element('button', '移除帳號'); remove.type = 'button'; remove.onclick = () => void manageGoogleAccount('remove', account.email); row.append(remove);
      list.append(row);
    }
    const labels = { not_configured: '尚未設定 client', not_connected: '尚未連線', connected: '已連線', reauthorization_required: '需要重新授權' };
    $('#google-status').textContent = labels[status] ?? '連線狀態未知';
    $('#google-start').disabled = googleBusy || status === 'not_configured';
  } catch { $('#google-status').textContent = '無法讀取 Google 連線狀態'; }
}
async function manageGoogleAccount(action, account) {
  if (googleBusy) return;
  if (action === 'remove' && !confirm(`移除 ${account} 的本機授權？`)) return;
  googleBusy = true;
  try {
    const response = await fetch(`api/google/${action}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ account }), cache: 'no-store', credentials: 'same-origin' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? '操作失敗');
    await loadGoogleStatus();
    if (action === 'remove' && !data.revoked) $('#google-status').textContent = '已移除本機憑證，但 Google 撤銷授權失敗。';
  } catch (error) { $('#google-status').textContent = error.message; }
  finally { googleBusy = false; $('#google-start').disabled = false; }
}
$('#google-start').onclick = async () => {
  if (googleBusy) return;
  googleBusy = true;
  clearGoogleTransaction();
  $('#google-start').disabled = true;
  $('#google-submit').disabled = true;
  try {
    const response = await fetch('api/google/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', cache: 'no-store', credentials: 'same-origin' });
    if (!response.ok) throw new Error('無法開始授權');
    const data = await response.json();
    googleCsrf = data.csrf;
    $('#google-csrf-url')?.remove();
    const link = element('a', '開啟 Google 授權頁面');
    link.id = 'google-csrf-url'; link.href = data.url; link.target = '_blank'; link.rel = 'noopener noreferrer';
    $('#google-complete').prepend(link); $('#google-complete').hidden = false;
    $('#google-status').textContent = '請在 Google 授權後，於五分鐘內複製導回的完整網址並貼回此處。';
    googleExpiry = setTimeout(() => { clearGoogleTransaction(); $('#google-status').textContent = '授權已逾時，請重新開始。'; }, 300_000);
  } catch { clearGoogleTransaction(); $('#google-status').textContent = '無法開始授權，請確認 client 設定與公開 UI origin。'; }
  finally { googleBusy = false; $('#google-start').disabled = false; $('#google-submit').disabled = false; }
};
$('#google-submit').onclick = async () => {
  if (googleBusy) return;
  googleBusy = true;
  const input = $('#google-url'); const pastedUrl = input.value; input.value = '';
  $('#google-start').disabled = true;
  $('#google-submit').disabled = true;
  try {
    if (!googleCsrf || !pastedUrl) throw new Error('請先開始授權並貼上完整網址');
    const response = await fetch('api/google/complete', { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': googleCsrf }, body: JSON.stringify({ url: pastedUrl }), cache: 'no-store', credentials: 'same-origin' });
    googleCsrf = null;
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? '授權失敗，請重新開始');
    $('#google-complete').hidden = true; await loadGoogleStatus();
  } catch (error) { $('#google-status').textContent = error.message; }
  finally { googleBusy = false; clearGoogleTransaction(); $('#google-start').disabled = false; $('#google-submit').disabled = false; }
};
void loadChannels();

let embeddedFrame=null;
try { const frame=window.frameElement; if(frame && frame.tagName==='IFRAME') { embeddedFrame=frame; document.documentElement.classList.add('embedded'); document.body.classList.add('embedded'); frame.style.display='block'; } } catch { /* standalone or inaccessible frame */ }
if(embeddedFrame){ let resizeFrame=0,lastHeight=0; const scheduleFrameResize=()=>{if(resizeFrame)return;resizeFrame=requestAnimationFrame(()=>{resizeFrame=0;const height=Math.ceil($('main').getBoundingClientRect().height);if(height>0&&height!==lastHeight){lastHeight=height;embeddedFrame.style.height=`${height}px`;}});}; new ResizeObserver(scheduleFrameResize).observe($('main')); document.querySelectorAll('[data-tab]').forEach(tab=>tab.addEventListener('click',scheduleFrameResize)); window.addEventListener('resize',scheduleFrameResize); if(document.fonts?.ready) document.fonts.ready.then(scheduleFrameResize); scheduleFrameResize();}

window.addEventListener('beforeunload', event => { if ([...channelDrafts.keys()].some(isChannelDirty)) { event.preventDefault(); event.returnValue=''; } });
