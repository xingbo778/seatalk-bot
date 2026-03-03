const http = require('http');

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  
  // Health check
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
  }
  
  // SeaTalk callback
  if (req.url.startsWith('/seatalk/callback')) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const challenge = url.searchParams.get('seatalk_challenge') || url.searchParams.get('challenge');
    
    if (challenge) {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end(challenge);
    }
    
    if (req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        console.log('POST body:', body);
        // Try to parse challenge from body
        try {
          const data = JSON.parse(body);
          if (data.seatalk_challenge) {
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            return res.end(String(data.seatalk_challenge));
          }
        } catch (e) {
          // Try form data
          if (body.includes('seatalk_challenge')) {
            const match = body.match(/seatalk_challenge=([^&]+)/);
            if (match) {
              res.writeHead(200, { 'Content-Type': 'text/plain' });
              return res.end(decodeURIComponent(match[1]));
            }
          }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
      });
      return;
    }
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'ok' }));
  }
  
  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`SeaTalk Bot running on port ${PORT}`);
});
