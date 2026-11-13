const $ = selector => document.querySelector(selector);

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

$('#refresh').onclick = () => { if (!googleCsrf && !googleBusy) void loadGoogleStatus(); };

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
void loadGoogleStatus();

let embeddedFrame = null;
try {
  if (window !== window.parent && window.parent.document) {
    document.body.classList.add('embedded');
    const frame = window.frameElement;
    if (frame && frame.tagName === 'IFRAME') {
      embeddedFrame = frame;
      frame.style.display = 'block';
    }

    const parentDoc = window.parent.document;
    const parentRoot = parentDoc.documentElement;
    const syncTheme = () => {
      const computed = window.parent.getComputedStyle(parentRoot);
      for (const prop of [
        '--color-background',
        '--color-widget-background',
        '--color-widget-background-highlight',
        '--color-widget-content-border',
        '--color-separator',
        '--color-text-highlight',
        '--color-text-paragraph',
        '--color-text-base',
        '--color-text-base-muted',
        '--color-text-subdue',
        '--color-primary',
        '--color-positive',
        '--color-negative',
        '--border-radius'
      ]) {
        const val = computed.getPropertyValue(prop).trim();
        if (val) document.documentElement.style.setProperty(prop, val);
      }
      // The iframe element must share the page's color-scheme; a mismatch paints an opaque canvas behind it.
      const scheme = parentRoot.getAttribute('data-scheme');
      if (scheme) {
        document.documentElement.style.colorScheme = scheme;
        if (embeddedFrame) embeddedFrame.style.colorScheme = scheme;
      }
    };
    syncTheme();

    const observer = new MutationObserver(syncTheme);
    observer.observe(parentRoot, { attributes: true, attributeFilter: ['data-theme', 'data-scheme'] });
    const themeStyle = parentDoc.getElementById('theme-style');
    if (themeStyle) observer.observe(themeStyle, { childList: true, characterData: true, subtree: true });
  }
} catch { /* standalone or inaccessible frame */ }
// ResizeObserver reports the initial size and every later change, including font loads and width changes.
if (embeddedFrame) new ResizeObserver(() => { embeddedFrame.style.height = `${Math.ceil($('main').getBoundingClientRect().height)}px`; }).observe($('main'));
