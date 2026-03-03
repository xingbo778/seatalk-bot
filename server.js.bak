const http = require('http');
const crypto = require('crypto');
const url = require('url');
const fs = require('fs');
const path = require('path');
const querystring = require('querystring');

// Load config
const configPath = path.join(__dirname, '.env');
let config = {};
try {
  const envContent = fs.readFileSync(configPath, 'utf8');
  envContent.split('\n').forEach(line => {
    const [key, ...values] = line.split('=');
    if (key && values.length) {
      config[key.trim()] = values.join('=').trim();
    }
  });
} catch (e) {
  console.log('No .env file found');
}

const PORT = process.env.PORT || config.SEATALK_PORT || 3000;
const APP_SECRET = process.env.SEATALK_APP_SECRET || config.SEATALK_APP_SECRET || '';

// Store conversations
const conversations = new Map();

const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;
  const method = req.method;

  console.log(`[${new Date().toISOString()}] ${method} ${pathname}`);

  // Health check
  if (pathname === '/health' && method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
  }

  // SeaTalk callback - handle both GET and POST
  if (pathname === '/seatalk/callback') {
    
    // GET request - URL verification (query param)
    if (method === 'GET') {
      const challenge = parsedUrl.query.challenge || parsedUrl.query.seatalk_challenge;
      console.log('GET verification, challenge:', challenge);
      if (challenge) {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        return res.end(challenge);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ status: 'ok' }));
    }
    
    // POST request - verification or event
    if (method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        try {
          console.log('POST body:', body.substring(0, 500));
          
          // Try to parse as JSON first
          let data;
          const contentType = req.headers['content-type'] || '';
          
          if (contentType.includes('application/json')) {
            data = JSON.parse(body);
          } else if (contentType.includes('application/x-www-form-urlencoded')) {
            data = querystring.parse(body);
          } else {
            // Try both
            try {
              data = JSON.parse(body);
            } catch {
              data = querystring.parse(body);
            }
          }
          
          // Handle verification challenge
          const challenge = data.seatalk_challenge || data.challenge;
          if (challenge) {
            console.log('POST verification, returning challenge:', challenge);
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            return res.end(String(challenge));
          }
          
          // Verify signature for events
          const signature = req.headers['x-seatalk-signature'];
          if (APP_SECRET && signature) {
            const expected = crypto
              .createHmac('sha256', APP_SECRET)
              .update(body)
              .digest('hex');
            if (signature !== expected) {
              console.log('Invalid signature');
              res.writeHead(401);
              return res.end('Invalid signature');
            }
          }

          console.log('Event:', JSON.stringify(data, null, 2));

          // Handle different event types
          const eventType = data.event_type;

          switch (eventType) {
            case 'message_received':
              const userId = data.event?.sender?.id;
              const message = data.event?.message?.text;
              console.log(`Message from ${userId}: ${message}`);
              
              if (userId && !conversations.has(userId)) {
                conversations.set(userId, { messages: [] });
              }
              if (userId && message) {
                conversations.get(userId).messages.push({
                  role: 'user',
                  text: message,
                  time: new Date().toISOString()
                });
              }
              break;

            case 'bot_added_to_group':
              console.log('Bot added to group:', data.event?.group_id);
              break;

            case 'mentioned_in_group':
              console.log('Mentioned in group:', data.event?.group_id);
              break;

            case 'bot_removed_from_group':
              console.log('Bot removed from group:', data.event?.group_id);
              break;

            default:
              console.log('Unknown event:', eventType);
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok' }));
        } catch (e) {
          console.error('Error:', e);
          res.writeHead(500);
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }
  }

  // Default
  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`SeaTalk Bot Server running on port ${PORT}`);
  console.log(`Health: http://localhost:${PORT}/health`);
  console.log(`Callback: http://localhost:${PORT}/seatalk/callback`);
  console.log('');
  console.log('Verification test:');
  console.log(`  GET ?challenge=xxx -> returns xxx`);
  console.log(`  POST with seatalk_challenge -> returns challenge value`);
});

module.exports = { server, conversations };
