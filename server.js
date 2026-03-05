const http = require('http');
const https = require('https');
const crypto = require('crypto');

const PORT = process.env.PORT || 8080;
const MAX_BODY_SIZE = 1024 * 1024;

// ========== Multi-bot configuration ==========
// BOTS env var: JSON array of bot configs, e.g.:
// [
//   {
//     "id": "bot1",
//     "seatalk_app_id": "...",
//     "seatalk_app_secret": "...",
//     "openclaw_url": "https://openclaw-1.up.railway.app",
//     "setup_password": "password1"
//   },
//   { "id": "bot2", ... }
// ]
//
// Legacy single-bot env vars are also supported for backwards compatibility.

function loadBots() {
  if (process.env.BOTS) {
    try {
      const bots = JSON.parse(process.env.BOTS);
      if (!Array.isArray(bots) || bots.length === 0) throw new Error('BOTS must be a non-empty array');
      for (const b of bots) {
        if (!b.id || !b.seatalk_app_id || !b.seatalk_app_secret) {
          throw new Error(`Bot "${b.id || '?'}": id, seatalk_app_id, seatalk_app_secret are required`);
        }
      }
      return bots;
    } catch (e) {
      console.error(`Invalid BOTS config: ${e.message}`);
      process.exit(1);
    }
  }

  // Legacy single-bot mode
  const APP_ID = process.env.SEATALK_APP_ID;
  const APP_SECRET = process.env.SEATALK_APP_SECRET;
  if (!APP_ID || !APP_SECRET) {
    console.error('Missing BOTS or SEATALK_APP_ID/SEATALK_APP_SECRET');
    process.exit(1);
  }
  return [{
    id: 'default',
    seatalk_app_id: APP_ID,
    seatalk_app_secret: APP_SECRET,
    openclaw_url: process.env.OPENCLAW_GATEWAY_URL || '',
    setup_password: process.env.SETUP_PASSWORD || '',
    openclaw_api_key: process.env.OPENCLAW_API_KEY || '',
  }];
}

const BOTS = loadBots();

// Per-bot runtime state
const botState = new Map();
for (const bot of BOTS) {
  botState.set(bot.id, {
    accessToken: null,
    tokenExpiry: 0,
    messageQueue: [],
    lastMessageId: 0,
  });
}

// Index bots by app_id for webhook routing
const botByAppId = new Map();
for (const bot of BOTS) {
  botByAppId.set(bot.seatalk_app_id, bot);
}

console.log(`SeaTalk Bot starting on port ${PORT}...`);
console.log(`Configured ${BOTS.length} bot(s):`);
for (const bot of BOTS) {
  const mode = bot.openclaw_url ? 'BRIDGE' : 'QUEUE';
  console.log(`  [${bot.id}] ${mode} → ${bot.openclaw_url || '(passive)'}`);
  console.log(`    callback: /bot/${bot.id}/callback  (also auto-routed by app_id)`);
}

