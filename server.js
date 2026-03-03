const http = require('http');
const url = require('url');

const PORT = process.env.PORT || 8080;
const APP_ID = process.env.SEATALK_APP_ID || '';
const APP_SECRET = process.env.SEATALK_APP_SECRET || '';

console.log(`SeaTalk Bot starting on port ${PORT}...`);
console.log(`App ID: ${APP_ID}`);

// 存储对话
const conversations = new Map();

const server = http.createServer((req, res) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.url}`);
  
  try {
    const parsedUrl = url.parse(req.url, true);
    
    // Health check
    if (parsedUrl.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', time: Date.now() }));
      return;
    }
    
    // SeaTalk callback
    if (parsedUrl.pathname === '/seatalk/callback') {
      // GET 验证
      if (req.method === 'GET') {
        const challenge = parsedUrl.query.seatalk_challenge || parsedUrl.query.challenge;
        if (challenge) {
          console.log(`GET challenge: ${challenge}`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ seatalk_challenge: challenge }));
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ status: 'ok' }));
      }
      
      // POST 事件处理
      if (req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
          console.log(`POST body: ${body}`);
          
          try {
            const data = JSON.parse(body);
            const eventType = data.event_type;
            const event = data.event || {};
            
            // 验证请求
            if (data.event_type === 'event_verification') {
              const challenge = event.seatalk_challenge;
              console.log(`Verification: ${challenge}`);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              return res.end(JSON.stringify({ seatalk_challenge: challenge }));
            }
            
            // 处理消息
            if (data.event_type === 'message_from_bot_subscriber') {
              const senderId = event.sender?.id;
              const message = event.message?.text || '';
              console.log(`Message from ${senderId}: ${message}`);
              
              // 存储对话
              if (senderId && !conversations.has(senderId)) {
                conversations.set(senderId, { messages: [] });
              }
              if (senderId) {
                conversations.get(senderId).messages.push({
                  role: 'user',
                  text: message,
                  time: Date.now()
                });
              }
              
              // 自动回复
              const reply = generateReply(message, senderId);
              console.log(`Reply to ${senderId}: ${reply}`);
              
              // TODO: 发送回复到 SeaTalk
              // 需要调用 SeaTalk API 发送消息
              
              res.writeHead(200, { 'Content-Type': 'application/json' });
              return res.end(JSON.stringify({ status: 'ok' }));
            }
            
            // 其他事件
            console.log(`Event: ${eventType}`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'ok' }));
          } catch (e) {
            console.error('Error:', e);
            res.writeHead(400);
            res.end(JSON.stringify({ error: e.message }));
          }
        });
        return;
      }
    }
    
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  } catch (e) {
    console.error('Error:', e);
    res.writeHead(500);
    res.end('Error');
  }
});

function generateReply(message, userId) {
  const lower = message.toLowerCase();
  
  if (lower.includes('hello') || lower.includes('hi') || lower.includes('你好')) {
    return '你好！我是 xbclaw，很高兴认识你！有什么我可以帮助你的吗？';
  }
  if (lower.includes('help') || lower.includes('帮助')) {
    return '我可以帮助你：\n1. 回答问题\n2. 聊天\n3. 执行任务\n请告诉我你需要什么帮助！';
  }
  
  return `收到你的消息："${message}"\n\n我是 xbclaw，一个正在进化的 AI 助手。我正在学习如何更好地帮助你！`;
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`SeaTalk Bot listening on port ${PORT}`);
});

process.on('uncaughtException', (e) => {
  console.error('Uncaught:', e);
});
