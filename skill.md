# SeaTalk Bot Integration Skill

> SeaTalk enterprise messaging bot that bridges user conversations to AI agents via webhook.

## Capabilities

| Capability | Description |
|-----------|-------------|
| **Receive DMs** | Receive private messages from bot subscribers |
| **Receive Group @mentions** | Respond when mentioned in group chats |
| **Send Messages** | Send text replies to users or groups |
| **Multi-Bot** | Multiple bot instances from a single deployment |
| **Typing Indicator** | Show "typing..." while processing |

## Architecture

```
SeaTalk Platform  ──webhook──▶  SeaTalk Bot (Node.js)  ──HTTP──▶  AI Backend
                  ◀─SeaTalk API─                       ◀─response─  (OpenClaw/ADK/etc.)
```

## Quick Start

### Environment Variables

```bash
# Single bot
SEATALK_APP_ID=your_app_id
SEATALK_APP_SECRET=your_app_secret
OPENCLAW_GATEWAY_URL=https://your-openclaw-instance.up.railway.app
SETUP_PASSWORD=your_admin_password
OPENCLAW_API_KEY=your_api_key    # Secures /poll and /send endpoints

# Multi-bot (JSON array)
BOTS='[{"id":"bot1","seatalk_app_id":"...","seatalk_app_secret":"...","openclaw_url":"https://...","setup_password":"...","openclaw_api_key":"..."}]'
```

### Full Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SEATALK_APP_ID` | Yes* | — | SeaTalk app ID (single-bot mode) |
| `SEATALK_APP_SECRET` | Yes* | — | SeaTalk app secret (single-bot mode) |
| `BOTS` | Yes* | — | JSON array of bot configs (multi-bot mode) |
| `OPENCLAW_GATEWAY_URL` | No | — | AI backend URL (enables bridge mode) |
| `OPENCLAW_API_KEY` | No | — | API key for /poll and /send authentication |
| `SETUP_PASSWORD` | No | — | Password for OpenClaw Basic auth |
| `PORT` | No | 8080 | HTTP server port |

\* Either `SEATALK_APP_ID` + `SEATALK_APP_SECRET` or `BOTS` is required.

## API Endpoints

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| `GET` | `/health` | Health check | None |
| `POST` | `/bot/{botId}/callback` | Webhook for SeaTalk events | HMAC Signature |
| `POST` | `/seatalk/callback` | Legacy webhook (auto-routes by app_id) | HMAC Signature |
| `GET` | `/poll?bot={botId}` | Long-poll for queued messages | Bearer Token |
| `POST` | `/send?bot={botId}` | Send message to a user | Bearer Token |

### Queue Mode (Polling)

For agent platforms that prefer polling over webhook push:

```bash
# Poll for new messages
GET /poll?bot=bot1&last_id=0&timeout=5000
Authorization: Bearer your_api_key

# Send reply
POST /send?bot=bot1
Authorization: Bearer your_api_key
Content-Type: application/json
{"user_id": "employee_code", "message": "reply text"}
```

## Deployment

### Docker

```bash
docker build -t seatalk-bot .
docker run -p 8080:8080 \
  -e SEATALK_APP_ID=your_id \
  -e SEATALK_APP_SECRET=your_secret \
  -e OPENCLAW_GATEWAY_URL=https://your-agent.com \
  seatalk-bot
```

### Railway

1. Fork/import this repository
2. Create new project on Railway
3. Set environment variables
4. Deploy — Railway auto-detects Dockerfile

## SeaTalk App Setup

1. Go to [SeaTalk Open Platform](https://open.seatalk.io)
2. Create a new Bot application
3. Note down `App ID` and `App Secret`
4. Set webhook URL to `https://your-domain.com/bot/{botId}/callback`
5. Subscribe to events:
   - `message_from_bot_subscriber` (DMs)
   - `new_mentioned_message_received_from_group_chat` (Group mentions)
6. Publish the bot

## Limitations

- **No message persistence**: Queue mode stores messages in-memory; lost on restart
- **Text only**: No images, files, or cards
- **No conversation history**: Each message is independent
- **Single-instance**: Message queue not shared across instances
- **Timeout**: Default 30s HTTP timeout, 60s for AI backend requests

## License

MIT