// ========== Helpers ==========

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > MAX_BODY_SIZE) { req.destroy(); reject(new Error('Request body too large')); }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function verifySignature(secret, body, signature) {
  if (!signature) return false;
  const expected = crypto.createHmac('sha256', secret).update(body).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

function httpRequest(url, options, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? https : http;
    const req = mod.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method: options.method || 'GET',
      headers: options.headers || {},
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.setTimeout(120000, () => { req.destroy(); reject(new Error('Request timeout')); });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ========== SeaTalk API ==========

async function getAccessToken(bot) {
  const state = botState.get(bot.id);
  if (state.accessToken && Date.now() < state.tokenExpiry) return state.accessToken;

  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ app_id: bot.seatalk_app_id, app_secret: bot.seatalk_app_secret });
    const req = https.request({
      hostname: 'openapi.seatalk.io',
      path: '/auth/app_access_token',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          const tok = json.token || json.app_access_token;
          const expiry = json.expire_in || json.expire || 7200;
          if ((json.code === 0 || json.code === undefined) && tok) {
            state.accessToken = tok;
            state.tokenExpiry = Date.now() + expiry * 1000 - 60000;
            console.log(`[${bot.id}] Got SeaTalk access token`);
            resolve(tok);
          } else {
            reject(new Error(`[${bot.id}] Token failed: ${body.substring(0, 200)}`));
          }
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function sendMessage(bot, employeeCode, message) {
  const token = await getAccessToken(bot);
  const data = JSON.stringify({
    employee_code: employeeCode,
    message: { tag: 'text', text: { content: message } },
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'openapi.seatalk.io',
      path: '/messaging/v2/single_chat',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        console.log(`[${bot.id}] Send result (${res.statusCode}): ${body.substring(0, 200)}`);
        res.statusCode >= 400 ? reject(new Error(`SeaTalk ${res.statusCode}: ${body.substring(0, 200)}`)) : resolve(body);
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ========== OpenClaw bridge ==========

async function askOpenClaw(bot, userId, message) {
  if (!bot.openclaw_url) return null;
  const gatewayBase = bot.openclaw_url.replace(/\/$/, '');
  const authHeader = 'Basic ' + Buffer.from(`user:${bot.setup_password}`).toString('base64');

  try {
    const payload = JSON.stringify({
      command: 'openclaw.agent.message',
      arg: JSON.stringify({ agent: 'main', message }),
    });

    console.log(`[${bot.id}] Sending to openclaw: user=${userId}, message=${message.substring(0, 50)}...`);

    const response = await httpRequest(
      `${gatewayBase}/setup/api/console/run`,
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': authHeader } },
      payload
    );

    console.log(`[${bot.id}] OpenClaw response status: ${response.status}`);

    if (response.status === 200) {
      const result = JSON.parse(response.body);
      if (result.ok && result.output) return result.output.trim();
      console.error(`[${bot.id}] OpenClaw ok=false: ${result.output || result.error}`);
    } else {
      console.error(`[${bot.id}] OpenClaw error: ${response.status} ${response.body.substring(0, 200)}`);
    }
    return null;
  } catch (err) {
    console.error(`[${bot.id}] OpenClaw request failed: ${err.message}`);
    return null;
  }
}

async function handleMessage(bot, employeeCode, message) {
  const reply = await askOpenClaw(bot, employeeCode, message);
  try {
    if (reply) {
      await sendMessage(bot, employeeCode, reply);
      console.log(`[${bot.id}] Reply sent to ${employeeCode}: ${reply.substring(0, 100)}...`);
    } else {
      await sendMessage(bot, employeeCode, 'Sorry, I could not get a response. Please try again later.');
    }
  } catch (e) {
    console.error(`[${bot.id}] Failed to send reply: ${e.message}`);
  }
}

// ========== Callback handler ==========

async function handleCallback(bot, req, res, body) {
  try {
    const data = JSON.parse(body);

    // Verification challenge
    if (data.event_type === 'event_verification') {
      const challenge = data.event?.seatalk_challenge;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ seatalk_challenge: challenge }));
    }

    // Signature check
    const signature = req.headers['x-seatalk-signature'];
    if (signature && !verifySignature(bot.seatalk_app_secret, body, signature)) {
      res.writeHead(401);
      return res.end(JSON.stringify({ error: 'Invalid signature' }));
    }

    // Message
    if (data.event_type === 'message_from_bot_subscriber') {
      const seatalkId = data.event?.seatalk_id;
      const employeeCode = data.event?.employee_code;
      const message = data.event?.message?.text?.content || '';

      console.log(`[${bot.id}] Message from ${seatalkId} (emp:${employeeCode}): ${message}`);

      // Return 200 immediately to avoid SeaTalk retry
      res.writeHead(200);
      res.end(JSON.stringify({ status: 'ok' }));

      if (bot.openclaw_url) {
        handleMessage(bot, employeeCode, message).catch(err => {
          console.error(`[${bot.id}] handleMessage error:`, err);
        });
      } else {
        // Queue mode
        const state = botState.get(bot.id);
        const messageId = ++state.lastMessageId;
        state.messageQueue.push({ id: messageId, sender_id: seatalkId, employee_code: employeeCode, message, timestamp: Date.now() });
        if (state.messageQueue.length > 100) state.messageQueue.shift();
      }
      return;
    }

    res.writeHead(200);
    res.end(JSON.stringify({ status: 'ok' }));
  } catch (e) {
    console.error(`[${bot.id}] Callback error:`, e);
    res.writeHead(200);
    res.end(JSON.stringify({ status: 'ok' }));
  }
}

// ========== HTTP server ==========

const server = http.createServer((req, res) => {
  const ts = new Date().toISOString();
  console.log(`${ts} ${req.method} ${req.url}`);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);

  // Health
  if (parsedUrl.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      status: 'ok',
      time: Date.now(),
      bots: BOTS.map(b => ({ id: b.id, bridge: !!b.openclaw_url })),
    }));
  }

  // Per-bot callback: /bot/:botId/callback
  const botPathMatch = parsedUrl.pathname.match(/^\/bot\/([^/]+)\/callback$/);
  if (botPathMatch) {
    const bot = BOTS.find(b => b.id === botPathMatch[1]);
    if (!bot) { res.writeHead(404); return res.end(JSON.stringify({ error: 'Bot not found' })); }

    if (req.method === 'GET') {
      const challenge = parsedUrl.searchParams.get('seatalk_challenge') || parsedUrl.searchParams.get('challenge');
      if (challenge) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ seatalk_challenge: challenge }));
      }
      res.writeHead(200);
      return res.end(JSON.stringify({ status: 'ok' }));
    }

    if (req.method === 'POST') {
      readBody(req).then(body => handleCallback(bot, req, res, body)).catch(e => {
        res.writeHead(413); res.end(JSON.stringify({ error: 'Request body too large' }));
      });
      return;
    }
  }

  // Legacy callback: /seatalk/callback (auto-route by app_id in payload)
  if (parsedUrl.pathname === '/seatalk/callback') {
    if (req.method === 'GET') {
      const challenge = parsedUrl.searchParams.get('seatalk_challenge') || parsedUrl.searchParams.get('challenge');
      if (challenge) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ seatalk_challenge: challenge }));
      }
      res.writeHead(200);
      return res.end(JSON.stringify({ status: 'ok' }));
    }

    if (req.method === 'POST') {
      readBody(req).then(body => {
        try {
          const data = JSON.parse(body);
          const bot = botByAppId.get(data.app_id) || BOTS[0];
          handleCallback(bot, req, res, body);
        } catch (e) {
          res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid JSON' }));
        }
      }).catch(e => {
        res.writeHead(413); res.end(JSON.stringify({ error: 'Request body too large' }));
      });
      return;
    }
  }

  // Poll (legacy, per-bot via query param ?bot=botId)
  if (parsedUrl.pathname === '/poll' && req.method === 'GET') {
    const botId = parsedUrl.searchParams.get('bot') || BOTS[0].id;
    const bot = BOTS.find(b => b.id === botId);
    if (!bot) { res.writeHead(404); return res.end(JSON.stringify({ error: 'Bot not found' })); }

    const apiKey = bot.openclaw_api_key || '';
    if (apiKey) {
      const auth = req.headers['authorization'];
      if (auth !== `Bearer ${apiKey}`) { res.writeHead(401); return res.end(JSON.stringify({ error: 'Unauthorized' })); }
    }

    const state = botState.get(bot.id);
    const lastId = parseInt(parsedUrl.searchParams.get('last_id') || '0');
    const timeout = Math.min(parseInt(parsedUrl.searchParams.get('timeout') || '5000'), 30000);
    const newMessages = state.messageQueue.filter(m => m.id > lastId);
    if (newMessages.length > 0) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ messages: newMessages }));
    }

    let elapsed = 0, closed = false, timerId = null;
    req.on('close', () => { closed = true; if (timerId) clearTimeout(timerId); });
    const check = () => {
      if (closed) return;
      const msgs = state.messageQueue.filter(m => m.id > lastId);
      if (msgs.length > 0) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ messages: msgs })); }
      elapsed += 200;
      if (elapsed >= timeout) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ messages: [] })); }
      timerId = setTimeout(check, 200);
    };
    check();
    return;
  }

  // Send (legacy, per-bot via query param ?bot=botId)
  if (parsedUrl.pathname === '/send' && req.method === 'POST') {
    const botId = parsedUrl.searchParams.get('bot') || BOTS[0].id;
    const bot = BOTS.find(b => b.id === botId);
    if (!bot) { res.writeHead(404); return res.end(JSON.stringify({ error: 'Bot not found' })); }

    readBody(req).then(async (body) => {
      try {
        const { user_id, message } = JSON.parse(body);
        if (!user_id || !message) { res.writeHead(400); return res.end(JSON.stringify({ error: 'user_id and message required' })); }
        const result = await sendMessage(bot, user_id, message);
        let parsed; try { parsed = JSON.parse(result); } catch { parsed = { raw: result }; }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', result: parsed }));
      } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
    }).catch(() => { res.writeHead(413); res.end(JSON.stringify({ error: 'Too large' })); });
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`SeaTalk Bot ready on port ${PORT}`);
  console.log(`${BOTS.length} bot(s) configured`);
});
