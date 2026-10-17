import { distanceM, formatDistance, hasCoords, mapsLink } from './geo.js';
import { heuristicExtract, normalizeExtraction } from './ai.js';
import { channelOf } from './channels.js';

// Lifecycle: new → (human) → waiting | dispatched → accepted → resolved; or merged / rejected.
export const OPEN = ['new', 'waiting', 'dispatched', 'accepted'];
const NEED_LABEL = { rescue: 'RESCUE', medical: 'MEDICAL', food_water: 'FOOD / WATER', shelter: 'SHELTER', info: 'INFO', other: 'OTHER' };
const PRIORITY_DESC = { P1: 'Immediate danger to life', P2: 'Urgent, within hours', P3: 'Non-urgent / information' };

export function createCore({ store, ai, send, fetchMedia, geocode, config, now = () => Date.now() }) {
  const S = () => store.state;
  const translations = new Map();
  const dashboardUrl = () => (config.publicUrl ? `${config.publicUrl}/` : 'the ReliefLine dashboard');

  // ------------------------------------------------------------ helpers

  function log(incidentId, actor, action, detail = '') {
    S().log.push({ ts: now(), incidentId, actor, action, detail });
    if (S().log.length > 3000) S().log.splice(0, 500);
  }

  const findIncident = (id) => S().incidents.find((i) => i.id === Number(id));
  const users = () => Object.values(S().users);
  const coordinators = () => users().filter((u) => u.role === 'coordinator');
  const isSim = (uid) => channelOf(uid) === 'sim';

  async function localized(text, language) {
    if (!language || /^english$/i.test(language)) return text;
    const key = `${language}|${text}`;
    if (!translations.has(key)) translations.set(key, await ai.translate(text, language));
    return translations.get(key);
  }

  async function tellRequester(incident, text, opts) {
    return send(incident.requester, await localized(text, incident.language), opts);
  }

  async function broadcast(text, opts) {
    await Promise.all(coordinators().map((c) => send(c.uid, text, opts)));
  }

  async function safeExtract(text) {
    try {
      return await ai.extract(text);
    } catch {
      return normalizeExtraction(null, text);
    }
  }

  function applyExtraction(incident, ex, fallbackLanguage) {
    incident.language = ex.language && !/unknown/i.test(ex.language) ? ex.language : fallbackLanguage || incident.language || 'English';
    incident.summary = ex.english_summary;
    incident.need = ex.need;
    incident.peopleCount = ex.people_count ?? incident.peopleCount ?? null;
    incident.vulnerable = [...new Set([...(incident.vulnerable || []), ...ex.vulnerable])];
    incident.aiPriority = ex.suggested_priority;
    incident.priorityReason = ex.priority_reason;
    incident.missing = ex.missing_info;
    incident.address = incident.address || ex.address_text;
    incident.aiSource = ex.source;
  }

  async function locate(incident) {
    if (hasCoords(incident) || !incident.address) return;
    const hit = await geocode(incident.address);
    if (hit) {
      incident.lat = hit.lat;
      incident.lng = hit.lng;
      incident.geocoded = true;
      log(incident.id, 'ai', 'geocoded', `"${incident.address}" → ${hit.lat.toFixed(4)}, ${hit.lng.toFixed(4)}`);
    }
  }

  function checkDuplicate(incident) {
    incident.possibleDuplicateOf = null;
    if (!hasCoords(incident)) return;
    let best = null;
    for (const other of S().incidents) {
      if (other.id === incident.id || !OPEN.includes(other.status) || !hasCoords(other)) continue;
      if (Math.abs(incident.createdAt - other.createdAt) > config.duplicateWindowMs) continue;
      const d = distanceM(incident, other);
      if (d <= config.duplicateRadiusM && (!best || d < best.meters)) best = { id: other.id, meters: Math.round(d) };
    }
    if (best) {
      incident.possibleDuplicateOf = best;
      log(incident.id, 'ai', 'possible_duplicate', `#${best.id} is ${formatDistance(best.meters)} away`);
    }
  }

  function originalText(incident) {
    return incident.messages.map((m) => m.text).filter(Boolean).join(' / ');
  }

  function card(incident, heading = '🆘') {
    const lines = [
      `${heading} #${incident.id} · AI suggests ${incident.aiPriority} · ${NEED_LABEL[incident.need] || 'OTHER'}`,
      `"${incident.summary}"`,
    ];
    const original = originalText(incident);
    if (original && !/^english$/i.test(incident.language)) {
      lines.push(`🗣 ${incident.language}${incident.messages.some((m) => m.kind === 'voice') ? ' voice note' : ''}: "${original.slice(0, 160)}"`);
    }
    const who = [incident.peopleCount ? `👥 ${incident.peopleCount}` : null, incident.vulnerable?.length ? `⚠️ ${incident.vulnerable.join(', ')}` : null].filter(Boolean);
    if (who.length) lines.push(who.join(' · '));
    lines.push(hasCoords(incident) ? `📍 ${mapsLink(incident)}` : `📍 Location missing (asked the requester)${incident.address ? ` · mentioned: ${incident.address}` : ''}`);
    if (incident.possibleDuplicateOf) lines.push(`🔁 Possible duplicate of #${incident.possibleDuplicateOf.id} (${formatDistance(incident.possibleDuplicateOf.meters)} away)`);
    if (incident.priorityReason) lines.push(`Why ${incident.aiPriority}: ${incident.priorityReason}`);
    return lines.join('\n');
  }

  function decisionOptions(incident) {
    const options = ['P1', 'P2', 'P3'].map((p) => ({
      id: `dispatch|${p}|${incident.id}`,
      title: `✅ Dispatch as ${p}`,
      desc: `${PRIORITY_DESC[p]}${p === incident.aiPriority ? ' (AI suggestion)' : ''}`,
    }));
    if (incident.possibleDuplicateOf) {
      options.push({ id: `merge|${incident.id}|${incident.possibleDuplicateOf.id}`, title: `🔁 Merge into #${incident.possibleDuplicateOf.id}`, desc: 'Same emergency, already reported' });
    }
    options.push({ id: `ask|${incident.id}`, title: '❓ Ask for more info', desc: 'I will translate your question' });
    options.push({ id: `reject|${incident.id}`, title: '🚫 Not genuine', desc: 'Spam, test or false report' });
    return options;
  }

  async function sendCard(incident, heading) {
    await broadcast(card(incident, heading), { options: decisionOptions(incident) });
  }

  // ------------------------------------------------------------ inbound router

  async function handleInbound(m) {
    const s = S();
    if (m.msgId) {
      if (s.seen[m.msgId]) return;
      s.seen[m.msgId] = now();
      const ids = Object.keys(s.seen);
      if (ids.length > 2000) for (const id of ids.slice(0, 500)) delete s.seen[id];
    }
    try {
      await route(m);
    } finally {
      store.save();
    }
  }

  async function route(m) {
    const s = S();
    const text = (m.text || '').trim();
    const user = s.users[m.uid];

    const coord = text.match(/^\/?coordinator\b\s*(.*)$/i);
    if (coord && m.type === 'text') {
      if (coord[1].trim() === config.coordinatorCode) {
        s.users[m.uid] = { uid: m.uid, role: 'coordinator', name: m.name || `Coordinator ${m.uid.slice(-4)}`, joinedAt: now() };
        delete s.pending[m.uid];
        log(null, s.users[m.uid].name, 'coordinator_joined');
        await send(m.uid, `✅ You are now a ReliefLine coordinator.\nNew help requests will arrive here as cards. Tap "Decide" to verify and dispatch.\nLive map: ${dashboardUrl()}`);
      } else {
        await send(m.uid, '❌ Wrong coordinator code.');
      }
      return;
    }

    const vol = text.match(/^\/?volunteer\b\s*(.*)$/i);
    if (vol && m.type === 'text') {
      const name = vol[1].trim().slice(0, 40) || m.name || `Volunteer ${m.uid.slice(-4)}`;
      s.users[m.uid] = { uid: m.uid, role: 'volunteer', name, status: 'available', lat: user?.lat ?? null, lng: user?.lng ?? null, joinedAt: now() };
      s.pending[m.uid] = { kind: 'volunteer_location' };
      log(null, name, 'volunteer_joined');
      await send(m.uid, `🙌 Thank you, ${name}! You're registered as a volunteer.\n📍 Please share your current location so we can send you requests near you.\n(Send LEAVE to stop.)`, { askLocation: true });
      return;
    }

    if (user && /^\/?(leave|stop)$/i.test(text)) {
      delete s.users[m.uid];
      delete s.pending[m.uid];
      log(null, user.name, `${user.role}_left`);
      await send(m.uid, 'You have left ReliefLine. Thank you for helping. 🙏');
      return;
    }

    if (user?.role === 'volunteer') return volunteerMessage(m, user);
    if (user?.role === 'coordinator') return coordinatorMessage(m, user);
    return intake(m);
  }

  // ------------------------------------------------------------ requester intake

  async function intake(m) {
    const s = S();
    let text = (m.text || '').trim();
    let heardLanguage = null;
    let kind = m.type === 'audio' ? 'voice' : m.type;

    if (/^\/?start$/i.test(text)) text = '';

    if (m.type === 'audio') {
      try {
        const media = await fetchMedia(m.media);
        const heard = await ai.transcribe(media.buf, media.filename, media.mime);
        text = [heard.text, text].filter(Boolean).join(' ');
        heardLanguage = heard.language;
      } catch (err) {
        console.warn(`[intake] transcription failed: ${err.message}`);
        kind = 'voice (could not transcribe)';
      }
    }

    const isLocation = m.type === 'location';
    const open = s.incidents
      .filter((i) => i.requester === m.uid && OPEN.includes(i.status) && now() - i.updatedAt < config.followUpWindowMs)
      .at(-1);

    if (open) return followUp(open, m, text, kind, heardLanguage);

    if (!text && !isLocation && m.type !== 'audio' && m.type !== 'image') {
      await send(m.uid, welcomeText());
      return;
    }

    let ex;
    if (text) ex = await safeExtract(text);
    else if (m.type === 'audio')
      ex = { ...heuristicExtract(''), is_help_request: true, english_summary: 'Voice note received but could not be transcribed. Listen to it manually.', suggested_priority: 'P2', priority_reason: 'Unknown content, treat as urgent', source: 'rules' };
    else
      ex = { ...heuristicExtract(''), is_help_request: true, english_summary: isLocation ? 'Shared a location without details yet.' : 'Sent a photo without details yet.', suggested_priority: 'P2', priority_reason: 'No details yet, treat as urgent', missing_info: ['details'], source: 'rules' };

    if (ex.is_help_request === false && !isLocation && m.type !== 'audio' && m.type !== 'image') {
      await send(m.uid, await localized(welcomeText(), ex.language));
      return;
    }

    const incident = {
      id: s.nextId++,
      createdAt: now(),
      updatedAt: now(),
      requester: m.uid,
      requesterName: m.name || null,
      channel: channelOf(m.uid),
      messages: [{ ts: now(), kind, text }],
      status: 'new',
      finalPriority: null,
      lat: hasCoords(m) ? m.lat : null,
      lng: hasCoords(m) ? m.lng : null,
      address: m.locName || null,
      volunteer: null,
      declined: [],
      duplicateOf: null,
      possibleDuplicateOf: null,
    };
    applyExtraction(incident, ex, heardLanguage);
    s.incidents.push(incident);
    log(incident.id, 'requester', 'received', `${kind}${heardLanguage ? ` (${heardLanguage})` : ''}`);
    log(incident.id, 'ai', 'triaged', `${NEED_LABEL[incident.need]} · suggested ${incident.aiPriority}: ${incident.priorityReason}${incident.aiSource === 'rules' ? ' [fallback rules]' : ''}`);

    await locate(incident);
    checkDuplicate(incident);

    await tellRequester(
      incident,
      `🆘 We received your request (#${incident.id}). A volunteer coordinator is reviewing it now. Stay safe and keep your phone on.${hasCoords(incident) ? '' : '\n📍 Please share your location so help can find you.'}`,
      { askLocation: !hasCoords(incident) },
    );
    await sendCard(incident);
  }

  async function followUp(incident, m, text, kind, heardLanguage) {
    incident.updatedAt = now();
    const changes = [];
    if (hasCoords(m)) {
      incident.lat = m.lat;
      incident.lng = m.lng;
      incident.address = incident.address || m.locName;
      changes.push('location shared');
      log(incident.id, 'requester', 'location_added', `${m.lat.toFixed(4)}, ${m.lng.toFixed(4)}`);
    }
    if (text || m.type === 'audio' || m.type === 'image') {
      incident.messages.push({ ts: now(), kind, text });
      if (text) {
        const ex = await safeExtract(originalText(incident));
        const before = incident.aiPriority;
        applyExtraction(incident, ex, heardLanguage);
        changes.push(`new ${kind}`);
        log(incident.id, 'ai', 'retriaged', `suggested ${incident.aiPriority}${before !== incident.aiPriority ? ` (was ${before})` : ''}: ${incident.priorityReason}`);
      } else {
        changes.push(`new ${kind}`);
      }
    }
    await locate(incident);
    if (incident.status === 'new') checkDuplicate(incident);

    await tellRequester(
      incident,
      `✅ Added to your request #${incident.id}.${hasCoords(incident) ? '' : '\n📍 Please share your location so help can find you.'}`,
      { askLocation: !hasCoords(incident) },
    );

    if (incident.status === 'new') {
      await sendCard(incident, `🔄 UPDATED (${changes.join(', ')})`);
    } else {
      await broadcast(`ℹ️ Update on #${incident.id} (${changes.join(', ')}): "${incident.summary}"${hasCoords(incident) ? `\n📍 ${mapsLink(incident)}` : ''}`);
      if (incident.volunteer && ['dispatched', 'accepted'].includes(incident.status)) {
        await send(incident.volunteer, `ℹ️ Update on task #${incident.id}: "${incident.summary}"${hasCoords(incident) ? `\n📍 ${mapsLink(incident)}` : ''}`);
      }
    }
  }

  function welcomeText() {
    return '👋 This is ReliefLine, an emergency help line run by volunteer coordinators.\nIf you or someone near you needs help, send a voice note or a message describing what is happening, and share your 📍 location.\nIn immediate danger, also call your local emergency number.';
  }

  // ------------------------------------------------------------ coordinator (human in the loop)

  async function coordinatorMessage(m, user) {
    const s = S();
    if (m.type === 'action') {
      const [action, a, b] = m.actionId.split('|');
      let result;
      if (action === 'dispatch') result = await decide(b, 'dispatch', user.name, { priority: a, uid: m.uid });
      else if (action === 'merge') result = await decide(a, 'merge', user.name, { target: b, uid: m.uid });
      else if (action === 'ask') result = await decide(a, 'ask', user.name, { uid: m.uid });
      else if (action === 'reject') result = await decide(a, 'reject', user.name, { uid: m.uid });
      else result = { ok: false, message: 'Unknown action.' };
      if (!result.ok || result.privateMessage) await send(m.uid, result.privateMessage || result.message);
      return;
    }
    const pending = s.pending[m.uid];
    if (pending?.kind === 'ask' && m.type === 'text' && m.text.trim()) {
      delete s.pending[m.uid];
      const result = await decide(pending.incidentId, 'ask', user.name, { question: m.text.trim() });
      await send(m.uid, result.message);
      return;
    }
    const open = S().incidents.filter((i) => i.status === 'new' || i.status === 'waiting');
    await send(
      m.uid,
      `You are a coordinator (${user.name}). Open requests waiting for a decision: ${open.length ? open.map((i) => `#${i.id} (${i.aiPriority})`).join(', ') : 'none'}.\nTap "Decide" on a request card. Live map: ${dashboardUrl()}\nSend LEAVE to stop receiving requests.`,
    );
  }

  // Single entry point for every human decision (WhatsApp, Telegram or dashboard).
  async function decide(id, action, actor, extra = {}) {
    const incident = findIncident(id);
    if (!incident) return { ok: false, message: `Request #${id} not found.` };

    if (action === 'ask') {
      if (!OPEN.includes(incident.status)) return { ok: false, message: `#${id} is already ${incident.status}.` };
      if (!extra.question) {
        if (!extra.uid) return { ok: false, message: 'Question is empty.' };
        S().pending[extra.uid] = { kind: 'ask', incidentId: incident.id };
        return { ok: true, privateMessage: `✍️ Type your question for requester #${id}. I'll translate it into ${incident.language}.` };
      }
      await tellRequester(incident, `❓ Question from the ReliefLine coordinator about request #${incident.id}: ${extra.question}`);
      log(incident.id, actor, 'asked_requester', extra.question);
      return { ok: true, message: `📨 Sent to requester #${id}${/^english$/i.test(incident.language) ? '' : ` in ${incident.language}`}.` };
    }

    if (action === 'reoffer') {
      // Volunteer is not answering: free them and offer the task to the next nearest one.
      if (incident.status !== 'dispatched') return { ok: false, message: `#${id} is ${incident.status}, nothing to re-offer.` };
      const v = S().users[incident.volunteer];
      if (v) v.status = 'available';
      incident.declined.push(incident.volunteer);
      log(incident.id, actor, 'reoffered', `${incident.volunteerName || 'Volunteer'} did not respond`);
      incident.volunteer = null;
      incident.volunteerName = null;
      const next = await assignVolunteer(incident);
      return { ok: true, message: next ? `#${id} re-offered to ${next.name}.` : `#${id} waiting for a volunteer.` };
    }

    if (!['new', 'waiting'].includes(incident.status) || (action !== 'dispatch' && incident.status !== 'new')) {
      return { ok: false, message: `#${id} was already handled (${incident.status}${incident.decidedBy ? ` by ${incident.decidedBy}` : ''}).` };
    }

    if (action === 'dispatch') {
      const p = ['P1', 'P2', 'P3'].includes(extra.priority) ? extra.priority : incident.aiPriority;
      const firstDecision = incident.status === 'new';
      incident.finalPriority = p;
      incident.decidedBy = actor;
      incident.decidedAt = now();
      incident.updatedAt = now();
      if (p !== incident.aiPriority) log(incident.id, actor, 'priority_override', `AI suggested ${incident.aiPriority} → human set ${p}`);
      log(incident.id, actor, 'verified', `Verified as ${p}`);
      if (firstDecision) {
        await tellRequester(incident, `✅ Your request #${incident.id} has been verified by a coordinator. We are contacting a volunteer near you now.`);
      }
      const assigned = await assignVolunteer(incident);
      return { ok: true, message: assigned ? `#${id} dispatched to ${assigned.name}.` : `#${id} verified; waiting for a volunteer.` };
    }

    if (action === 'merge') {
      const target = findIncident(extra.target);
      if (!target || target.id === incident.id) return { ok: false, message: `Cannot merge #${id} into #${extra.target}.` };
      incident.status = 'merged';
      incident.duplicateOf = target.id;
      incident.decidedBy = actor;
      incident.updatedAt = now();
      target.messages.push({ ts: now(), kind: `merged from #${incident.id}`, text: incident.summary });
      target.peopleCount = Math.max(target.peopleCount || 0, incident.peopleCount || 0) || null;
      target.updatedAt = now();
      log(incident.id, actor, 'merged', `Same emergency as #${target.id}`);
      await tellRequester(incident, `🔁 Your report has been linked to an existing rescue request (#${target.id}) for the same location. Help is being coordinated.`);
      await broadcast(`🔁 #${incident.id} merged into #${target.id} by ${actor}.`);
      if (target.volunteer && ['dispatched', 'accepted'].includes(target.status)) {
        await send(target.volunteer, `ℹ️ Another report for task #${target.id}: "${incident.summary}"`);
      }
      return { ok: true, message: `#${id} merged into #${target.id}.` };
    }

    if (action === 'reject') {
      incident.status = 'rejected';
      incident.decidedBy = actor;
      incident.updatedAt = now();
      log(incident.id, actor, 'rejected', 'Marked not genuine');
      await tellRequester(incident, 'Your message has been reviewed by a coordinator. If you are in danger, describe what is happening and share your 📍 location, or call your local emergency number.');
      await broadcast(`🚫 #${incident.id} marked not genuine by ${actor}.`);
      return { ok: true, message: `#${id} rejected.` };
    }

    return { ok: false, message: 'Unknown action.' };
  }

  // Offers the incident to the nearest available volunteer. Real phones serve real requests first;
  // seeded simulator volunteers serve simulator requests first.
  async function assignVolunteer(incident) {
    const candidates = users().filter((u) => u.role === 'volunteer' && u.status === 'available' && !incident.declined.includes(u.uid));
    if (!candidates.length) {
      incident.status = 'waiting';
      incident.volunteer = null;
      log(incident.id, 'system', 'no_volunteer', 'Waiting for an available volunteer');
      await broadcast(`⚠️ #${incident.id} (${incident.finalPriority}) is verified but no volunteer is available. It will go to the next volunteer who becomes available.`);
      return null;
    }
    const sameWorld = (u) => (isSim(u.uid) === isSim(incident.requester) ? 0 : 1);
    const dist = (u) => (hasCoords(incident) && hasCoords(u) ? distanceM(incident, u) : Infinity);
    candidates.sort((a, b) => sameWorld(a) - sameWorld(b) || dist(a) - dist(b));
    const v = candidates[0];
    const d = dist(v);

    incident.status = 'dispatched';
    incident.volunteer = v.uid;
    incident.volunteerName = v.name;
    incident.updatedAt = now();
    v.status = 'busy';
    log(incident.id, 'system', 'offered', `Offered to ${v.name}${Number.isFinite(d) ? ` (${formatDistance(d)} away)` : ''}`);

    const who = [incident.peopleCount ? `👥 ${incident.peopleCount}` : null, incident.vulnerable?.length ? `⚠️ ${incident.vulnerable.join(', ')}` : null].filter(Boolean);
    await send(
      v.uid,
      [
        `🚨 TASK #${incident.id} · ${incident.finalPriority} · ${NEED_LABEL[incident.need] || 'OTHER'}`,
        `"${incident.summary}"`,
        who.join(' · '),
        hasCoords(incident) ? `📍 ${mapsLink(incident)}${Number.isFinite(d) ? ` (${formatDistance(d)} from you)` : ''}` : '📍 Location not shared yet',
        'Can you go?',
      ].filter(Boolean).join('\n'),
      { options: [{ id: `accept|${incident.id}`, title: '✅ Accept' }, { id: `decline|${incident.id}`, title: "❌ Can't go" }] },
    );
    await broadcast(`📤 #${incident.id} (${incident.finalPriority}) offered to ${v.name}${Number.isFinite(d) ? `, ${formatDistance(d)} away` : ''}.`);
    return v;
  }

  async function offerWaiting() {
    const rank = { P1: 0, P2: 1, P3: 2 };
    const waiting = S().incidents.filter((i) => i.status === 'waiting').sort((a, b) => rank[a.finalPriority] - rank[b.finalPriority] || a.createdAt - b.createdAt);
    for (const incident of waiting) {
      if (!users().some((u) => u.role === 'volunteer' && u.status === 'available' && !incident.declined.includes(u.uid))) continue;
      await assignVolunteer(incident);
    }
  }

  // ------------------------------------------------------------ volunteers

  async function volunteerMessage(m, v) {
    const s = S();
    if (m.type === 'location') {
      v.lat = m.lat;
      v.lng = m.lng;
      delete s.pending[m.uid];
      log(null, v.name, 'volunteer_location', `${m.lat.toFixed(4)}, ${m.lng.toFixed(4)}`);
      await send(m.uid, `📍 Location saved. You are ${v.status === 'available' ? 'available for tasks' : 'on a task'}.`);
      await offerWaiting();
      return;
    }
    if (m.type === 'action') {
      const [action, id] = m.actionId.split('|');
      const result = await volunteerAction(m.uid, action, id);
      if (!result.ok) await send(m.uid, result.message);
      return;
    }
    const text = (m.text || '').trim();
    if (/^available$/i.test(text) && v.status !== 'busy') {
      v.status = 'available';
      await send(m.uid, '✅ You are available for tasks.');
      await offerWaiting();
      return;
    }
    if (/^(busy|away)$/i.test(text) && v.status === 'available') {
      v.status = 'away';
      await send(m.uid, '⏸ You will not receive tasks. Send AVAILABLE when you are ready again.');
      return;
    }
    await send(m.uid, `You are a volunteer (${v.name}, ${v.status}).\n📍 Share your location to update it · AVAILABLE / BUSY · LEAVE to stop.`, { askLocation: !hasCoords(v) });
  }

  async function volunteerAction(uid, action, id) {
    const incident = findIncident(id);
    const v = S().users[uid];
    if (!incident || !v || incident.volunteer !== uid) return { ok: false, message: 'This task is no longer assigned to you.' };

    if (action === 'accept') {
      if (incident.status !== 'dispatched') return { ok: false, message: `Task #${id} is already ${incident.status}.` };
      incident.status = 'accepted';
      incident.acceptedAt = now();
      incident.updatedAt = now();
      log(incident.id, v.name, 'accepted', 'Volunteer on the way');
      await send(uid, `👍 Thank you! Task #${incident.id}${hasCoords(incident) ? `\nNavigate: ${mapsLink(incident)}` : ''}\nTap Done when the people are safe.`, {
        options: [{ id: `done|${incident.id}`, title: '✅ Done, all safe' }],
      });
      await tellRequester(incident, `🚑 Help is on the way. Volunteer ${v.name} has accepted your request #${incident.id} and is heading to you. Stay where you are if it is safe.`);
      await broadcast(`🚑 #${incident.id} accepted by ${v.name}.`);
      return { ok: true, message: 'Accepted.' };
    }

    if (action === 'decline') {
      if (incident.status !== 'dispatched') return { ok: false, message: `Task #${id} is already ${incident.status}.` };
      incident.declined.push(uid);
      incident.volunteer = null;
      incident.volunteerName = null;
      v.status = 'available';
      log(incident.id, v.name, 'declined');
      await send(uid, 'No problem, we will ask someone else.');
      await assignVolunteer(incident);
      return { ok: true, message: 'Declined.' };
    }

    if (action === 'done') {
      if (incident.status !== 'accepted') return { ok: false, message: `Task #${id} is ${incident.status}.` };
      incident.status = 'resolved';
      incident.resolvedAt = now();
      incident.updatedAt = now();
      v.status = 'available';
      log(incident.id, v.name, 'resolved', 'People reported safe');
      await send(uid, `🙏 Task #${incident.id} marked as resolved. You are available for new tasks.`);
      await tellRequester(incident, `✅ Your request #${incident.id} has been marked resolved by the volunteer. If you still need help, send a new message.`);
      await broadcast(`✅ #${incident.id} resolved by ${v.name}.`);
      await offerWaiting();
      return { ok: true, message: 'Resolved.' };
    }

    return { ok: false, message: 'Unknown action.' };
  }

  // ------------------------------------------------------------ demo seed

  function seedDemoVolunteers() {
    const s = S();
    if (users().some((u) => isSim(u.uid) && u.role === 'volunteer')) return;
    const [lat, lng] = config.mapCenter;
    const seeds = [
      ['sim:vol-ahmed', 'Ahmed (demo)', 0.012, 0.015],
      ['sim:vol-sara', 'Sara (demo)', -0.018, -0.006],
      ['sim:vol-bilal', 'Bilal (demo)', 0.004, -0.022],
    ];
    for (const [uid, name, dLat, dLng] of seeds) {
      s.users[uid] = { uid, role: 'volunteer', name, status: 'available', lat: lat + dLat, lng: lng + dLng, joinedAt: now() };
    }
    store.save();
  }

  return { handleInbound, decide, volunteerAction, offerWaiting, seedDemoVolunteers, card };
}
