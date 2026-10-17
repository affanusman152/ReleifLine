const env = process.env;

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

const useOpenAI = !env.GROQ_API_KEY && !!env.OPENAI_API_KEY;

export const config = {
  port: num(env.PORT, 3000),
  publicUrl: (env.PUBLIC_URL || '').replace(/\/+$/, ''),
  dataDir: env.DATA_DIR || './data',

  // Dashboard actions (dispatch, reset, ...) require this key. Share a demo key with judges.
  dashboardKey: env.DASHBOARD_KEY || 'demo',
  // Phones become coordinators by sending "COORDINATOR <code>".
  coordinatorCode: env.COORDINATOR_CODE || 'rescue',

  // Any OpenAI-compatible provider. Groq is used if GROQ_API_KEY is set, otherwise OpenAI.
  ai: {
    provider: env.AI_BASE_URL ? 'Custom' : useOpenAI ? 'OpenAI' : 'Groq',
    apiKey: env.AI_API_KEY || env.GROQ_API_KEY || env.OPENAI_API_KEY || '',
    baseUrl: (env.AI_BASE_URL || (useOpenAI ? 'https://api.openai.com/v1' : 'https://api.groq.com/openai/v1')).replace(/\/+$/, ''),
    model: env.AI_MODEL || env.GROQ_MODEL || (useOpenAI ? 'gpt-4.1-mini' : 'openai/gpt-oss-120b'),
    fallbackModel: env.AI_FALLBACK_MODEL || env.GROQ_FALLBACK_MODEL || (useOpenAI ? 'gpt-4o-mini' : 'openai/gpt-oss-20b'),
    whisperModel: env.AI_WHISPER_MODEL || env.GROQ_WHISPER_MODEL || (useOpenAI ? 'whisper-1' : 'whisper-large-v3-turbo'),
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
