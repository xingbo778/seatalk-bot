const http = require('http');
const url = require('url');

const PORT = process.env.PORT || 8080;

console.log(`Starting SeaTalk Bot on port ${PORT}...`);

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
      
      // POST 验证和事件
      if (req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
          console.log(`POST body: ${body}`);
          
          try {
            const data = JSON.parse(body);
            
            // SeaTalk 验证格式
            if (data.event && data.event.seatalk_challenge) {
              const challenge = data.event.seatalk_challenge;
              console.log(`SeaTalk verification: ${challenge}`);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              return res.end(JSON.stringify({ seatalk_challenge: challenge }));
            }
            
            // 根级别 challenge
            if (data.seatalk_challenge) {
              console.log(`Root challenge: ${data.seatalk_challenge}`);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              return res.end(JSON.stringify({ seatalk_challenge: data.seatalk_challenge }));
            }
            
            // 处理事件
            const eventType = data.event_type;
            console.log(`Event: ${eventType}`);
            
            // 返回成功
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

server.listen(PORT, '0.0.0.0', () => {
  console.log(`SeaTalk Bot listening on port ${PORT}`);
});
