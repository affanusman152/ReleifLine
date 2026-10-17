import fs from 'node:fs';
import path from 'node:path';

function emptyState() {
  return {
    nextId: 1,
    incidents: [],
    users: {}, // uid -> { uid, role: 'coordinator' | 'volunteer', name, status, lat, lng }
    log: [], // audit trail: every AI suggestion and every human decision
    outbox: [], // every outbound message (the simulator reads its replies from here)
    pending: {}, // uid -> { kind, incidentId } for multi-step conversations
    seen: {}, // processed inbound message ids (WhatsApp retries webhooks)
  };
}

// In-memory state persisted to a JSON file. Plenty for a response desk at demo scale.
export function createStore(file) {
  let state = emptyState();
  if (file && fs.existsSync(file)) {
    try {
      state = { ...emptyState(), ...JSON.parse(fs.readFileSync(file, 'utf8')) };
    } catch (err) {
      console.error('Could not read saved state, starting fresh:', err.message);
    }
  }

  let timer = null;
  function flush() {
    timer = null;
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state));
      fs.renameSync(tmp, file);
    } catch (err) {
      console.error('Could not save state:', err.message);
    }
  }

  return {
    get state() {
      return state;
    },
    save() {
      if (!timer) timer = setTimeout(flush, 300);
    },
    flush,
    reset({ keepUsers = true } = {}) {
      const users = keepUsers ? state.users : {};
      state = { ...emptyState(), users };
      for (const u of Object.values(users)) {
        if (u.role === 'volunteer') u.status = 'available';
      }
      flush();
    },
  };
}
