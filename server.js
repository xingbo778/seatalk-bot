const http = require('http');
const https = require('https');
const crypto = require('crypto');

const PORT = process.env.PORT || 8080;
const MAX_BODY_SIZE = 1024 * 1024;
const MAX_MESSAGE_LENGTH = 5000;

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
  const mode = bot.adk_url ? 'ADK' : bot.openclaw_url ? 'BRIDGE' : 'QUEUE';
  const target = bot.adk_url || bot.openclaw_url || '(passive)';
  console.log(`  [${bot.id}] ${mode} -> ${target}`);
  console.log(`    callback: /bot/${bot.id}/callback  (also auto-routed by app_id)`);
  if (!bot.openclaw_api_key && !bot.openclaw_url && !bot.adk_url) {
    console.warn(`  ⚠ [${bot.id}] OPENCLAW_API_KEY not set — /poll and /send endpoints are unauthenticated`);
  }
}

// ========== Logging ==========

function log(level, botId, msg, extra) {
  const entry = { ts: new Date().toISOString(), level, bot: botId, msg };
  if (extra) entry.extra = extra;
  console[level === 'error' ? 'error' : 'log'](JSON.stringify(entry));
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

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function verifySignature(secret, body, signature) {
  if (!signature) return false;
  const expected = crypto.createHmac('sha256', secret).update(body).digest('hex');
  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length) return false;
  return crypto.timingSafeEqual(sigBuf, expBuf);
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
    req.setTimeout(options.timeout || 30000, () => { req.destroy(); reject(new Error('Request timeout')); });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ========== SeaTalk API ==========

async function getAccessToken(bot) {
  const state = botState.get(bot.id);
  if (state.accessToken && Date.now() < state.tokenExpiry) return state.accessToken;

  // Mutex: reuse in-flight refresh to avoid concurrent token requests
  if (state._refreshPromise) return state._refreshPromise;

  state._refreshPromise = _fetchAccessToken(bot, state).finally(() => {
    state._refreshPromise = null;
  });
  return state._refreshPromise;
}

function _fetchAccessToken(bot, state) {
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

async function setTypingStatus(bot, employeeCode, groupId) {
  try {
    const token = await getAccessToken(bot);
    const path = groupId ? '/messaging/v2/group_chat_typing' : '/messaging/v2/single_chat_typing';
    const payload = groupId ? { group_id: groupId } : { employee_code: employeeCode };
    await seatalkPost(bot, token, path, JSON.stringify(payload));
  } catch (e) {
    console.log(`[${bot.id}] Typing status failed (non-critical): ${e.message}`);
  }
}

async function sendMessage(bot, employeeCode, message) {
  const token = await getAccessToken(bot);
  const data = JSON.stringify({
    employee_code: employeeCode,
    message: { tag: 'text', text: { format: 1, content: message } },
  });
  return seatalkPost(bot, token, '/messaging/v2/single_chat', data);
}

async function sendGroupMessage(bot, groupId, message, mentionEmployeeCode) {
  const token = await getAccessToken(bot);
  const payload = {
    group_id: groupId,
    message: { tag: 'text', text: { format: 1, content: message } },
  };
  if (mentionEmployeeCode) {
    payload.mentioned_employee_codes = [mentionEmployeeCode];
  }
  const data = JSON.stringify(payload);
  return seatalkPost(bot, token, '/messaging/v2/group_chat', data);
}

function seatalkPostRaw(token, path, data) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'openapi.seatalk.io',
      path,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function seatalkPost(bot, token, path, data) {
  let res = await seatalkPostRaw(token, path, data);
  console.log(`[${bot.id}] Send result (${res.status}) ${path}: ${res.body.substring(0, 200)}`);

  // If token expired, invalidate cache and retry once with a fresh token
  try {
    const json = JSON.parse(res.body);
    if (json.code === 100) {
      console.log(`[${bot.id}] Token expired, refreshing...`);
      const state = botState.get(bot.id);
      state.accessToken = null;
      state.tokenExpiry = 0;
      const newToken = await getAccessToken(bot);
      res = await seatalkPostRaw(newToken, path, data);
      console.log(`[${bot.id}] Retry result (${res.status}) ${path}: ${res.body.substring(0, 200)}`);
    }
  } catch (e) { /* ignore parse errors */ }

  if (res.status >= 400) throw new Error(`SeaTalk ${res.status}: ${res.body.substring(0, 200)}`);
  return res.body;
}

// ========== ADK (Agent Development Kit) bridge ==========

// Per-bot session cache: botId -> Map<userId, sessionId>
const adkSessions = new Map();

async function askADK(bot, userId, message) {
  if (!bot.adk_url) return null;
  const baseUrl = bot.adk_url.replace(/\/$/, '');
  const appName = bot.adk_app_name || 'fortune_agent';

  try {
    // Get or create session for this user
    let sessions = adkSessions.get(bot.id);
    if (!sessions) { sessions = new Map(); adkSessions.set(bot.id, sessions); }

    let sessionId = sessions.get(userId);
    if (!sessionId) {
      // Create a new session
      const createRes = await httpRequest(
        `${baseUrl}/apps/${appName}/users/${userId}/sessions`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' } },
        '{}'
      );
      if (createRes.status === 200) {
        const session = JSON.parse(createRes.body);
        sessionId = session.id;
        sessions.set(userId, sessionId);
        console.log(`[${bot.id}] Created ADK session ${sessionId} for user ${userId}`);
      } else {
        console.error(`[${bot.id}] Failed to create ADK session: ${createRes.status} ${createRes.body.substring(0, 200)}`);
        return null;
      }
    }

    // Send message to agent
    console.log(`[${bot.id}] Sending to ADK: user=${userId}, session=${sessionId}, message=${message.substring(0, 50)}...`);
    const payload = JSON.stringify({
      app_name: appName,
      user_id: userId,
      session_id: sessionId,
      new_message: {
        role: 'user',
        parts: [{ text: message }],
      },
    });

    const response = await httpRequest(
      `${baseUrl}/run`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' } },
      payload
    );

    console.log(`[${bot.id}] ADK response status: ${response.status}`);

    if (response.status === 200) {
      const events = JSON.parse(response.body);
      // Extract the last model text response
      const textParts = [];
      for (const event of events) {
        if (event.author === appName && event.content?.parts) {
          for (const part of event.content.parts) {
            if (part.text) textParts.push(part.text);
          }
        }
      }
      const result = textParts.join('\n').trim();
      if (result) return result;
      console.error(`[${bot.id}] ADK returned no text in response`);
    } else if (response.status === 404) {
      // Session might have expired, clear and retry once
      console.log(`[${bot.id}] Session expired, creating new session...`);
      sessions.delete(userId);
      return askADK(bot, userId, message);
    } else {
      console.error(`[${bot.id}] ADK error: ${response.status} ${response.body.substring(0, 200)}`);
    }
    return null;
  } catch (err) {
    console.error(`[${bot.id}] ADK request failed: ${err.message}`);
    return null;
  }
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
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': authHeader }, timeout: 60000 },
      payload
    );

    console.log(`[${bot.id}] OpenClaw response status: ${response.status}`);

    if (response.status === 200) {
      const result = JSON.parse(response.body);
      if (result.ok && result.output) {
        // Strip gateway warning lines that precede the actual response
        const cleaned = result.output.replace(/^(gateway connect failed:.*\n|Gateway agent failed;.*\n|Gateway target:.*\n|Source:.*\n|Config:.*\n|Bind:.*\n)*/gm, '').trim();
        return cleaned;
      }
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

async function handleMessage(bot, employeeCode, message, groupChatId) {
  setTypingStatus(bot, employeeCode, groupChatId);
  const reply = bot.adk_url
    ? await askADK(bot, employeeCode, message)
    : await askOpenClaw(bot, employeeCode, message);
  const sendFn = groupChatId
    ? (msg) => sendGroupMessage(bot, groupChatId, msg, employeeCode)
    : (msg) => sendMessage(bot, employeeCode, msg);
  try {
    if (reply) {
      await sendFn(reply);
      console.log(`[${bot.id}] Reply sent ${groupChatId ? 'to group ' + groupChatId : 'to ' + employeeCode}: ${reply.substring(0, 100)}...`);
    } else {
      await sendFn('Sorry, I could not get a response. Please try again later.');
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

    // Signature check (optional — only reject if present but invalid)
    const signature = req.headers['x-seatalk-signature'];
    if (signature && !verifySignature(bot.seatalk_app_secret, body, signature)) {
      res.writeHead(401);
      return res.end(JSON.stringify({ error: 'Invalid signature' }));
    }

    // Private message
    if (data.event_type === 'message_from_bot_subscriber') {
      const seatalkId = data.event?.seatalk_id;
      const employeeCode = data.event?.employee_code;
      let message = data.event?.message?.text?.content || '';
      if (message.length > MAX_MESSAGE_LENGTH) message = message.substring(0, MAX_MESSAGE_LENGTH);

      log('info', bot.id, 'DM received', { from: seatalkId, emp: employeeCode, preview: message.substring(0, 100) });

      res.writeHead(200);
      res.end(JSON.stringify({ status: 'ok' }));

      if (bot.openclaw_url || bot.adk_url) {
        handleMessage(bot, employeeCode, message).catch(err => {
          console.error(`[${bot.id}] handleMessage error:`, err);
        });
      } else {
        const state = botState.get(bot.id);
        const messageId = ++state.lastMessageId;
        state.messageQueue.push({ id: messageId, sender_id: seatalkId, employee_code: employeeCode, message, timestamp: Date.now() });
        if (state.messageQueue.length > 100) state.messageQueue.shift();
      }
      return;
    }

    // Group chat @mention
    if (data.event_type === 'new_mentioned_message_received_from_group_chat') {
      const groupId = data.event?.group_id;
      const sender = data.event?.message?.sender;
      const seatalkId = sender?.seatalk_id;
      const employeeCode = sender?.employee_code;
      const plainText = data.event?.message?.text?.plain_text || '';

      // Strip all @mentions from the message to get the actual question
      const mentionedList = data.event?.message?.text?.mentioned_list || [];
      let cleanMessage = plainText;
      for (const m of mentionedList) {
        if (m.username) {
          cleanMessage = cleanMessage.replace(new RegExp(`@${escapeRegex(m.username)}\\s*`, 'g'), '');
        }
      }
      // Also strip any remaining @mentions patterns
      cleanMessage = cleanMessage.replace(/@\S+\s*/g, '').trim() || plainText.trim();
      if (cleanMessage.length > MAX_MESSAGE_LENGTH) cleanMessage = cleanMessage.substring(0, MAX_MESSAGE_LENGTH);

      log('info', bot.id, 'Group mention received', { group: groupId, from: seatalkId, emp: employeeCode, preview: cleanMessage.substring(0, 100) });

      res.writeHead(200);
      res.end(JSON.stringify({ status: 'ok' }));

      if ((bot.openclaw_url || bot.adk_url) && cleanMessage) {
        handleMessage(bot, employeeCode, cleanMessage, groupId).catch(err => {
          console.error(`[${bot.id}] handleMessage error:`, err);
        });
      }
      return;
    }

    res.writeHead(200);
    res.end(JSON.stringify({ status: 'ok' }));
  } catch (e) {
    log('error', bot.id, 'Callback error', { error: e.message });
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

    const sendApiKey = bot.openclaw_api_key || '';
    if (sendApiKey) {
      const auth = req.headers['authorization'];
      if (auth !== `Bearer ${sendApiKey}`) { res.writeHead(401); return res.end(JSON.stringify({ error: 'Unauthorized' })); }
    }

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
