const $ = selector => document.querySelector(selector);

let selectedSession = null;
let selectedKind = 'messages';
let activeTab = 'sessions';
let sessionOffset = 0;
let recordOffset = 0;
let rawRequestBody = null;
let sessionRequestId = 0;
let recordRequestId = 0;
let latestRequestId = 0;
const pendingSessionPages = new Set();
const pendingRecordPages = new Set();

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

async function loadSessions(append = false) {
  const offset = append ? sessionOffset : 0;
  const pageKey = String(offset);
  if (append && pendingSessionPages.has(pageKey)) return;
  const requestId = ++sessionRequestId;
  if (append) pendingSessionPages.add(pageKey);
  else sessionOffset = 0;

  try {
    setStatus('載入 Session…');
    const data = await getJson(`api/sessions?offset=${offset}`);
    if (requestId !== sessionRequestId) return;

    const host = $('#session-list');
    if (!append) host.replaceChildren();
    for (const session of data.items) {
      const button = element('button', undefined, 'session');
      const source = session.source_type === 'owner'
        ? `頻道共用對話 · channel ${session.channel_id} · owner ${session.owner_id}`
        : session.source_type === 'bot'
          ? `Discord bot · channel ${session.channel_id} · owner ${session.owner_id}${session.bot_id ? ` · bot ${session.bot_id}` : ''}`
          : '來源未知';
      const model = session.current_model
        ? ` · 目前模型設定 ${session.current_model}`
        : session.uses_default_model ? ' · 目前模型設定採預設 CPA_MODEL' : '';
      button.append(
        element('strong', session.id),
        element('small', `${session.created_at} · ${source}${model}`),
        element('small', `最新訊息預覽：${session.latest_preview ?? '（尚無訊息）'}`),
      );
      button.onclick = () => openSession(session.id);
      host.append(button);
    }
    sessionOffset = data.next_offset ?? offset;
    $('#more-sessions').hidden = data.next_offset === null;
    setStatus(data.items.length ? 'Session 已載入。' : '目前沒有 Session。');
  } catch (error) {
    if (requestId === sessionRequestId) setStatus(`載入 Session 失敗：${error.message}`);
  } finally {
    if (append) pendingSessionPages.delete(pageKey);
  }
}

async function openSession(sessionId) {
  selectedSession = sessionId;
  recordOffset = 0;
  $('#session-title').textContent = `Session ${sessionId}`;
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
    for (const row of data.items) {
      const card = element('div', undefined, 'record');
      const fields = kind === 'messages'
        ? [['ID', row.id], ['角色', row.role], ...(row.author_id ? [['作者 ID', row.author_id]] : []), ...(row.is_bot === null ? [] : [['作者類型', row.is_bot ? 'Discord bot' : '人類']]), ['時間', row.event_time ?? row.created_at], ['內容', row.content]]
        : [['ID', row.id], ['工具', row.name], ['狀態', row.status], ['建立', row.created_at], ['完成', row.finished_at ?? '尚未完成'], ['參數', row.arguments], ['結果', row.result ?? (row.status === 'pending' ? '等待中' : '無結果')]];
      for (const [label, value] of fields) {
        card.append(element('strong', `${label}：`));
        card.append(element(['內容', '結果', '參數'].includes(label) ? 'pre' : 'div', value ?? '（空）'));
      }
      if (kind === 'messages' && row.attachments) {
        let attachments = [];
        try { attachments = JSON.parse(row.attachments); } catch { /* malformed metadata is not rendered */ }
        for (const file of attachments) card.append(element('div', `附件：${file.filename} · ${file.mimeType} · ${file.size} bytes · ${file.status}`));
      }
      if (row.name === 'discord_attach_to_reply') {
        card.append(element('div', row.delivery_status
          ? `附件傳送：${row.delivery_status} · ${row.delivery_updated_at}`
          : '附件尚無傳送狀態。'));
      }
      const download = element('button', kind === 'messages' ? '下載完整訊息' : '下載完整工具紀錄');
      download.onclick = () => {
        if (kind === 'messages') {
          downloadBlob(row.content, `message-${safeFilePart(row.id)}.txt`, 'text/plain;charset=utf-8');
        } else {
          downloadBlob(JSON.stringify(row, null, 2), `tool-${safeFilePart(row.id)}.json`, 'application/json');
        }
      };
      card.append(download);
      host.append(card);
    }
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

document.querySelectorAll('[data-tab]').forEach(button => {
  button.onclick = () => {
    activeTab = button.dataset.tab;
    document.querySelectorAll('[data-tab]').forEach(tab => tab.setAttribute('aria-selected', String(tab === button)));
    $('#sessions').hidden = activeTab !== 'sessions';
    $('#request').hidden = activeTab !== 'request';
    if (activeTab === 'request') void loadLatestRequest();
    else {
      latestRequestId++;
      setStatus('就緒。');
    }
  };
});

document.querySelectorAll('[data-kind]').forEach(button => {
  button.onclick = () => {
    selectedKind = button.dataset.kind;
    recordOffset = 0;
    $('#records').replaceChildren();
    document.querySelectorAll('[data-kind]').forEach(tab => tab.classList.toggle('selected', tab === button));
    void loadRecords(false);
  };
});

$('#refresh').onclick = () => {
  if (!googleCsrf) void loadGoogleStatus();
  if (activeTab === 'request') void loadLatestRequest();
  else {
    void loadSessions(false);
    if (selectedSession) {
      recordOffset = 0;
      void loadRecords(false);
    }
  }
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
    const { status } = await getJson('api/google/status');
    const labels = { not_configured: '尚未設定 client', not_connected: '尚未連線', connected: '已連線', reauthorization_required: '需要重新授權' };
    $('#google-status').textContent = labels[status] ?? '連線狀態未知';
    $('#google-start').disabled = status === 'not_configured';
  } catch { $('#google-status').textContent = '無法讀取 Google 連線狀態'; }
}
$('#google-start').onclick = async () => {
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
  finally { $('#google-start').disabled = false; $('#google-submit').disabled = false; }
};
$('#google-submit').onclick = async () => {
  const input = $('#google-url'); const pastedUrl = input.value; input.value = '';
  $('#google-start').disabled = true;
  $('#google-submit').disabled = true;
  try {
    if (!googleCsrf || !pastedUrl) throw new Error('請先開始授權並貼上完整網址');
    const response = await fetch('api/google/complete', { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': googleCsrf }, body: JSON.stringify({ url: pastedUrl }), cache: 'no-store', credentials: 'same-origin' });
    googleCsrf = null;
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? '授權失敗，請重新開始');
    $('#google-complete').hidden = true; $('#google-status').textContent = '已連線';
  } catch (error) { $('#google-status').textContent = error.message; }
  finally { clearGoogleTransaction(); $('#google-start').disabled = false; $('#google-submit').disabled = false; }
};
void loadGoogleStatus();
void loadSessions();
