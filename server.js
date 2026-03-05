const http = require('http');
const https = require('https');
const crypto = require('crypto');

const PORT = process.env.PORT || 8080;
const APP_ID = process.env.SEATALK_APP_ID;
const APP_SECRET = process.env.SEATALK_APP_SECRET;
const OPENCLAW_API_KEY = process.env.OPENCLAW_API_KEY || '';

// 允许的 CORS 来源
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : [];

// 请求体大小限制 (1MB)
const MAX_BODY_SIZE = 1024 * 1024;

if (!APP_ID || !APP_SECRET) {
  console.error('Missing required env vars: SEATALK_APP_ID, SEATALK_APP_SECRET');
  process.exit(1);
}

console.log(`SeaTalk Bot starting on port ${PORT}...`);

// 存储 access token
let accessToken = null;
let tokenExpiry = 0;

// 消息队列 - 存储待发送的消息
const messageQueue = [];
let lastMessageId = 0;

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
  if (!OPENCLAW_API_KEY) return true; // 未配置则跳过
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

// 获取 access token
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
            console.log('Got access token');
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

// 发送消息
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
        console.log('Send result:', body);
        resolve(body);
      });
    });

    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// 设置 CORS 头
function setCorsHeaders(req, res) {
  const origin = req.headers['origin'];
  if (ALLOWED_ORIGINS.length === 0) {
    // 未配置时允许所有（开发模式）
    res.setHeader('Access-Control-Allow-Origin', '*');
  } else if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

const server = http.createServer((req, res) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.url}`);

  setCorsHeaders(req, res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  try {
    const parsedUrl = new URL(req.url, `http://${req.headers.host}`);

    if (parsedUrl.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ status: 'ok', time: Date.now() }));
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

            // 非验证事件需要签名校验
            const signature = req.headers['x-seatalk-signature'];
            if (signature && !verifySignature(body, signature)) {
              console.log('Invalid signature');
              res.writeHead(401);
              return res.end(JSON.stringify({ error: 'Invalid signature' }));
            }

            // 消息 - 存储到队列，等待 OpenClaw 来取
            if (data.event_type === 'message_from_bot_subscriber') {
              const senderId = data.event?.sender?.id;
              const message = data.event?.message?.text || '';

              console.log(`Message from ${senderId}: ${message}`);

              // 添加到消息队列
              const messageId = ++lastMessageId;
              messageQueue.push({
                id: messageId,
                sender_id: senderId,
                message: message,
                timestamp: Date.now()
              });

              // 只保留最近 100 条消息
              if (messageQueue.length > 100) {
                messageQueue.shift();
              }

              console.log(`Message added to queue (id: ${messageId}, queue size: ${messageQueue.length})`);

              res.writeHead(200);
              return res.end(JSON.stringify({ status: 'ok', message_id: messageId }));
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

    // OpenClaw 轮询 - 获取新消息 (长轮询)
    if (parsedUrl.pathname === '/poll') {
      if (req.method === 'GET') {
        if (!authenticateOpenClaw(req)) {
          res.writeHead(401);
          return res.end(JSON.stringify({ error: 'Unauthorized' }));
        }

        const lastId = parseInt(parsedUrl.searchParams.get('last_id') || '0');
        const timeout = Math.min(parseInt(parsedUrl.searchParams.get('timeout') || '5000'), 30000);

        console.log(`Poll request: last_id=${lastId}, timeout=${timeout}ms`);

        // 检查是否有新消息
        const newMessages = messageQueue.filter(m => m.id > lastId);

        if (newMessages.length > 0) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ messages: newMessages }));
        }

        // 没有新消息，等待（长轮询）
        const checkInterval = 200;
        let elapsed = 0;
        let closed = false;
        let timerId = null;

        req.on('close', () => {
          closed = true;
          if (timerId) clearTimeout(timerId);
        });

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

    // OpenClaw 发送回复
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

            console.log(`Sending reply to ${user_id}: ${message}`);

            const result = await sendMessage(user_id, message);

            let parsedResult;
            try {
              parsedResult = JSON.parse(result);
            } catch {
              parsedResult = { raw: result };
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ status: 'ok', result: parsedResult }));
          } catch (e) {
            console.error('Send error:', e);
            res.writeHead(500);
            res.end(JSON.stringify({ error: e.message }));
          }
        }).catch(e => {
          console.error('Body read error:', e.message);
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
  console.log('Endpoints:');
  console.log('  GET  /health - Health check');
  console.log('  GET  /seatalk/callback - SeaTalk verification');
  console.log('  POST /seatalk/callback - SeaTalk events');
  console.log('  GET  /poll?last_id=X&timeout=5000 - OpenClaw long poll');
  console.log('  POST /send - OpenClaw send reply');
});
