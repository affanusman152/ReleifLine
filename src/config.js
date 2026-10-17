const env = process.env;

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  port: num(env.PORT, 8000),
  publicUrl: (env.PUBLIC_URL || '').replace(/\/+$/, ''),
  dataDir: env.DATA_DIR || './data',

  // Dashboard actions (dispatch, reset, ...) require this key. Share a demo key with judges.
  dashboardKey: env.DASHBOARD_KEY || 'demo',
  // Phones become coordinators by sending "COORDINATOR <code>".
  coordinatorCode: env.COORDINATOR_CODE || 'rescue',

  groq: {
    apiKey: env.GROQ_API_KEY || '',
    model: env.GROQ_MODEL || 'llama-3.3-70b-versatile',
    fallbackModel: env.GROQ_FALLBACK_MODEL || 'llama-3.1-8b-instant',
    whisperModel: env.GROQ_WHISPER_MODEL || 'whisper-large-v3-turbo',
  },

  whatsapp: {
    token: env.WHATSAPP_TOKEN || '',
    phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID || '',
    verifyToken: env.WHATSAPP_VERIFY_TOKEN || 'reliefline-verify',
    appSecret: env.WHATSAPP_APP_SECRET || '',
    graphVersion: env.WHATSAPP_GRAPH_VERSION || 'v23.0',
  },

  telegram: {
    token: env.TELEGRAM_BOT_TOKEN || '',
    secret: env.TELEGRAM_WEBHOOK_SECRET || '',
  },

  // Default map centre: Multan, Pakistan. Override for any city.
  mapCenter: [num(env.MAP_CENTER_LAT, 30.1575), num(env.MAP_CENTER_LNG, 71.5249)],
  seedDemo: env.SEED_DEMO !== '0',

  duplicateRadiusM: num(env.DUPLICATE_RADIUS_M, 300),
  duplicateWindowMs: 6 * 60 * 60 * 1000,
  followUpWindowMs: 2 * 60 * 60 * 1000,
};
