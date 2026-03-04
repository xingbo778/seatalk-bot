const http = require('http');
const https = require('https');
const url = require('url');

const PORT = process.env.PORT || 8080;
const APP_ID = process.env.SEATALK_APP_ID || 'MDc4MjcwNTE2ODY5';
const APP_SECRET = process.env.SEATALK_APP_SECRET || 'w20BysMOMSiIYnTsrfHH9t3Fw_iMg2wu';

// OpenClaw 配置 - 用于消息中转
const OPENCLAW_API_KEY = process.env.OPENCLAW_API_KEY || '';

console.log(`SeaTalk Bot starting on port ${PORT}...`);

// 存储对话和 access token
const conversations = new Map();
let accessToken = null;
let tokenExpiry = 0;

// 消息队列 - 存储待发送的消息
const messageQueue = [];
let lastMessageId = 0;

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

const server = http.createServer((req, res) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.url}`);
  
  // 设置 CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }
  
  try {
    const parsedUrl = url.parse(req.url, true);
    
    if (parsedUrl.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ status: 'ok', time: Date.now() }));
    }
    
    // SeaTalk 回调
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
        });
        return;
      }
    }
    
    // OpenClaw 轮询 - 获取新消息 (长轮询)
    if (parsedUrl.pathname === '/poll') {
      if (req.method === 'GET') {
        const lastId = parseInt(parsedUrl.query.last_id || '0');
        const timeout = parseInt(parsedUrl.query.timeout || '5000');
        
        console.log(`Poll request: last_id=${lastId}, timeout=${timeout}ms`);
        
        // 检查是否有新消息
        const hasNewMessage = messageQueue.some(m => m.id > lastId);
        
        if (hasNewMessage) {
          // 立即返回新消息
          const newMessages = messageQueue.filter(m => m.id > lastId);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ messages: newMessages }));
        }
        
        // 没有新消息，等待（长轮询）
        const checkInterval = 200; // 每 200ms 检查一次
        let elapsed = 0;
        
        const checkNewMessage = () => {
          const hasNew = messageQueue.some(m => m.id > lastId);
          if (hasNew) {
            const newMessages = messageQueue.filter(m => m.id > lastId);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ messages: newMessages }));
          }
          
          elapsed += checkInterval;
          if (elapsed >= timeout) {
            // 超时，返回空
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ messages: [] }));
          }
          
          setTimeout(checkNewMessage, checkInterval);
        };
        
        checkNewMessage();
        return;
      }
    }
    
    // OpenClaw 发送回复
    if (parsedUrl.pathname === '/send') {
      if (req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
          try {
            const data = JSON.parse(body);
            const { user_id, message } = data;
            
            if (!user_id || !message) {
              res.writeHead(400);
              return res.end(JSON.stringify({ error: 'user_id and message required' }));
            }
            
            console.log(`Sending reply to ${user_id}: ${message}`);
            
            // 通过 SeaTalk API 发送
            const result = await sendMessage(user_id, message);
            
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ status: 'ok', result: JSON.parse(result) }));
          } catch (e) {
            console.error('Send error:', e);
            res.writeHead(500);
            res.end(JSON.stringify({ error: e.message }));
          }
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
  console.log('Endpoints:');
  console.log('  GET  /health - Health check');
  console.log('  GET  /seatalk/callback - SeaTalk verification');
  console.log('  POST /seatalk/callback - SeaTalk events');
  console.log('  GET  /poll?last_id=X&timeout=5000 - OpenClaw long poll');
  console.log('  POST /send - OpenClaw send reply');
});
