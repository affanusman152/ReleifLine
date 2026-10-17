import crypto from 'node:crypto';
import { config } from './config.js';

// User ids are channel-prefixed: "wa:923001234567", "tg:123456789", "sim:abc123".
export const channelOf = (uid) => uid.split(':')[0];

const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// ---------------------------------------------------------------- outbound

export function createSender(store) {
  return async function send(uid, text, opts = {}) {
    const options = opts.options || [];
    const s = store.state;
    s.outbox.push({ ts: Date.now(), to: uid, text, options, askLocation: !!opts.askLocation });
    if (s.outbox.length > 500) s.outbox.splice(0, s.outbox.length - 500);
    store.save();

    try {
      const ch = channelOf(uid);
      if (ch === 'wa') return await sendWhatsApp(uid.slice(3), text, options, opts.askLocation);
      if (ch === 'tg') return await sendTelegram(uid.slice(3), text, options, opts.askLocation);
      return true; // simulator: the outbox is the delivery
    } catch (err) {
      console.error(`[send] ${uid}: ${err.message}`);
      return false;
    }
  };
}

async function waPost(payload) {
  const { token, phoneNumberId, graphVersion } = config.whatsapp;
  if (!token || !phoneNumberId) throw new Error('WhatsApp not configured');
  const res = await fetch(`https://graph.facebook.com/${graphVersion}/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', ...payload }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`WhatsApp ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return true;
}

async function sendWhatsApp(to, text, options, askLocation) {
  const body = clip(text, 1024);
  if (options.length && options.length <= 3 && options.every((o) => o.title.length <= 20)) {
    return waPost({
      to,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: body },
        action: { buttons: options.map((o) => ({ type: 'reply', reply: { id: o.id, title: o.title } })) },
      },
    });
  }
  if (options.length) {
    return waPost({
      to,
      type: 'interactive',
      interactive: {
        type: 'list',
        body: { text: body },
        action: {
          button: 'Decide',
          sections: [
            {
              title: 'Actions',
              rows: options.slice(0, 10).map((o) => ({
                id: o.id,
                title: clip(o.title, 24),
                ...(o.desc ? { description: clip(o.desc, 72) } : {}),
              })),
            },
          ],
        },
      },
    });
  }
  if (askLocation) {
    try {
      return await waPost({
        to,
        type: 'interactive',
        interactive: { type: 'location_request_message', body: { text: body }, action: { name: 'send_location' } },
      });
    } catch (err) {
      console.warn(`[wa] location request failed, sending text: ${err.message}`);
    }
  }
  return waPost({ to, type: 'text', text: { body: clip(text, 4096), preview_url: false } });
}

async function tgCall(method, payload) {
  if (!config.telegram.token) throw new Error('Telegram not configured');
  const res = await fetch(`https://api.telegram.org/bot${config.telegram.token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Telegram ${method}: ${data.description}`);
  return data.result;
}

async function sendTelegram(chatId, text, options, askLocation) {
  let reply_markup;
  if (options.length) {
    reply_markup = { inline_keyboard: options.map((o) => [{ text: o.title, callback_data: o.id.slice(0, 64) }]) };
  } else if (askLocation) {
    reply_markup = {
      keyboard: [[{ text: '📍 Share my location', request_location: true }]],
      one_time_keyboard: true,
      resize_keyboard: true,
    };
  } else {
    reply_markup = { remove_keyboard: true };
  }
  await tgCall('sendMessage', { chat_id: chatId, text: clip(text, 4096), reply_markup, disable_web_page_preview: true });
  return true;
}

export async function setTelegramWebhook() {
  if (!config.telegram.token || !config.publicUrl) return;
  try {
    await tgCall('setWebhook', {
      url: `${config.publicUrl}/webhook/telegram`,
      allowed_updates: ['message', 'callback_query'],
      ...(config.telegram.secret ? { secret_token: config.telegram.secret } : {}),
    });
    console.log('[tg] webhook set');
  } catch (err) {
    console.error(`[tg] could not set webhook: ${err.message}`);
  }
}

export async function answerTelegramCallback(id) {
  try {
    await tgCall('answerCallbackQuery', { callback_query_id: id });
  } catch {
    /* cosmetic only */
  }
}

// ---------------------------------------------------------------- inbound
// Every channel is normalized to:
// { uid, msgId, name, type: 'text'|'audio'|'image'|'location'|'action'|'other', text, actionId, lat, lng, locName, media }

