const http = require('http');
const crypto = require('crypto');
const url = require('url');
const fs = require('fs');
const path = require('path');

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
const VERIFICATION_TOKEN = process.env.SEATALK_VERIFICATION_TOKEN || config.SEATALK_VERIFICATION_TOKEN || '';

// Store conversations
const conversations = new Map();

const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  console.log(`[${new Date().toISOString()}] ${req.method} ${pathname}`);

  // Health check
  if (pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
  }

  // URL verification for SeaTalk
  if (pathname === '/seatalk/callback' && req.method === 'GET') {
    const challenge = parsedUrl.query.challenge;
    if (challenge) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ challenge }));
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'ok' }));
  }

  // Handle events
  if (pathname === '/seatalk/callback' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        // Verify signature
        const signature = req.headers['x-seatalk-signature'];
        if (APP_SECRET && signature) {
          const expected = crypto
            .createHmac('sha256', APP_SECRET)
            .update(body)
            .digest('hex');
          if (signature !== expected) {
            res.writeHead(401);
            return res.end('Invalid signature');
          }
        }

        const data = JSON.parse(body);
        console.log('Event:', JSON.stringify(data, null, 2));

        // Handle different event types
        const eventType = data.event_type;
        let response = { status: 'ok' };

        switch (eventType) {
          case 'message_received':
            // 1-on-1 message
            const userId = data.event?.sender?.id;
            const message = data.event?.message?.text;
            console.log(`Message from ${userId}: ${message}`);
            
            // Store conversation
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
        res.end(JSON.stringify(response));
      } catch (e) {
        console.error('Error:', e);
        res.writeHead(500);
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Default
  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`SeaTalk Bot Server running on port ${PORT}`);
  console.log(`Health: http://localhost:${PORT}/health`);
  console.log(`Callback: http://localhost:${PORT}/seatalk/callback`);
});

module.exports = { server, conversations };
