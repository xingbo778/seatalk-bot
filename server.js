const http = require('http');
const https = require('https');
const url = require('url');

const PORT = process.env.PORT || 8080;
const APP_ID = process.env.SEATALK_APP_ID || 'MDc4MjcwNTE2ODY5';
const APP_SECRET = process.env.SEATALK_APP_SECRET || 'w20BysMOMSiIYnTsrfHH9t3Fw_iMg2wu';

// OpenClaw 配置 - 用于转发消息
const OPENCLAW_ENABLED = process.env.OPENCLAW_ENABLED === 'true';
const OPENCLAW_WEBHOOK_URL = process.env.OPENCLAW_WEBHOOK_URL || '';

console.log(`SeaTalk Bot starting on port ${PORT}...`);
console.log(`OpenClaw forwarding: ${OPENCLAW_ENABLED ? 'enabled' : 'disabled'}`);

// 存储对话和 access token
const conversations = new Map();
let accessToken = null;
let tokenExpiry = 0;

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
        'Content-Length': data.length
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
  try {
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
          'Content-Length': data.length
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
  } catch (e) {
    console.error('Send error:', e);
  }
}

// 转发消息到 OpenClaw
async function forwardToOpenClaw(senderId, message) {
  if (!OPENCLAW_ENABLED || !OPENCLAW_WEBHOOK_URL) {
    return;
  }
  
  try {
    const data = JSON.stringify({
      sender_id: senderId,
      message: message,
      timestamp: new Date().toISOString(),
      source: 'seatalk'
    });
    
    return new Promise((resolve, reject) => {
      const options = {
        hostname: new URL(OPENCLAW_WEBHOOK_URL).hostname,
        port: new URL(OPENCLAW_WEBHOOK_URL).port || (new URL(OPENCLAW_WEBHOOK_URL).protocol === 'https:' ? 443 : 80),
        path: new URL(OPENCLAW_WEBHOOK_URL).pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': data.length
        }
      };
      
      const req = https.request(options, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          console.log('OpenClaw forward result:', res.statusCode, body);
          resolve(body);
        });
      });
      
      req.on('error', (e) => {
        console.error('OpenClaw forward error:', e);
        reject(e);
      });
      
      req.write(data);
      req.end();
    });
  } catch (e) {
    console.error('Forward to OpenClaw error:', e);
  }
}

const server = http.createServer((req, res) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.url}`);
  
  try {
    const parsedUrl = url.parse(req.url, true);
    
    if (parsedUrl.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ status: 'ok', time: Date.now() }));
    }
    
    if (parsedUrl.pathname === '/seatalk/callback') {
      if (req.method === 'GET') {
        const challenge = parsedUrl.query.seatalk_challenge || parsedUrl.query.challenge;
        if (challenge) {
          console.log(`Verification: ${challenge}`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ seatalk_challenge: challenge }));
        }
        res.writeHead(200);
        return res.end(JSON.stringify({ status: 'ok' }));
      }
      
      if (req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
          console.log('Event:', body);
          
          try {
            const data = JSON.parse(body);
            
            // 验证
            if (data.event_type === 'event_verification') {
              const challenge = data.event?.seatalk_challenge;
              res.writeHead(200, { 'Content-Type': 'application/json' });
              return res.end(JSON.stringify({ seatalk_challenge: challenge }));
            }
            
            // 消息
            if (data.event_type === 'message_from_bot_subscriber') {
              const senderId = data.event?.sender?.id;
              const message = data.event?.message?.text || '';
              
              console.log(`Message from ${senderId}: ${message}`);
              
              // 转发到 OpenClaw
              await forwardToOpenClaw(senderId, message);
              
              // 生成回复
              const reply = generateReply(message);
              
              // 发送回复
              if (senderId && reply) {
                await sendMessage(senderId, reply);
              }
              
              res.writeHead(200);
              return res.end(JSON.stringify({ status: 'ok' }));
            }
            
            res.writeHead(200);
            res.end(JSON.stringify({ status: 'ok' }));
          } catch (e) {
            console.error('Error:', e);
            res.writeHead(200);
            res.end(JSON.stringify({ status: 'ok' }));
          }
        });
        return;
      }
    }
    
    res.writeHead(404);
    res.end('Not found');
  } catch (e) {
    console.error('Error:', e);
    res.writeHead(500);
    res.end('Error');
  }
});

function generateReply(message) {
  const m = message.toLowerCase();
  if (m.includes('hello') || m.includes('hi') || m.includes('你好')) {
    return '你好！我是 xbclaw，很高兴认识你！有什么可以帮你的吗？';
  }
  if (m.includes('help') || m.includes('帮助')) {
    return '我可以帮助你聊天、回答问题或执行任务。请告诉我你需要什么！';
  }
  return `收到："${message}"\n我是 xbclaw，正在学习如何更好地帮助你！`;
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`SeaTalk Bot ready on port ${PORT}`);
});
