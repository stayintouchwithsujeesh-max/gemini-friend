// One-off: copy calls saved in data/sessions/ on your Mac into Upstash Redis.
// Run:  node --env-file=.env scripts/import-local-history.js
// (needs UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN in your local .env)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'sessions');
const url = (process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/$/, '');
const token = process.env.UPSTASH_REDIS_REST_TOKEN || '';
if (!url || !token) { console.error('Add UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN to .env first.'); process.exit(1); }
if (!fs.existsSync(dir)) { console.log('No data/sessions folder. Nothing to import.'); process.exit(0); }

const avg = (s) => (s.feedback?.scores?.length ? Math.round((s.feedback.scores.reduce((a, x) => a + x.value, 0) / s.feedback.scores.length) * 10) / 10 : null);
const entry = (s) => ({ id: s.id, startedAt: s.startedAt, durationSec: s.durationSec, mode: s.mode, topic: s.topic, stats: s.stats,
  hasFeedback: !!s.feedback, avgScore: avg(s), drill: s.feedback?.sections?.drill || null, drillDone: !!s.drillDone });

let n = 0;
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
  const s = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  const r = await fetch(`${url}/pipeline`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify([['SET', `gf:s:${s.id}`, JSON.stringify(s)], ['HSET', 'gf:idx', s.id, JSON.stringify(entry(s))]]),
  });
  if (!r.ok) { console.error(`Failed on ${f}: ${r.status}`); process.exit(1); }
  n++;
}
console.log(`Imported ${n} call(s).`);
