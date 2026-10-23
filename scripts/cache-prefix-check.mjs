// Usage: node scripts/cache-prefix-check.mjs [database]
// For each session, checks that an ask's first model request extends the previous ask's first request (minus the trailing context estimate) and prints the first diverging input item.
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.argv[2] ?? new URL("../.data/butler.sqlite", import.meta.url).pathname, { readOnly: true });
const rows = db.prepare("SELECT session_id, ask_id, turn, attempted_at, body_json, usage_json FROM model_requests WHERE turn=0 ORDER BY rowid").all();
const bySession = new Map();
for (const r of rows) { if (!bySession.has(r.session_id)) bySession.set(r.session_id, []); bySession.get(r.session_id).push(r); }
for (const [session, list] of bySession) {
  for (let i = 1; i < list.length; i++) {
    const prev = JSON.parse(list[i-1].body_json).body, cur = JSON.parse(list[i].body_json).body;
    const a = prev.input.slice(0, -1), b = cur.input; // drop trailing context estimate
    let d = 0; while (d < a.length && d < b.length && JSON.stringify(a[d]) === JSON.stringify(b[d])) d++;
    const u = JSON.parse(list[i].usage_json ?? 'null');
    const toolsSame = JSON.stringify(prev.tools) === JSON.stringify(cur.tools);
    const desc = x => x ? `${x.role ?? x.type}: ${JSON.stringify(x.content ?? x).slice(0, 90)}` : '(end)';
    console.log(`${session.slice(0,8)} ${list[i].attempted_at} tools_same=${toolsSame} prefix_ok=${d === a.length} diverge@${d}/${a.length} cached=${u?.input_tokens_details?.cached_tokens}/${u?.input_tokens}`);
    if (d < a.length) console.log(`   prev: ${desc(a[d])}\n   cur:  ${desc(b[d])}`);
  }
}
