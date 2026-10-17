import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { createStore } from './store.js';
import { createCore } from './core.js';
import { ai } from './ai.js';
import { geocode } from './geo.js';
import {
  answerTelegramCallback,
  createSender,
  fetchMedia,
  parseTelegram,
  parseWhatsApp,
  setTelegramWebhook,
  verifyWhatsAppSignature,
} from './channels.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const store = createStore(path.join(config.dataDir, 'reliefline.json'));
const send = createSender(store);
const core = createCore({ store, ai, send, fetchMedia, geocode, config });
if (config.seedDemo) core.seedDemoVolunteers();

// All state changes run one at a time, so two messages can never race on the same incident.
let chain = Promise.resolve();
function enqueue(fn) {
  const job = chain.then(fn);
  chain = job.catch((err) => console.error('[job]', err));
  return job;
}

// ------------------------------------------------------------ http helpers

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('Payload too large'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const raw = await readBody(req, 1_000_000);
  try {
    return raw.length ? JSON.parse(raw.toString('utf8')) : {};
  } catch {
    throw Object.assign(new Error('Invalid JSON'), { status: 400 });
  }
}

function reply(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function authorized(req) {
  const given = Buffer.from(String(req.headers['x-dashboard-key'] || ''));
  const expected = Buffer.from(config.dashboardKey);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

const validSession = (s) => /^[a-z0-9-]{4,40}$/i.test(s || '');

// ------------------------------------------------------------ public view (no phone numbers)

function requesterLabel(uid) {
  const [ch, id] = [uid.slice(0, uid.indexOf(':')), uid.slice(uid.indexOf(':') + 1)];
  if (ch === 'wa') return `WhatsApp ···${id.slice(-4)}`;
  if (ch === 'tg') return `Telegram ···${id.slice(-4)}`;
  return 'Simulator';
}

function publicState() {
  const s = store.state;
  const incidents = s.incidents.map((i) => ({
    id: i.id,
    createdAt: i.createdAt,
    updatedAt: i.updatedAt,
    status: i.status,
    requester: requesterLabel(i.requester),
    language: i.language,
    messages: i.messages,
    summary: i.summary,
    need: i.need,
    peopleCount: i.peopleCount,
    vulnerable: i.vulnerable,
    aiPriority: i.aiPriority,
    priorityReason: i.priorityReason,
    aiSource: i.aiSource,
    finalPriority: i.finalPriority,
    lat: i.lat,
    lng: i.lng,
    address: i.address,
    possibleDuplicateOf: i.possibleDuplicateOf,
    duplicateOf: i.duplicateOf,
    decidedBy: i.decidedBy || null,
    volunteerName: i.volunteerName || null,
    volunteerUid: i.volunteer && i.volunteer.startsWith('sim:') ? i.volunteer : null,
  }));
  const people = Object.values(s.users);
  return {
    incidents,
    volunteers: people
      .filter((u) => u.role === 'volunteer')
      .map((u) => ({ name: u.name, status: u.status, lat: u.lat, lng: u.lng, demo: u.uid.startsWith('sim:') })),
    coordinators: people.filter((u) => u.role === 'coordinator').map((u) => u.name),
    log: s.log.slice(-200).reverse(),
    config: {
      mapCenter: config.mapCenter,
      ai: !!config.ai.apiKey,
      whatsapp: !!(config.whatsapp.token && config.whatsapp.phoneNumberId),
      telegram: !!config.telegram.token,
    },
  };
}

// ------------------------------------------------------------ routes

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
    return reply(res, 200, fs.readFileSync(path.join(root, 'public', 'index.html')), 'text/html; charset=utf-8');
  }
  if (req.method === 'GET' && p === '/health') return reply(res, 200, { ok: true });
  if (req.method === 'GET' && p === '/api/state') return reply(res, 200, publicState());

  // --- WhatsApp Cloud API webhook
  if (p === '/webhook/whatsapp') {
    if (req.method === 'GET') {
      const ok = url.searchParams.get('hub.mode') === 'subscribe' && url.searchParams.get('hub.verify_token') === config.whatsapp.verifyToken;
      return ok ? reply(res, 200, url.searchParams.get('hub.challenge') || '', 'text/plain') : reply(res, 403, 'Forbidden', 'text/plain');
    }
    if (req.method === 'POST') {
      const raw = await readBody(req, 2_000_000);
      if (!verifyWhatsAppSignature(raw, req.headers['x-hub-signature-256'])) return reply(res, 401, { error: 'bad signature' });
      reply(res, 200, { ok: true }); // acknowledge fast; Meta retries slow webhooks
      let body;
      try {
        body = JSON.parse(raw.toString('utf8'));
      } catch {
        return;
      }
      for (const m of parseWhatsApp(body)) enqueue(() => core.handleInbound(m));
      return;
    }
  }

  // --- Telegram bot webhook (fallback channel)
  if (req.method === 'POST' && p === '/webhook/telegram') {
    if (config.telegram.secret && req.headers['x-telegram-bot-api-secret-token'] !== config.telegram.secret) return reply(res, 401, { error: 'bad secret' });
    const update = await readJson(req);
    reply(res, 200, { ok: true });
    const m = parseTelegram(update);
    if (m?.callbackId) answerTelegramCallback(m.callbackId);
    if (m) enqueue(() => core.handleInbound(m));
    return;
  }

  // --- Simulator: lets judges try ReliefLine from the browser, no phone needed
  const sim = p.match(/^\/api\/sim\/([^/]+)(\/message|\/voice)?$/);
  if (sim) {
    const session = sim[1];
    if (!validSession(session)) return reply(res, 400, { error: 'bad session' });
    const uid = `sim:${session}`;
    if (req.method === 'GET' && !sim[2]) {
      return reply(res, 200, { messages: store.state.outbox.filter((o) => o.to === uid).slice(-50) });
    }
    if (req.method === 'POST' && sim[2] === '/message') {
      const { text = '', lat, lng } = await readJson(req);
      const clean = String(text).slice(0, 1000).trim();
      const loc = Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : {};
      if (clean) await enqueue(() => core.handleInbound({ uid, type: 'text', text: clean, ...loc }));
      else if (loc.lat !== undefined) await enqueue(() => core.handleInbound({ uid, type: 'location', ...loc }));
      return reply(res, 200, { ok: true });
    }
    if (req.method === 'POST' && sim[2] === '/voice') {
      const buf = await readBody(req, 8_000_000);
      const mime = String(req.headers['content-type'] || 'audio/webm').split(';')[0];
      const ext = mime.includes('ogg') ? 'ogg' : mime.includes('mp4') ? 'mp4' : mime.includes('wav') ? 'wav' : 'webm';
      const lat = Number(url.searchParams.get('lat'));
      const lng = Number(url.searchParams.get('lng'));
      const loc = url.searchParams.has('lat') && Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : {};
      await enqueue(() => core.handleInbound({ uid, type: 'audio', media: { buf, mime, filename: `voice.${ext}` }, ...loc }));
      return reply(res, 200, { ok: true });
    }
  }

  // --- Coordinator dashboard actions (require the dashboard key)
  if (req.method === 'POST' && p.startsWith('/api/')) {
    if (!authorized(req)) return reply(res, 401, { ok: false, message: 'Wrong dashboard key.' });
    const body = await readJson(req);

    if (p === '/api/check-key') return reply(res, 200, { ok: true });

    if (p === '/api/action') {
      const actor = 'Dashboard coordinator';
      const result = await enqueue(async () => {
        const r = await core.decide(body.id, body.action, actor, { priority: body.priority, target: body.target, question: body.question?.slice(0, 500) });
        store.save();
        return r;
      });
      return reply(res, result.ok ? 200 : 409, result);
    }

    if (p === '/api/volunteer-action') {
      if (!String(body.uid || '').startsWith('sim:')) return reply(res, 400, { ok: false, message: 'Only demo volunteers can be driven from the dashboard.' });
      const result = await enqueue(async () => {
        const r = await core.volunteerAction(body.uid, body.action, body.id);
        store.save();
        return r;
      });
      return reply(res, result.ok ? 200 : 409, result);
    }

    if (p === '/api/reset') {
      await enqueue(() => {
        store.reset({ keepUsers: true });
        if (config.seedDemo) core.seedDemoVolunteers();
      });
      return reply(res, 200, { ok: true });
    }
  }

  return reply(res, 404, { error: 'not found' });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error('[http]', err);
    if (!res.headersSent) reply(res, err.status || 500, { error: err.status ? err.message : 'internal error' });
  });
});

server.listen(config.port, '0.0.0.0', () => {
  console.log(`ReliefLine listening on :${config.port}`);
  console.log(`  AI (${config.ai.provider}): ${config.ai.apiKey ? `on, ${config.ai.model}` : "OFF (keyword fallback)"} · WhatsApp: ${config.whatsapp.token ? 'on' : 'off'} · Telegram: ${config.telegram.token ? 'on' : 'off'}`);
  setTelegramWebhook();
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    store.flush();
    process.exit(0);
  });
}
