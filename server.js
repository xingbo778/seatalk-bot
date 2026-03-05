const http = require('http');
const https = require('https');
const crypto = require('crypto');

const PORT = process.env.PORT || 8080;
const APP_ID = process.env.SEATALK_APP_ID;
const APP_SECRET = process.env.SEATALK_APP_SECRET;
const OPENCLAW_API_KEY = process.env.OPENCLAW_API_KEY || '';
const OPENCLAW_GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL || '';
const OPENCLAW_GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN || '';

// 请求体大小限制 (1MB)
const MAX_BODY_SIZE = 1024 * 1024;

if (!APP_ID || !APP_SECRET) {
  console.error('Missing required env vars: SEATALK_APP_ID, SEATALK_APP_SECRET');
  process.exit(1);
}

if (!OPENCLAW_GATEWAY_URL) {
  console.warn('OPENCLAW_GATEWAY_URL not set — bridge mode disabled, running in queue-only mode');
}

console.log(`SeaTalk Bot starting on port ${PORT}...`);
if (OPENCLAW_GATEWAY_URL) {
  console.log(`Bridge mode: forwarding to ${OPENCLAW_GATEWAY_URL}`);
}

// 存储 access token
let accessToken = null;
let tokenExpiry = 0;

// 消息队列 - 存储待发送的消息 (fallback mode)
const messageQueue = [];
let lastMessageId = 0;

// 用户会话映射 (seatalk userId -> openclaw sessionId)
const userSessions = new Map();

// 读取请求体（带大小限制）
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > MAX_BODY_SIZE) {
        req.destroy();
        reject(new Error('Request body too large'));
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

// 验证 OpenClaw API Key
function authenticateOpenClaw(req) {
  if (!OPENCLAW_API_KEY) return true;
  const auth = req.headers['authorization'];
  return auth === `Bearer ${OPENCLAW_API_KEY}`;
}

// 验证 SeaTalk 签名
function verifySignature(body, signature) {
  if (!signature) return false;
  const expected = crypto
    .createHmac('sha256', APP_SECRET)
    .update(body)
    .digest('hex');
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

// 获取 SeaTalk access token
async function getAccessToken() {
  if (accessToken && Date.now() < tokenExpiry) {
    return accessToken;
  }

  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET });
    const options = {
      hostname: 'open.seatalk.io',
      path: '/authentication/v1/token/get',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      }
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          if (json.code === 0 && json.token) {
            accessToken = json.token;
            tokenExpiry = Date.now() + (json.expire_in || 7200) * 1000 - 60000;
            console.log('Got SeaTalk access token');
            resolve(accessToken);
          } else {
            reject(new Error('Failed to get token: ' + body));
          }
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// 发送 SeaTalk 消息
async function sendMessage(userId, message) {
  const token = await getAccessToken();
  const data = JSON.stringify({
    recipient: { type: 'single', id: userId },
    message: { text: message }
  });

  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'open.seatalk.io',
      path: '/messaging/v1/send_message',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      }
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        console.log('SeaTalk send result:', body);
        resolve(body);
      });
    });

    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// 发送 HTTP 请求到 openclaw gateway
