const http = require('http');

const PORT = process.env.PORT || 8080;

console.log(`Starting SeaTalk Bot on port ${PORT}...`);

const server = http.createServer((req, res) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.url}`);
  
  try {
    // Health check
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', time: Date.now() }));
      return;
    }
    
    // SeaTalk callback
    if (req.url === '/seatalk/callback') {
      if (req.method === 'GET') {
        // GET 验证 (query param)
        const url = new URL(req.url, `http://localhost:${PORT}`);
        const challenge = url.searchParams.get('seatalk_challenge') || url.searchParams.get('challenge');
        if (challenge) {
          console.log(`GET challenge: ${challenge}`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ seatalk_challenge: challenge }));
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ status: 'ok' }));
      }
      
      if (req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
          console.log(`POST body: ${body}`);
          
          try {
            const data = JSON.parse(body);
            
            // SeaTalk verification format: event.seatalk_challenge
            let challenge = null;
            
            // Try event.seatalk_challenge (SeaTalk format)
            if (data.event && data.event.seatalk_challenge) {
              challenge = data.event.seatalk_challenge;
              console.log(`SeaTalk verification challenge: ${challenge}`);
            }
            // Try root level seatalk_challenge
            else if (data.seatalk_challenge) {
              challenge = data.seatalk_challenge;
              console.log(`Root challenge: ${challenge}`);
            }
            
            if (challenge) {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              return res.end(JSON.stringify({ seatalk_challenge: challenge }));
            }
            
            // Handle other events
            const eventType = data.event_type;
            console.log(`Event type: ${eventType}`);
            
            switch (eventType) {
              case 'event_verification':
                // Already handled above
                break;
              case 'new_bot_subscriber':
                console.log('New subscriber!');
                break;
              case 'message_from_bot_subscriber':
                console.log('Message from subscriber:', data.event);
                break;
              case 'bot_added_to_group_chat':
                console.log('Added to group:', data.event);
                break;
              case 'new_mentioned_message_received_from_group_chat':
                console.log('Mentioned in group:', data.event);
                break;
              default:
                console.log('Unknown event:', eventType);
            }
            
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'ok' }));
          } catch (e) {
            console.error('Parse error:', e);
            res.writeHead(400);
            res.end(JSON.stringify({ error: e.message }));
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

server.listen(PORT, '0.0.0.0', () => {
  console.log(`SeaTalk Bot listening on port ${PORT}`);
});

process.on('uncaughtException', (e) => {
  console.error('Uncaught:', e);
});
