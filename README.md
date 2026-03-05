# SeaTalk Bot for OpenClaw

<div align="center">

**A production-ready SeaTalk integration for OpenClaw AI Assistant**

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/template/seatalk-bot)

*Connect your OpenClaw AI to SeaTalk's enterprise messaging platform*

</div>

---

## 🌟 Features

- **🤖 Multi-Bot Support** - Run multiple SeaTalk bots from a single instance
- **🔗 OpenClaw Bridge** - Seamless integration with OpenClaw Gateway
- **📨 Message Queue** - Passive mode for manual message handling
- **🔐 Secure Webhooks** - HMAC signature verification for all callbacks
- **☁️ Cloud-Ready** - One-click deploy to Railway with zero configuration
- **🏢 Enterprise-Grade** - Built for SeaTalk's enterprise messaging platform

---

## 🚀 Quick Start

### Option 1: Deploy to Railway (Recommended)

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/template/seatalk-bot)

1. Click the button above
2. Set environment variables (see [Configuration](#-configuration))
3. Deploy and copy your webhook URL
4. Configure callback URL in SeaTalk Open Platform

### Option 2: Local Development

```bash
# Clone the repository
git clone https://github.com/xingbo778/seatalk-bot.git
cd seatalk-bot

# Set environment variables
export SEATALK_APP_ID="your_app_id"
export SEATALK_APP_SECRET="your_app_secret"
export OPENCLAW_GATEWAY_URL="https://your-openclaw-instance.com"

# Start the server
node server.js
```

Server will start on port `8080` (or `$PORT` if set).

---

## ⚙️ Configuration

### Single-Bot Mode (Legacy)

Use these environment variables for a simple single-bot deployment:

| Variable | Required | Description |
|----------|----------|-------------|
| `SEATALK_APP_ID` | ✅ | SeaTalk App ID from open.seatalk.io |
| `SEATALK_APP_SECRET` | ✅ | SeaTalk App Secret |
| `OPENCLAW_GATEWAY_URL` | ⚠️ | OpenClaw Gateway URL (for bridge mode) |
| `OPENCLAW_API_KEY` | ⚠️ | OpenClaw API key (if auth enabled) |
| `SETUP_PASSWORD` | ⚠️ | Admin password for setup endpoints |
| `PORT` | ❌ | HTTP port (default: 8080) |

### Multi-Bot Mode (Advanced)

For running multiple bots on a single instance:

```json
{
  "BOTS": [
    {
      "id": "bot1",
      "seatalk_app_id": "MTQxOTg1...",
      "seatalk_app_secret": "mVnKeCZ0...",
      "openclaw_url": "https://openclaw-1.up.railway.app",
      "openclaw_api_key": "sk-...",
      "setup_password": "admin123"
    },
    {
      "id": "bot2",
      "seatalk_app_id": "MTQyMDIw...",
      "seatalk_app_secret": "xYz123...",
      "openclaw_url": "https://openclaw-2.up.railway.app"
    }
  ]
}
```

**Note:** Set this as the `BOTS` environment variable (JSON string).

---

## 🏗️ Architecture

### Bridge Mode (Default)

```
SeaTalk User → SeaTalk Platform → Bot Server → OpenClaw Gateway
                                              ← AI Response
```

When `OPENCLAW_GATEWAY_URL` is set, messages are automatically forwarded to OpenClaw for AI processing.

### Queue Mode (Passive)

```
SeaTalk User → SeaTalk Platform → Bot Server → Message Queue
                                              (manual retrieval via API)
```

Without `OPENCLAW_GATEWAY_URL`, messages are queued for manual handling.

---

## 📡 API Endpoints

### Health Check

```http
GET /health
```

Returns server status and configured bots.

**Response:**
```json
{
  "status": "ok",
  "bots": [
    {
      "id": "bot1",
      "mode": "BRIDGE",
      "openclaw_url": "https://openclaw.example.com"
    }
  ]
}
```

### SeaTalk Webhook

```http
POST /bot/:botId/callback
POST /seatalk/callback  (legacy, auto-routed by app_id)
```

Receives events from SeaTalk platform:
- Message from bot user
- Bot added to group
- Mentioned in group message
- Bot removed from group

**Webhook verification:**
```http
GET /bot/:botId/callback?seatalk_challenge=xxx
```

Returns the challenge value for SeaTalk platform verification.

### Message Queue (Queue Mode Only)

```http
GET /bot/:botId/messages?password=xxx
```

Retrieves queued messages for manual processing.

**Query Parameters:**
- `password` - Setup password (required)

**Response:**
```json
{
  "bot_id": "bot1",
  "messages": [
    {
      "id": 1,
      "open_conversation_id": "...",
      "sender_id": "...",
      "text": "Hello bot!"
    }
  ]
}
```

### Send Reply (Queue Mode Only)

```http
POST /bot/:botId/send
Content-Type: application/json

{
  "password": "your_setup_password",
  "open_conversation_id": "oc_...",
  "text": "Hello from bot!"
}
```

Sends a message back to a SeaTalk conversation.

---

## 🔧 SeaTalk Platform Setup

### 1. Create Application

1. Visit [SeaTalk Open Platform](https://open.seatalk.io)
2. Click **"Create app"** or **"Start building"**
3. Fill in basic info:
   - **App Name:** `OpenClaw AI Assistant`
   - **Description:** `AI-powered assistant for SeaTalk`
   - **Category:** Productivity

### 2. Enable Bot Capability

1. In app settings, find the **Bot** card
2. Click **"Enable"** button
3. Save your credentials:
   - App ID
   - App Secret
   - Verification Token (optional, for signature verification)

### 3. Configure Webhook

1. Go to **Advanced Settings → Event Callback**
2. Set callback URL:
   ```
   https://your-server.com/bot/bot1/callback
   ```
   (Replace `your-server.com` and `bot1` with your actual domain and bot ID)

3. Enable required events:
   - ✅ **Message Received From Bot User**
   - ✅ **Bot Added to Group Chat**
   - ✅ **New Mentioned Message Received From Group Chat**
   - ✅ **Bot Removed From Group Chat**

4. Save and verify the webhook (server must be running)

### 4. Test Your Bot

1. Find your bot in SeaTalk app
2. Send a message
3. Check server logs for incoming webhook
4. (Bridge mode) Receive AI-generated response

---

## 🛠️ Development

### Project Structure

```
seatalk-bot/
├── server.js           # Main server + webhook handler
├── package.json        # Node.js dependencies
├── Dockerfile          # Container image
├── railway.toml        # Railway deployment config
├── README.md           # You are here
├── SETUP.md            # Detailed setup guide
└── RAILWAY_DEPLOY.md   # Railway troubleshooting
```

### Key Code Sections

**Authentication:**
```javascript
// Automatic token refresh with expiry tracking
async function getAccessToken(bot) {
  const state = botState.get(bot.id);
  if (state.accessToken && Date.now() < state.tokenExpiry) {
    return state.accessToken;
  }
  // ... fetch new token from SeaTalk
}
```

**Webhook Verification:**
```javascript
// HMAC signature verification (when enabled)
function verifySignature(secret, body, signature) {
  const expected = crypto.createHmac('sha256', secret)
    .update(body)
    .digest('hex');
  return signature === expected;
}
```

**Bridge to OpenClaw:**
```javascript
// Forward message to OpenClaw Gateway
async function sendToOpenClaw(bot, conversationId, messageText) {
  const response = await fetch(`${bot.openclaw_url}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${bot.openclaw_api_key}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      messages: [{ role: 'user', content: messageText }],
      stream: false
    })
  });
  // ... parse and send reply
}
```

---

## 📚 Additional Documentation

- **[SETUP.md](SETUP.md)** - Detailed step-by-step setup guide
- **[RAILWAY_DEPLOY.md](RAILWAY_DEPLOY.md)** - Railway deployment troubleshooting
- **[SeaTalk API Docs](https://open.seatalk.io/docs)** - Official SeaTalk API reference
- **[OpenClaw Docs](https://docs.openclaw.ai)** - OpenClaw AI framework documentation

---

## 🔒 Security Best Practices

1. **Environment Variables:** Never commit secrets to Git
2. **HTTPS Only:** Always use HTTPS for webhook URLs in production
3. **Signature Verification:** Enable webhook signature verification in SeaTalk platform
4. **Setup Password:** Set a strong `SETUP_PASSWORD` for queue mode endpoints
5. **API Key Rotation:** Regularly rotate OpenClaw API keys

---

## 🐛 Troubleshooting

### Bot doesn't respond

**Check:**
1. Is `OPENCLAW_GATEWAY_URL` set correctly?
2. Is OpenClaw instance running and accessible?
3. Check server logs for errors: `railway logs`

### 502 Bad Gateway on Railway

**Solution:** Add missing environment variables in Railway dashboard:
1. Open project → **Variables** tab
2. Add `SEATALK_APP_ID` and `SEATALK_APP_SECRET`
3. Click **Redeploy**

See [RAILWAY_DEPLOY.md](RAILWAY_DEPLOY.md) for detailed fix.

### Webhook verification fails

**Check:**
1. Callback URL matches exactly (no trailing slash)
2. Server is publicly accessible via HTTPS
3. SeaTalk can reach your server (check firewall)

### Messages not reaching OpenClaw

**Debug:**
1. Check OpenClaw logs for incoming requests
2. Verify API key is correct
3. Test OpenClaw endpoint manually: `curl $OPENCLAW_GATEWAY_URL/health`

---

## 🤝 Contributing

Contributions welcome! Please:

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/amazing-feature`
3. Commit changes: `git commit -m 'Add amazing feature'`
4. Push to branch: `git push origin feature/amazing-feature`
5. Open a Pull Request

---

## 📄 License

MIT License - see [LICENSE](LICENSE) for details

---

## 🔗 Links

- **GitHub:** [xingbo778/seatalk-bot](https://github.com/xingbo778/seatalk-bot)
- **OpenClaw:** [openclaw/openclaw](https://github.com/openclaw/openclaw)
- **SeaTalk Platform:** [open.seatalk.io](https://open.seatalk.io)
- **Railway Template:** [Deploy Now](https://railway.app/template/seatalk-bot)

---

<div align="center">

**Made with ❤️ by the OpenClaw Community**

[Report Bug](https://github.com/xingbo778/seatalk-bot/issues) · [Request Feature](https://github.com/xingbo778/seatalk-bot/issues)

</div>
