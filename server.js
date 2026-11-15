// Gemini Friend v3 — voice-practice app, runs on your Mac or in the cloud.
//
//   browser  <--WebSocket-->  this server  <--Live API-->  Gemini
//
// Your API key stays on this server. The server:
//   - asks for a passcode when APP_PASSCODE is set (required for cloud hosting),
//   - reconnects when the Live API's ~10-minute connection cap hits,
//   - saves every call as JSON: in data/sessions/ locally, or in Upstash Redis
//     (free) when UPSTASH_REDIS_REST_URL / _TOKEN are set, so history survives restarts,
//   - computes simple stats (talk share, filler words),
//   - stores the feedback you paste back from Claude and extracts tomorrow's drill,
//   - feeds that drill into your next call so the friend creates openings to practise it.

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { GoogleGenAI, Modality } from '@google/genai';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
process.env.TZ = process.env.APP_TZ || process.env.TZ || 'Asia/Kolkata'; // "today" and streaks follow this timezone, not the server's
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || (process.env.RENDER ? '0.0.0.0' : '127.0.0.1'); // Render sets RENDER automatically
const PASS = process.env.APP_PASSCODE || '';
const UP_URL = (process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/$/, '');
const UP_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const USE_REDIS = !!(UP_URL && UP_TOKEN);
const EXTRA_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map((x) => x.trim()).filter(Boolean);
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-live';
const VOICE = process.env.VOICE || 'Puck';
const API_KEY = process.env.GEMINI_API_KEY;
const GOAL_MIN = Number(process.env.DAILY_GOAL_MIN || 45);
const STREAK_MIN = Number(process.env.STREAK_MIN || 10); // minutes a day needs to count toward the streak

const isLoopback = ['127.0.0.1', 'localhost', '::1'].includes(HOST);
if (!isLoopback && !PASS) {
  console.error('Refusing to start: HOST is open to the network but APP_PASSCODE is not set. Anyone could use your Gemini key.');
  process.exit(1);
}
if (PASS && PASS.length < 8) {
  console.error('APP_PASSCODE must be at least 8 characters.');
  process.exit(1);
}

const DATA_DIR = path.join(__dirname, 'data', 'sessions');
const TRANSCRIPT_DIR = path.join(__dirname, 'transcripts');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(TRANSCRIPT_DIR, { recursive: true });

const SYSTEM_PROMPT = fs.readFileSync(path.join(__dirname, 'friend-prompt.txt'), 'utf8');
const ai = API_KEY ? new GoogleGenAI({ apiKey: API_KEY }) : null;

// ---------- focus modes (shown as chips in the UI) ----------
const MODES = {
  free: { label: 'Free chat', prompt: '' },
  small: {
    label: 'Small talk',
    prompt: 'Today\'s focus: small talk. Act like a friendly person I just met at an event or in a lift, then relax into friend mode if it flows. Keep topics light and everyday. Let me practise opening a chat, finding common ground, keeping it alive with follow-up questions, and closing politely.',
  },
  story: {
    label: 'Storytelling',
    prompt: 'Today\'s focus: storytelling. Ask me to tell short stories (something that happened this week, a mistake, a lesson, a person who shaped me). Ask follow-ups about the setup, the tension and the ending. If a story is flat, ask "and then what happened?" or "what did that feel like?" rather than telling me how to fix it.',
  },
  pitch: {
    label: 'Pitch',
    prompt: 'Today\'s focus: pitching. Play a curious but busy investor or potential client. Ask me to pitch what I do, my side project or a design idea in about a minute, then probe with real questions: who is it for, why now, why you, what does it cost. Stay friendly but make me earn clarity.',
  },
  explain: {
    label: 'Explain',
    prompt: 'Today\'s focus: articulation. Ask me to explain ideas from my work or interests as if to someone smart who is new to the topic (design systems, fintech, a decision I made). Ask "can you give an example?" and "so what\'s the point?" to push me toward short, structured answers.',
  },
  debate: {
    label: 'Debate',
    prompt: 'Today\'s focus: defending a view. Bring up a mild, everyday opinion question, take the opposite side from me, and push back politely a few times. Let me practise staying calm, structuring a reply and conceding a point gracefully.',
  },
};