function httpRequest(url, options, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? https : http;
    const reqOptions = {
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method: options.method || 'GET',
      headers: options.headers || {},
    };

    const req = mod.request(reqOptions, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    });

    req.setTimeout(120000, () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// 通过 openclaw gateway API 发送消息并获取回复
async function askOpenClaw(userId, message) {
  if (!OPENCLAW_GATEWAY_URL) return null;

  const gatewayBase = OPENCLAW_GATEWAY_URL.replace(/\/$/, '');
  const sessionId = userSessions.get(userId) || `seatalk-${userId}`;

  try {
    // 使用 openclaw gateway 的 HTTP API 发送消息
    const payload = JSON.stringify({
      message: message,
      session_id: sessionId,
    });

    console.log(`[bridge] Sending to openclaw: session=${sessionId}, message=${message.substring(0, 50)}...`);

    const response = await httpRequest(
      `${gatewayBase}/api/v1/chat`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${OPENCLAW_GATEWAY_TOKEN}`,
        },
      },
      payload
    );

    console.log(`[bridge] OpenClaw response status: ${response.status}`);

    if (response.status === 200) {
      const result = JSON.parse(response.body);
      // 保存会话 ID
      if (result.session_id) {
        userSessions.set(userId, result.session_id);
      }
      return result.response || result.message || result.text || JSON.stringify(result);
    }

    // 尝试备用端点
    const altResponse = await httpRequest(
      `${gatewayBase}/api/message`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${OPENCLAW_GATEWAY_TOKEN}`,
        },
      },
      payload
    );

    if (altResponse.status === 200) {
      const result = JSON.parse(altResponse.body);
      return result.response || result.message || result.text || JSON.stringify(result);
    }

    console.error(`[bridge] OpenClaw error: ${response.status} ${response.body.substring(0, 200)}`);
    return null;
  } catch (err) {
    console.error(`[bridge] OpenClaw request failed: ${err.message}`);
    return null;
  }
}

// 处理 SeaTalk 消息 (bridge mode)
async function handleSeaTalkMessage(senderId, message) {
  // 发送"正在思考"提示
  try {
    await sendMessage(senderId, '🤔 Thinking...');
  } catch (e) {
    console.warn('[bridge] Failed to send typing indicator:', e.message);
  }

  const reply = await askOpenClaw(senderId, message);

  if (reply) {
    try {
      await sendMessage(senderId, reply);
      console.log(`[bridge] Reply sent to ${senderId}: ${reply.substring(0, 100)}...`);
    } catch (e) {
      console.error(`[bridge] Failed to send reply: ${e.message}`);
    }
  } else {
    try {
      await sendMessage(senderId, '⚠️ Sorry, I could not get a response. Please try again later.');
    } catch (e) {
      console.error(`[bridge] Failed to send error message: ${e.message}`);
    }
  }
}

