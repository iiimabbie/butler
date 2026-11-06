// Usage: node scripts/cache-health.mjs [hours=24] [database]
// Read-only prompt-cache report from model_requests: hit rate per channel/schedule, then each cache break with its likely cause.
// A break is a request whose cached tokens fall short of the previous request in the same session by more than MISS_TOKENS.
// Causes: expired (gap > EXPIRE_MIN), model or tools changed, compaction (input shrank), otherwise the first input item that differs.
// model_requests keeps at most the latest 500 rows, so long windows may be truncated; the report prints the oldest row it saw.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

const MISS_TOKENS = 5000, EXPIRE_MIN = 60;
const hours = Number(process.argv[2] ?? 24);
const db = new DatabaseSync(process.argv[3] ?? new URL('../.data/butler.sqlite', import.meta.url).pathname, { readOnly: true });
const since = new Date(Date.now() - hours * 3600e3).toISOString();
const NAMES = (() => { try { return JSON.parse(readFileSync(new URL('../.data/channel-names.json', import.meta.url), 'utf8')); } catch { return {}; } })(); // optional { channelId: label }

const channelOf = new Map(db.prepare("SELECT session_id, channel_id FROM session_sources WHERE source_type='owner'").all().map(r => [r.session_id, r.channel_id]));
const rows = db.prepare('SELECT session_id, turn, attempted_at, body_json, usage_json FROM model_requests WHERE usage_json IS NOT NULL ORDER BY rowid').all();
const oldest = rows[0]?.attempted_at;
const tw = iso => new Date(new Date(iso).getTime() + 8 * 3600e3).toISOString().slice(5, 16).replace('T', ' ');
const fmt = n => n >= 1e4 ? `${(n / 1e4).toFixed(1)}萬` : String(n);

const label = (session, body) => {
  const ch = channelOf.get(session);
  if (ch) return NAMES[ch] ?? ch;
  for (const x of body.input) {
    if (x.role !== 'user') continue;
    const text = typeof x.content === 'string' ? x.content : (x.content ?? []).map(c => c.text ?? '').join('\n');
    const m = text.match(/Scheduled task requested[^\n]*\n\n([^\n]{1,20})/);
    if (m) return `排程「${m[1]}」`;
  }
  return `session ${session.slice(0, 8)}`;
};
const cause = (prev, cur, gapMin) => {
  if (gapMin > EXPIRE_MIN) return `過期（隔 ${Math.round(gapMin)} 分）`;
  if (prev.model !== cur.model) return `換模型 ${prev.model} → ${cur.model}`;
  if (JSON.stringify(prev.tools) !== JSON.stringify(cur.tools)) return '工具清單變了';
  const a = prev.input, b = cur.input;
  let d = 0; while (d < a.length && d < b.length && JSON.stringify(a[d]) === JSON.stringify(b[d])) d++;
  if (b.length < a.length * 0.7) return `壓縮（輸入項 ${a.length} → ${b.length}）`;
  if (d >= a.length) return `開頭沒變卻沒命中（隔 ${Math.round(gapMin)} 分，供應端提早清掉）`;
  const x = b[d];
  const what = x ? `${x.role ?? x.type}: ${JSON.stringify(x.content ?? x).slice(0, 70)}` : '(結尾)';
  return `開頭第 ${d}/${a.length} 項變了 → ${what}`;
};

const stats = new Map(), breaks = [], last = new Map();
for (const r of rows) {
  const u = JSON.parse(r.usage_json), body = JSON.parse(r.body_json).body;
  const input = u.input_tokens ?? 0, cached = u.input_tokens_details?.cached_tokens ?? 0;
  const prev = last.get(r.session_id);
  last.set(r.session_id, { at: r.attempted_at, body, input });
  if (r.attempted_at < since) continue;
  const name = label(r.session_id, body);
  const s = stats.get(name) ?? { n: 0, input: 0, cached: 0, breaks: 0 };
  s.n++; s.input += input; s.cached += cached; stats.set(name, s);
  if (!prev) continue;
  const lost = Math.min(prev.input, input) - cached;
  if (lost <= MISS_TOKENS) continue;
  s.breaks++;
  const gapMin = (new Date(r.attempted_at) - new Date(prev.at)) / 60e3;
  breaks.push(`${tw(r.attempted_at)} ${name} 重算 ${fmt(input - cached)}（命中 ${fmt(cached)}/${fmt(input)}）${cause(prev.body, body, gapMin)}`);
}

const all = [...stats.values()].reduce((t, s) => ({ n: t.n + s.n, input: t.input + s.input, cached: t.cached + s.cached }), { n: 0, input: 0, cached: 0 });
const pct = s => s.input ? `${(100 * s.cached / s.input).toFixed(1)}%` : '-';
console.log(`近 ${hours} 小時（資料最早 ${oldest ? tw(oldest) : '無'}，台北時間）：${all.n} 次請求，命中 ${pct(all)}，重算 ${fmt(all.input - all.cached)}`);
for (const [name, s] of [...stats].sort((a, b) => (b[1].input - b[1].cached) - (a[1].input - a[1].cached)))
  console.log(`- ${name}：${s.n} 次，命中 ${pct(s)}，重算 ${fmt(s.input - s.cached)}，斷 ${s.breaks} 次`);
console.log(breaks.length ? `\n斷點（每個 session 第一次請求不算）：\n${breaks.join('\n')}` : '\n沒有斷點。');