// ---------- helpers ----------
const pad = (n) => String(n).padStart(2, '0');
const localDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const stampId = (d) => `${localDate(d)}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
const fmt = (s) => `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
const ID_RE = /^[0-9_-]+$/;

const FILLER_RE = /\b(?:um+|uh+|erm?|you know|i mean|sort of|kind of|basically|actually|literally|honestly)\b/gi;
function countWords(s) { return (s.match(/[\p{L}\p{N}']+/gu) || []).length; }

function computeStats(lines) {
  let userWords = 0, friendWords = 0, fillers = 0;
  const byWord = {};
  for (const l of lines) {
    const w = countWords(l.text);
    if (l.who === 'user') {
      userWords += w;
      for (const m of l.text.matchAll(FILLER_RE)) {
        const k = m[0].toLowerCase();
        byWord[k] = (byWord[k] || 0) + 1;
        fillers++;
      }
    } else friendWords += w;
  }
  const total = userWords + friendWords;
  return {
    userWords, friendWords, fillers, byWord,
    share: total ? Math.round((userWords / total) * 100) : 0,
    fillersPer100: userWords ? Math.round((fillers / userWords) * 1000) / 10 : 0,
  };
}

// Parse the reply the user pastes back from Claude.
function parseFeedback(raw) {
  const text = String(raw || '').replace(/\r/g, '').trim();
  const heads = [];
  const re = /^[ \t]{0,3}(?:#{1,4}[ \t]*(.+?)|\*\*(.+?)\*\*:?)[ \t]*#*[ \t]*$/gm;
  let m;
  while ((m = re.exec(text))) heads.push({ name: (m[1] || m[2]).trim(), start: m.index, end: m.index + m[0].length });
  const sections = {};
  const keyOf = (n) => {
    n = n.toLowerCase();
    if (n.includes('summary')) return 'summary';
    if (n.includes('score')) return 'scores';
    if (n.includes('strong') || n.includes('best')) return 'strongest';
    if (n.includes('work on') || n.includes('improve') || n.includes('fix')) return 'workOn';
    if (n.includes('drill') || n.includes('tomorrow') || n.includes('practi')) return 'drill';
    return null;
  };
  heads.forEach((h, i) => {
    const body = text.slice(h.end, i + 1 < heads.length ? heads[i + 1].start : undefined).trim();
    const key = keyOf(h.name);
    if (key && body && !sections[key]) sections[key] = body;
  });
  const scores = [];
  if (sections.scores) {
    for (const line of sections.scores.split('\n')) {
      const s = line.match(/^[\s>*\-•]*\**\s*([A-Za-z][A-Za-z &/]*?)\s*\**\s*[:\-–=]\s*\**\s*(\d{1,2})(?:\s*\/\s*10)?/);
      if (s) scores.push({ name: s[1].trim(), value: Math.max(0, Math.min(10, Number(s[2]))) });
    }
  }
  return { raw: text, sections, scores, parsed: Object.keys(sections).length > 0 };
}

const avgScore = (s) => (s.feedback?.scores?.length ? Math.round((s.feedback.scores.reduce((a, x) => a + x.value, 0) / s.feedback.scores.length) * 10) / 10 : null);
// Small record kept in the index: enough for Home, History and the drill, without the transcript.
const indexEntry = (s) => ({
  id: s.id, startedAt: s.startedAt, durationSec: s.durationSec, mode: s.mode, topic: s.topic,
  stats: s.stats, hasFeedback: !!s.feedback, avgScore: avgScore(s),
  drill: s.feedback?.sections?.drill || null, drillDone: !!s.drillDone,
});
const byNewest = (a, b) => (a.startedAt < b.startedAt ? 1 : -1);

// ---------- storage: local files, or Upstash Redis over HTTPS ----------
const fileStore = {
  path: (id) => path.join(DATA_DIR, `${id}.json`),
  async get(id) {
    if (!ID_RE.test(id) || !fs.existsSync(this.path(id))) return null;
    try { return JSON.parse(fs.readFileSync(this.path(id), 'utf8')); } catch { return null; }
  },
  async put(s) {
    fs.writeFileSync(this.path(s.id), JSON.stringify(s, null, 2));
    const md = `# Call ${s.id}\nMode: ${MODES[s.mode]?.label || s.mode}${s.topic ? `\nTopic: ${s.topic}` : ''}\nDuration: ${fmt(s.durationSec)}\n\n` +
      s.lines.map((l) => `[${fmt(l.t)}] ${l.who === 'user' ? 'ME' : 'FRIEND'}: ${l.text}`).join('\n') + '\n';
    fs.writeFileSync(path.join(TRANSCRIPT_DIR, `${s.id}.md`), md);
  },
  async list() {
    return fs.readdirSync(DATA_DIR).filter((f) => f.endsWith('.json'))
      .map((f) => { try { return indexEntry(JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8'))); } catch { return null; } })
      .filter(Boolean).sort(byNewest);
  },
};

async function redis(commands) {
  const r = await fetch(`${UP_URL}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${UP_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands),
  });
  if (!r.ok) throw new Error(`Upstash ${r.status}`);
  const out = await r.json();
  const bad = out.find((x) => x.error);
  if (bad) throw new Error(`Upstash: ${bad.error}`);
  return out.map((x) => x.result);
}
const redisStore = {
  async get(id) {
    if (!ID_RE.test(id)) return null;
    const [v] = await redis([['GET', `gf:s:${id}`]]);
    return v ? JSON.parse(v) : null;
  },
  async put(s) {
    await redis([['SET', `gf:s:${s.id}`, JSON.stringify(s)], ['HSET', 'gf:idx', s.id, JSON.stringify(indexEntry(s))]]);
  },
  async list() {
    const [flat] = await redis([['HGETALL', 'gf:idx']]);
    const out = [];
    for (let i = 1; i < (flat || []).length; i += 2) { try { out.push(JSON.parse(flat[i])); } catch {} }
    return out.sort(byNewest);
  },
};

let idxCache = null;
const store = {
  async get(id) { return (USE_REDIS ? await redisStore.get(id) : null) || fileStore.get(id); },
  async put(s) { await (USE_REDIS ? redisStore : fileStore).put(s); idxCache = null; },
  async list() { return (idxCache ||= await (USE_REDIS ? redisStore : fileStore).list()); },
};

function latestDrill(entries) {
  const s = entries.find((x) => x.drill);
  return s ? { sessionId: s.id, startedAt: s.startedAt, text: s.drill, done: !!s.drillDone } : null;
}

async function buildState() {
  const sessions = await store.list();
  const minutesByDay = {};
  let totalMin = 0;
  for (const s of sessions) {
    const k = localDate(new Date(s.startedAt));
    const mins = s.durationSec / 60;
    minutesByDay[k] = (minutesByDay[k] || 0) + mins;
    totalMin += mins;
  }
  const today = localDate(new Date());
  const last14 = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    last14.push({ date: localDate(d), minutes: Math.round((minutesByDay[localDate(d)] || 0) * 10) / 10 });
  }
  let streak = 0;
  const d = new Date();
  if ((minutesByDay[localDate(d)] || 0) < STREAK_MIN) d.setDate(d.getDate() - 1);
  while ((minutesByDay[localDate(d)] || 0) >= STREAK_MIN) { streak++; d.setDate(d.getDate() - 1); }

  const scored = sessions.filter((s) => s.avgScore !== null).slice(0, 10).reverse()
    .map((s) => ({ id: s.id, date: localDate(new Date(s.startedAt)), avg: s.avgScore }));

  return {
    goalMin: GOAL_MIN, streakMin: STREAK_MIN,
    todayMinutes: Math.round((minutesByDay[today] || 0) * 10) / 10,
    streak, last14, scored,
    totals: { sessions: sessions.length, minutes: Math.round(totalMin) },
    drill: latestDrill(sessions),
    modes: Object.entries(MODES).map(([key, m]) => ({ key, label: m.label })),
    keyConfigured: !!API_KEY,
  };
}

// ---------- HTTP: static files + small JSON API ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

function originOk(req) {
  const o = req.headers.origin;
  if (!o) return true;
  try {
    const u = new URL(o);
    if (!PASS) return (u.hostname === 'localhost' || u.hostname === '127.0.0.1') && String(u.port || 80) === String(PORT); // local-only mode
    return u.host === req.headers.host || EXTRA_ORIGINS.includes(u.origin);                                           // cloud mode
  } catch { return false; }
}

// ---------- passcode login (cookie holds a signed expiry, never the passcode) ----------
const SECRET = process.env.SESSION_SECRET || crypto.createHash('sha256').update('gf|' + PASS).digest('hex');
const sha = (x) => crypto.createHash('sha256').update(String(x)).digest();
const sign = (v) => crypto.createHmac('sha256', SECRET).update(v).digest('hex');
const passOk = (given) => crypto.timingSafeEqual(sha(given), sha(PASS));
const makeToken = () => { const exp = String(Date.now() + 30 * 864e5); return `${exp}.${sign(exp)}`; };
function tokenOk(tok) {
  const [exp, sig] = String(tok || '').split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const good = sign(exp);
  return sig.length === good.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good));
}
function cookieOf(req, name) {
  const hit = (req.headers.cookie || '').split(/;\s*/).find((c) => c.startsWith(name + '='));
  return hit ? decodeURIComponent(hit.slice(name.length + 1)) : '';
}
const authed = (req) => !PASS || tokenOk(cookieOf(req, 'gf_auth'));
const isHttps = (req) => req.headers['x-forwarded-proto'] === 'https' || !!req.socket.encrypted;
const cookieStr = (req, v, maxAge) => `gf_auth=${v}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${isHttps(req) ? '; Secure' : ''}`;

// Slow down passcode guessing: 5 misses per IP and 30 overall per 15 minutes.
const misses = new Map();
const WINDOW = 15 * 60_000;
const ipOf = (req) => String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '?';
function missCount(key) {
  const now = Date.now();
  const arr = (misses.get(key) || []).filter((t) => now - t < WINDOW);
  misses.set(key, arr);
  return arr.length;
}
const addMiss = (key) => { missCount(key); misses.get(key).push(Date.now()); };
const locked = (req) => missCount('ip:' + ipOf(req)) >= 5 || missCount('all') >= 30;

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function readBody(req, limit = 300_000) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

async function handleApi(req, res) {
  if (!originOk(req)) return sendJson(res, 403, { error: 'bad origin' });
  const url = new URL(req.url, 'http://localhost');
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
  try {
    if (req.method === 'GET' && parts[1] === 'auth') return sendJson(res, 200, { required: !!PASS, authed: authed(req) });
    if (req.method === 'POST' && parts[1] === 'login') {
      if (!PASS) return sendJson(res, 200, { ok: true });
      if (!String(req.headers['content-type'] || '').includes('application/json')) return sendJson(res, 415, { error: 'json only' });
      if (locked(req)) return sendJson(res, 429, { error: 'Too many tries. Wait 15 minutes.' });
      const body = await readBody(req, 2000);
      if (!passOk(body.passcode || '')) { addMiss('ip:' + ipOf(req)); addMiss('all'); return sendJson(res, 401, { error: 'Wrong passcode.' }); }
      res.setHeader('Set-Cookie', cookieStr(req, makeToken(), 30 * 86400));
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'POST' && parts[1] === 'logout') {
      res.setHeader('Set-Cookie', cookieStr(req, '', 0));
      return sendJson(res, 200, { ok: true });
    }
    if (!authed(req)) return sendJson(res, 401, { error: 'login required' });

    if (req.method === 'GET' && parts[1] === 'state') return sendJson(res, 200, await buildState());
    if (req.method === 'GET' && parts[1] === 'sessions' && !parts[2]) return sendJson(res, 200, await store.list());
    if (req.method === 'GET' && parts[1] === 'sessions' && parts[2]) {
      const s = await store.get(parts[2]);
      return s ? sendJson(res, 200, { ...s, modeLabel: MODES[s.mode]?.label || 'Free chat' }) : sendJson(res, 404, { error: 'not found' });
    }
    if (req.method === 'POST' && parts[1] === 'sessions' && parts[2] && parts[3]) {
      if (!String(req.headers['content-type'] || '').includes('application/json')) return sendJson(res, 415, { error: 'json only' });
      const s = await store.get(parts[2]);
      if (!s) return sendJson(res, 404, { error: 'not found' });
      const body = await readBody(req);
      if (parts[3] === 'feedback') {
        const fb = parseFeedback(body.raw);
        if (!fb.raw) return sendJson(res, 400, { error: 'empty' });
        s.feedback = { ...fb, savedAt: new Date().toISOString() };
        s.drillDone = false;
        await store.put(s);
        return sendJson(res, 200, s);
      }
      if (parts[3] === 'drill') {
        s.drillDone = !!body.done;
        await store.put(s);
        return sendJson(res, 200, { ok: true, done: s.drillDone });
      }
    }
    return sendJson(res, 404, { error: 'unknown route' });
  } catch (e) {
    return sendJson(res, 400, { error: e.message });
  }
}

const server = http.createServer((req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'microphone=(self), camera=(), geolocation=()');
  if (req.url === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok'); return; }
  if (req.url.startsWith('/api/')) { handleApi(req, res); return; }
  const rel = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  const root = path.join(__dirname, 'public');
  const file = path.join(root, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404).end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
});

// ---------- one call per browser connection ----------
const wss = new WebSocketServer({ server, path: '/ws', verifyClient: (info) => originOk(info.req) && authed(info.req) });
const activeCalls = new Set();
// Pings keep proxies from closing a quiet connection.
setInterval(() => { for (const c of wss.clients) { try { c.ping(); } catch {} } }, 25_000).unref();

wss.on('connection', (ws) => {
  let session = null;           // current Live API session
  let resumeHandle = null;      // latest session-resumption handle
  let ending = false;
  let reconnecting = false;
  let topic = '', mode = 'free', drillUsed = null;
  let startedAt = Date.now();

  const lines = [];             // { who, t, text }
  const buf = { user: null, model: null };
  const elapsed = () => Math.round((Date.now() - startedAt) / 1000);
  const send = (obj) => { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); };

  function flush(who) {
    const b = buf[who];
    if (b && b.text.trim()) {
      const line = { who, t: b.t, text: b.text.trim() };
      lines.push(line);
      send({ type: 'line', who, t: fmt(b.t), text: line.text });
    }
    buf[who] = null;
  }
  function addChunk(who, text) {
    flush(who === 'user' ? 'model' : 'user'); // a new speaker started: close the other side's line
    if (!buf[who]) buf[who] = { t: elapsed(), text: '' };
    buf[who].text += text;
    send({ type: 'partial', who, text: buf[who].text });
  }

  function buildConfig() {
    const extra = [];
    if (MODES[mode]?.prompt) extra.push(MODES[mode].prompt);
    if (drillUsed) extra.push(`Something I'm trying to practise: "${drillUsed}". Do not mention it, do not coach me on it, and do not say it's a drill. Just create natural openings in the conversation where I'd get to use it.`);
    if (topic) extra.push(`If I haven't already moved on, start with this topic: ${topic}`);
    return {
      responseModalities: [Modality.AUDIO],
      systemInstruction: [SYSTEM_PROMPT, ...extra].join('\n\n'),
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE } } },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      contextWindowCompression: { slidingWindow: {} },
      sessionResumption: resumeHandle ? { handle: resumeHandle } : {},
    };
  }

  // Each session's callbacks only act while it is the current one, so a retired
  // connection closing can never trigger a reconnect loop.
  async function openSession() {
    let me = null;
    const s = await ai.live.connect({
      model: MODEL,
      config: buildConfig(),
      callbacks: {
        onopen: () => {},
        onmessage: (msg) => handleMessage(me, msg),
        onerror: (e) => { if (me === session) send({ type: 'error', message: e?.message || 'Live API error' }); },
        onclose: (e) => handleClose(me, e),
      },
    });
    me = s;
    return s;
  }

  function handleMessage(owner, msg) {
    if (owner !== session) return;
    if (msg.sessionResumptionUpdate?.newHandle && msg.sessionResumptionUpdate.resumable !== false) {
      resumeHandle = msg.sessionResumptionUpdate.newHandle;
    }
    if (msg.goAway) reconnect('goAway');
    const c = msg.serverContent;
    if (!c) return;
    if (c.interrupted) send({ type: 'interrupted' });
    if (c.inputTranscription?.text) addChunk('user', c.inputTranscription.text);
    if (c.outputTranscription?.text) addChunk('model', c.outputTranscription.text);
    if (c.modelTurn?.parts) {
      for (const p of c.modelTurn.parts) {
        if (p.inlineData?.data && ws.readyState === 1) ws.send(Buffer.from(p.inlineData.data, 'base64')); // raw 24 kHz PCM16
      }
    }
    if (c.turnComplete) flush('model');
  }

  function handleClose(owner, e) {
    if (owner !== session || ending) return;
    reconnect('close', e?.reason);
  }

  async function reconnect(reason, detail) {
    if (reconnecting || ending) return;
    reconnecting = true;
    send({ type: 'status', message: 'Reconnecting…' });
    const old = session;
    flush('user'); flush('model');
    try {
      session = null; // pause mic forwarding while we swap
      const fresh = await openSession();
      session = fresh;
      try { old?.close(); } catch {}
      send({ type: 'status', message: 'Connected' });
    } catch (err) {
      send({ type: 'error', message: `Could not reconnect (${reason}${detail ? ': ' + detail : ''}): ${err.message}` });
      finish();
    } finally {
      reconnecting = false;
    }
  }

  async function finish() {
    if (ending) return;
    ending = true;
    flush('user'); flush('model');
    try { session?.close(); } catch {}
    session = null;
    let id = null, saveError = null;
    if (lines.length) {
      const d = new Date(startedAt);
      id = stampId(d);
      const rec = {
        id, startedAt: d.toISOString(), durationSec: elapsed(), mode, topic, drillUsed,
        lines, stats: computeStats(lines), feedback: null, drillDone: false,
      };
      try { await store.put(rec); }
      catch (e) {
        saveError = e.message;
        console.error('Saving to the main store failed, keeping a local copy:', e.message);
        try { await fileStore.put(rec); } catch {}
      }
    }
    activeCalls.delete(finish);
    send({ type: 'ended', id, hasContent: lines.length > 0, saveError });
  }
  activeCalls.add(finish);

  ws.on('message', async (data, isBinary) => {
    if (isBinary) {
      if (session && !reconnecting) {
        try { session.sendRealtimeInput({ audio: { data: Buffer.from(data).toString('base64'), mimeType: 'audio/pcm;rate=16000' } }); } catch {}
      }
      return;
    }
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    if (msg.type === 'start') {
      if (!ai) { send({ type: 'error', message: 'No GEMINI_API_KEY found. Copy .env.example to .env, add your key, and restart.' }); return; }
      topic = String(msg.topic || '').slice(0, 300);
      mode = MODES[msg.mode] ? msg.mode : 'free';
      if (msg.useDrill) {
        const d = latestDrill(await store.list());
        if (d && !d.done) drillUsed = d.text.slice(0, 600);
      }
      try {
        send({ type: 'status', message: 'Connecting…' });
        session = await openSession();
        startedAt = Date.now();
        send({ type: 'ready' });
        try { session.sendRealtimeInput({ text: 'Hey! (The call just connected. Greet me casually and start the conversation.)' }); } catch {}
      } catch (err) {
        send({ type: 'error', message: `Could not start: ${err.message}` });
      }
    } else if (msg.type === 'end') {
      finish();
    }
  });

  ws.on('close', () => { if (!ending) finish(); });
});

server.listen(PORT, HOST, () => {
  console.log(`Gemini Friend v3 running at http://localhost:${PORT}  (model: ${MODEL}, voice: ${VOICE}, goal: ${GOAL_MIN} min/day)`);
  console.log(`Storage: ${USE_REDIS ? 'Upstash Redis' : 'local files (data/)'}  ·  Login: ${PASS ? 'passcode required' : 'off (local only)'}  ·  Bound to ${HOST}`);
  if (!API_KEY) console.log('⚠  GEMINI_API_KEY is not set. Copy .env.example to .env and add your key.');
});

// On redeploy or restart, save any call in progress before exiting.
process.on('SIGTERM', async () => {
  await Promise.allSettled([...activeCalls].map((f) => f()));
  process.exit(0);
});
