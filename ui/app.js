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
      const source = session.source_type
        ? `Discord ${session.source_type} · channel ${session.channel_id} · owner ${session.owner_id}${session.bot_id ? ` · bot ${session.bot_id}` : ''}`
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
        ? [['ID', row.id], ['角色', row.role], ['時間', row.created_at], ['內容', row.content]]
        : [['ID', row.id], ['工具', row.name], ['狀態', row.status], ['建立', row.created_at], ['完成', row.finished_at ?? '尚未完成'], ['參數', row.arguments], ['結果', row.result ?? (row.status === 'pending' ? '等待中' : '無結果')]];
      for (const [label, value] of fields) {
        card.append(element('strong', `${label}：`));
        card.append(element(['內容', '結果', '參數'].includes(label) ? 'pre' : 'div', value ?? '（空）'));
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
      ? `送出嘗試：${data.attempted_at} · Session：${data.session_id}（不代表 CPA 已收到）`
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
  .then(() => setStatus('已複製原始 JSON。'))
  .catch(error => setStatus(`複製失敗：${error.message}`));
$('#download').onclick = () => {
  if (rawRequestBody) downloadBlob(rawRequestBody, 'latest-cpa-request.json', 'application/json');
};

void loadSessions();