export function verifyWhatsAppSignature(rawBody, header) {
  if (!config.whatsapp.appSecret) return true;
  if (!header) return false;
  const expected = `sha256=${crypto.createHmac('sha256', config.whatsapp.appSecret).update(rawBody).digest('hex')}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(header);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function parseWhatsApp(body) {
  const out = [];
  for (const entry of body?.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      const names = Object.fromEntries((value.contacts || []).map((c) => [c.wa_id, c.profile?.name]));
      for (const m of value.messages || []) {
        const base = { uid: `wa:${m.from}`, msgId: m.id, name: names[m.from] || null };
        if (m.type === 'text') out.push({ ...base, type: 'text', text: m.text?.body || '' });
        else if (m.type === 'audio' || m.type === 'voice')
          out.push({ ...base, type: 'audio', media: { kind: 'wa', id: (m.audio || m.voice).id, mime: (m.audio || m.voice).mime_type } });
        else if (m.type === 'image')
          out.push({ ...base, type: 'image', text: m.image?.caption || '', media: { kind: 'wa', id: m.image.id, mime: m.image.mime_type } });
        else if (m.type === 'location')
          out.push({
            ...base,
            type: 'location',
            lat: Number(m.location.latitude),
            lng: Number(m.location.longitude),
            locName: [m.location.name, m.location.address].filter(Boolean).join(', ') || null,
          });
        else if (m.type === 'interactive') {
          const reply = m.interactive?.button_reply || m.interactive?.list_reply;
          if (reply) out.push({ ...base, type: 'action', actionId: reply.id });
        } else if (m.type === 'button') out.push({ ...base, type: 'text', text: m.button?.text || '' });
        else out.push({ ...base, type: 'other' });
      }
    }
  }
  return out;
}

export function parseTelegram(update) {
  if (update?.callback_query) {
    const cq = update.callback_query;
    return {
      uid: `tg:${cq.message?.chat?.id ?? cq.from.id}`,
      msgId: `tgcb:${cq.id}`,
      name: cq.from?.first_name || null,
      type: 'action',
      actionId: cq.data,
      callbackId: cq.id,
    };
  }
  const m = update?.message;
  if (!m) return null;
  const base = { uid: `tg:${m.chat.id}`, msgId: `tg:${m.chat.id}:${m.message_id}`, name: m.from?.first_name || null };
  if (m.location) return { ...base, type: 'location', lat: m.location.latitude, lng: m.location.longitude, locName: m.venue?.title || null };
  if (m.voice || m.audio) {
    const a = m.voice || m.audio;
    return { ...base, type: 'audio', text: m.caption || '', media: { kind: 'tg', id: a.file_id, mime: a.mime_type || 'audio/ogg' } };
  }
  if (m.photo) return { ...base, type: 'image', text: m.caption || '', media: { kind: 'tg', id: m.photo.at(-1).file_id, mime: 'image/jpeg' } };
  if (typeof m.text === 'string') return { ...base, type: 'text', text: m.text.replace(/^\/start\b/, '').trim() || m.text };
  return { ...base, type: 'other' };
}

// Downloads media for an inbound message. Returns { buf, mime, filename }.
export async function fetchMedia(media) {
  if (media.buf) return media; // simulator uploads arrive with bytes attached
  const mime = (media.mime || 'audio/ogg').split(';')[0].trim();
  const ext = mime.includes('ogg') || mime.includes('opus') ? 'ogg' : mime.split('/')[1] || 'bin';

  if (media.kind === 'wa') {
    const { token, graphVersion } = config.whatsapp;
    const auth = { Authorization: `Bearer ${token}` };
    const meta = await fetch(`https://graph.facebook.com/${graphVersion}/${media.id}`, { headers: auth, signal: AbortSignal.timeout(10000) });
    if (!meta.ok) throw new Error(`WhatsApp media lookup ${meta.status}`);
    const { url } = await meta.json();
    const file = await fetch(url, { headers: auth, signal: AbortSignal.timeout(20000) });
    if (!file.ok) throw new Error(`WhatsApp media download ${file.status}`);
    return { buf: Buffer.from(await file.arrayBuffer()), mime, filename: `media.${ext}` };
  }
  if (media.kind === 'tg') {
    const { file_path } = await tgCall('getFile', { file_id: media.id });
    const file = await fetch(`https://api.telegram.org/file/bot${config.telegram.token}/${file_path}`, { signal: AbortSignal.timeout(20000) });
    if (!file.ok) throw new Error(`Telegram media download ${file.status}`);
    // Telegram voice notes are .oga; Whisper wants a known extension.
    return { buf: Buffer.from(await file.arrayBuffer()), mime, filename: `media.${ext === 'oga' ? 'ogg' : ext}` };
  }
  throw new Error('Unknown media source');
}
