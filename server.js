const http = require('http');

const PORT = process.env.PORT || 3000;

console.log(`Starting server on port ${PORT}...`);

const server = http.createServer((req, res) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.url}`);
  
  try {
    // Health check - must respond quickly
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', time: Date.now() }));
      return;
    }
    
    // SeaTalk callback
    if (req.url.startsWith('/seatalk/callback')) {
      const parsedUrl = new URL(req.url, `http://localhost:${PORT}`);
      const challenge = parsedUrl.searchParams.get('seatalk_challenge') || parsedUrl.searchParams.get('challenge');
      
      if (challenge) {
        console.log(`Challenge: ${challenge}`);
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(challenge);
        return;
      }
      
      if (req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
          console.log(`POST body: ${body.substring(0, 200)}`);
          
          // Try JSON
          try {
            const json = JSON.parse(body);
            if (json.seatalk_challenge) {
              res.writeHead(200, { 'Content-Type': 'text/plain' });
              return res.end(String(json.seatalk_challenge));
            }
          } catch (e) {}
          
          // Try form
          const match = body.match(/seatalk_challenge=([^&]+)/);
          if (match) {
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            return res.end(decodeURIComponent(match[1]));
          }
          
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok' }));
        });
        return;
      }
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }
    
    res.writeHead(404);
    res.end('Not found');
  } catch (e) {
    console.error('Error:', e);
    res.writeHead(500);
    res.end('Error');
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on port ${PORT}`);
});

// Keep alive
setInterval(() => {
  console.log(`Heartbeat: ${new Date().toISOString()}`);
}, 60000);

process.on('uncaughtException', (e) => {
  console.error('Uncaught exception:', e);
});