const server = http.createServer((req, res) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.url}`);

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  try {
    const parsedUrl = new URL(req.url, `http://${req.headers.host}`);

    if (parsedUrl.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        status: 'ok',
        time: Date.now(),
        bridge: !!OPENCLAW_GATEWAY_URL,
        gateway: OPENCLAW_GATEWAY_URL || 'not configured',
      }));
    }

    // SeaTalk 回调
    if (parsedUrl.pathname === '/seatalk/callback') {
      if (req.method === 'GET') {
        const challenge = parsedUrl.searchParams.get('seatalk_challenge') || parsedUrl.searchParams.get('challenge');
        if (challenge) {
          console.log(`Verification: ${challenge}`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ seatalk_challenge: challenge }));
        }
        res.writeHead(200);
        return res.end(JSON.stringify({ status: 'ok' }));
      }

      if (req.method === 'POST') {
        readBody(req).then(async (body) => {
          console.log('Event:', body);

          try {
            const data = JSON.parse(body);

            // 验证
            if (data.event_type === 'event_verification') {
              const challenge = data.event?.seatalk_challenge;
              res.writeHead(200, { 'Content-Type': 'application/json' });
              return res.end(JSON.stringify({ seatalk_challenge: challenge }));
            }

            // 签名校验
            const signature = req.headers['x-seatalk-signature'];
            if (signature && !verifySignature(body, signature)) {
              console.log('Invalid signature');
              res.writeHead(401);
              return res.end(JSON.stringify({ error: 'Invalid signature' }));
            }

            // 消息处理
            if (data.event_type === 'message_from_bot_subscriber') {
              const senderId = data.event?.sender?.id;
              const message = data.event?.message?.text || '';

              console.log(`Message from ${senderId}: ${message}`);

              // 先返回 200 给 SeaTalk（避免超时重试）
              res.writeHead(200);
              res.end(JSON.stringify({ status: 'ok' }));

              // Bridge mode: 异步转发到 openclaw
              if (OPENCLAW_GATEWAY_URL) {
                handleSeaTalkMessage(senderId, message).catch(err => {
                  console.error('[bridge] handleSeaTalkMessage error:', err);
                });
              } else {
                // Fallback: 存入队列
                const messageId = ++lastMessageId;
                messageQueue.push({
                  id: messageId,
                  sender_id: senderId,
                  message: message,
                  timestamp: Date.now()
                });
                if (messageQueue.length > 100) messageQueue.shift();
                console.log(`Message queued (id: ${messageId})`);
              }
              return;
            }

            res.writeHead(200);
            res.end(JSON.stringify({ status: 'ok' }));
          } catch (e) {
            console.error('Error:', e);
            res.writeHead(200);
            res.end(JSON.stringify({ status: 'ok' }));
          }
        }).catch(e => {
          console.error('Body read error:', e.message);
          res.writeHead(413);
          res.end(JSON.stringify({ error: 'Request body too large' }));
        });
        return;
      }
    }

    // OpenClaw 轮询 - 获取新消息 (长轮询, fallback mode)
    if (parsedUrl.pathname === '/poll') {
      if (req.method === 'GET') {
        if (!authenticateOpenClaw(req)) {
          res.writeHead(401);
          return res.end(JSON.stringify({ error: 'Unauthorized' }));
        }

        const lastId = parseInt(parsedUrl.searchParams.get('last_id') || '0');
        const timeout = Math.min(parseInt(parsedUrl.searchParams.get('timeout') || '5000'), 30000);
        const newMessages = messageQueue.filter(m => m.id > lastId);

        if (newMessages.length > 0) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ messages: newMessages }));
        }

        const checkInterval = 200;
        let elapsed = 0;
        let closed = false;
        let timerId = null;

        req.on('close', () => { closed = true; if (timerId) clearTimeout(timerId); });

        const checkNewMessage = () => {
          if (closed) return;
          const msgs = messageQueue.filter(m => m.id > lastId);
          if (msgs.length > 0) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ messages: msgs }));
          }
          elapsed += checkInterval;
          if (elapsed >= timeout) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ messages: [] }));
          }
          timerId = setTimeout(checkNewMessage, checkInterval);
        };
        checkNewMessage();
        return;
      }
    }

    // OpenClaw 发送回复 (fallback mode)
    if (parsedUrl.pathname === '/send') {
      if (req.method === 'POST') {
        if (!authenticateOpenClaw(req)) {
          res.writeHead(401);
          return res.end(JSON.stringify({ error: 'Unauthorized' }));
        }

        readBody(req).then(async (body) => {
          try {
            const data = JSON.parse(body);
            const { user_id, message } = data;

            if (!user_id || !message) {
              res.writeHead(400);
              return res.end(JSON.stringify({ error: 'user_id and message required' }));
            }

            const result = await sendMessage(user_id, message);
            let parsedResult;
            try { parsedResult = JSON.parse(result); } catch { parsedResult = { raw: result }; }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ status: 'ok', result: parsedResult }));
          } catch (e) {
            console.error('Send error:', e);
            res.writeHead(500);
            res.end(JSON.stringify({ error: e.message }));
          }
        }).catch(e => {
          res.writeHead(413);
          res.end(JSON.stringify({ error: 'Request body too large' }));
        });
        return;
      }
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Not found' }));
  } catch (e) {
    console.error('Error:', e);
    res.writeHead(500);
    res.end(JSON.stringify({ error: e.message }));
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`SeaTalk Bot ready on port ${PORT}`);
  console.log('Mode:', OPENCLAW_GATEWAY_URL ? 'BRIDGE (active)' : 'QUEUE (passive)');
  console.log('Endpoints:');
  console.log('  GET  /health - Health check');
  console.log('  GET  /seatalk/callback - SeaTalk verification');
  console.log('  POST /seatalk/callback - SeaTalk events');
  console.log('  GET  /poll - OpenClaw long poll (fallback)');
  console.log('  POST /send - OpenClaw send reply (fallback)');
});
