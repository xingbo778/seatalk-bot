# SeaTalk Bot Integration Skill

> A skill definition for integrating SeaTalk enterprise messaging bot with AI agent platforms (OpenClaw, Claude Code, Dify, Coze, AutoGPT, etc.)

---

## Skill Metadata

```yaml
name: seatalk-bot
version: 1.0.0
description: SeaTalk enterprise messaging bot that bridges user conversations to AI agents via webhook
author: seatalk-bot
license: MIT
tags:
  - seatalk
  - enterprise-messaging
  - chatbot
  - webhook
  - openclaw
platforms:
  - openclaw
  - claude-code
  - dify
  - coze
  - autogpt
  - langchain
```

---

## Overview

This skill enables AI agents to receive and respond to messages from SeaTalk (enterprise messaging platform) users. It acts as a **webhook-based bridge** between SeaTalk and any AI agent backend.

### Capabilities

| Capability | Description |
|-----------|-------------|
| **Receive DMs** | Receive private messages from SeaTalk users who subscribe to the bot |
| **Receive Group @mentions** | Respond when mentioned in group chats |
| **Send Messages** | Send text replies to individual users or group chats |
| **Multi-Bot** | Run multiple bot instances from a single deployment |
| **Typing Indicator** | Show "typing..." while processing |

---

## Architecture

```
┌──────────────┐    Webhook     ┌──────────────────┐    HTTP/REST    ┌────────────────┐
│  SeaTalk     │ ──────────────→│  SeaTalk Bot     │ ──────────────→│  AI Agent      │
│  Platform    │←───────────────│  (this skill)    │←───────────────│  Backend       │
│              │   SeaTalk API  │  Node.js/8080    │   Response     │  (OpenClaw/    │
└──────────────┘                └──────────────────┘                │   Dify/etc.)   │
                                                                    └────────────────┘
```

---

## Integration Guide

### For OpenClaw

**1. Environment Configuration:**

```bash
# Single bot
SEATALK_APP_ID=your_app_id
SEATALK_APP_SECRET=your_app_secret
OPENCLAW_GATEWAY_URL=https://your-openclaw-instance.up.railway.app
SETUP_PASSWORD=your_admin_password

# Multi-bot (JSON array in BOTS env var)
BOTS='[{"id":"bot1","seatalk_app_id":"...","seatalk_app_secret":"...","openclaw_url":"https://...","setup_password":"..."}]'
```

**2. OpenClaw Agent Message Format:**

The skill sends messages to OpenClaw using this payload:

```json
POST /setup/api/console/run
Authorization: Basic base64(user:setup_password)
Content-Type: application/json

{
  "command": "openclaw.agent.message",
  "arg": "{\"agent\": \"main\", \"message\": \"user's question\"}"
}
```

**3. Expected Response Format:**

```json
{
  "ok": true,
  "output": "The agent's response text"
}
```

---

### For Claude Code / Claude Agent SDK

Use this skill as an MCP-compatible tool or invoke via webhook:

**Tool Definition:**

```json
{
  "name": "seatalk_send_message",
  "description": "Send a message to a SeaTalk user via the bot",
  "input_schema": {
    "type": "object",
    "properties": {
      "user_id": {
        "type": "string",
        "description": "The employee_code of the target SeaTalk user"
      },
      "message": {
        "type": "string",
        "description": "The text message to send"
      },
      "bot_id": {
        "type": "string",
        "description": "Bot instance ID (default: first configured bot)"
      }
    },
    "required": ["user_id", "message"]
  }
}
```

**Invoke via REST:**

```bash
curl -X POST https://your-seatalk-bot.up.railway.app/send?bot=bot1 \
  -H "Content-Type: application/json" \
  -d '{"user_id": "employee_code_here", "message": "Hello from Claude!"}'
```

---

### For Dify / Coze / Generic Agent Platforms

**Webhook Endpoint Configuration:**

| Setting | Value |
|---------|-------|
| Webhook URL | `https://your-domain.com/bot/{botId}/callback` |
| Method | POST |
| Auth | HMAC-SHA256 signature in `x-seatalk-signature` header |
| Content-Type | application/json |

**Incoming Webhook Payload (DM):**

```json
{
  "event_type": "message_from_bot_subscriber",
  "app_id": "your_app_id",
  "event": {
    "seatalk_id": "user_seatalk_id",
    "employee_code": "EMP001",
    "message": {
      "text": {
        "content": "Hello, I need help with..."
      }
    }
  }
}
```

**Incoming Webhook Payload (Group @mention):**

```json
{
  "event_type": "new_mentioned_message_received_from_group_chat",
  "app_id": "your_app_id",
  "event": {
    "group_id": "group_chat_id",
    "message": {
      "sender": {
        "seatalk_id": "user_id",
        "employee_code": "EMP001"
      },
      "text": {
        "plain_text": "@BotName what is the weather?",
        "mentioned_list": [{"username": "BotName"}]
      }
    }
  }
}
```

**Queue Mode (Polling):**

If your agent platform prefers polling over webhook push:

```bash
# Poll for new messages
GET /poll?bot=bot1&last_id=0&timeout=5000
Authorization: Bearer your_api_key

# Response
{"messages": [{"id": 1, "sender_id": "...", "employee_code": "...", "message": "...", "timestamp": 1709780000000}]}

# Send reply
POST /send?bot=bot1
{"user_id": "employee_code", "message": "reply text"}
```

---

## API Reference

### Endpoints

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| `GET` | `/health` | Health check, returns bot list | None |
| `POST` | `/bot/{botId}/callback` | Webhook receiver for SeaTalk events | HMAC Signature |
| `POST` | `/seatalk/callback` | Legacy webhook (auto-routes by app_id) | HMAC Signature |
| `GET` | `/poll?bot={botId}` | Long-poll for queued messages | Bearer Token |
| `POST` | `/send?bot={botId}` | Send message to a user | None |

### Health Check Response

```json
{
  "status": "ok",
  "time": 1709780000000,
  "bots": [
    {"id": "bot1", "bridge": true},
    {"id": "bot2", "bridge": false}
  ]
}
```

---

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

### Railway (One-Click)

1. Fork/import this repository
2. Create new project on Railway
3. Set environment variables
4. Deploy — Railway auto-detects Dockerfile

### Heroku

```bash
heroku create
heroku config:set SEATALK_APP_ID=... SEATALK_APP_SECRET=...
git push heroku main
```

---

## Custom Agent Backend Integration

To integrate with **any** AI agent backend, implement an HTTP endpoint that:

1. **Accepts** POST requests with `Content-Type: application/json`
2. **Receives** a payload containing the user message
3. **Returns** a JSON response with the agent's reply

Then configure the bot to forward messages to your endpoint by setting `openclaw_url` to your backend URL.

**Minimal Backend Example (Express):**

```javascript
app.post('/setup/api/console/run', (req, res) => {
  const { command, arg } = req.body;
  const { message } = JSON.parse(arg);

  // Process with your AI agent
  const reply = await yourAgent.chat(message);

  res.json({ ok: true, output: reply });
});
```

**Adapt for other formats:**

If your agent backend uses a different API format, modify the `askOpenClaw()` function in `server.js` (lines 239-276) to match your backend's request/response schema.

---

## Configuration Reference

| Environment Variable | Required | Default | Description |
|---------------------|----------|---------|-------------|
| `SEATALK_APP_ID` | Yes* | — | SeaTalk app ID (single-bot mode) |
| `SEATALK_APP_SECRET` | Yes* | — | SeaTalk app secret (single-bot mode) |
| `BOTS` | Yes* | — | JSON array of bot configs (multi-bot mode) |
| `OPENCLAW_GATEWAY_URL` | No | — | AI agent backend URL (enables bridge mode) |
| `OPENCLAW_API_KEY` | No | — | API key for poll/send authentication |
| `SETUP_PASSWORD` | No | — | Password for OpenClaw Basic auth |
| `PORT` | No | 8080 | HTTP server port |

\* Either `SEATALK_APP_ID` + `SEATALK_APP_SECRET` or `BOTS` is required.

---

## SeaTalk App Setup

1. Go to [SeaTalk Open Platform](https://open.seatalk.io)
2. Create a new Bot application
3. Note down `App ID` and `App Secret`
4. Set webhook URL to `https://your-domain.com/bot/{botId}/callback`
5. Subscribe to events:
   - `message_from_bot_subscriber` (DMs)
   - `new_mentioned_message_received_from_group_chat` (Group mentions)
6. Publish the bot

---

## Limitations & Known Issues

- **No message persistence**: Queue mode stores messages in-memory only; they are lost on restart
- **Text only**: Currently supports text messages only (no images, files, or cards)
- **No conversation history**: Each message is treated independently; no context window
- **Single-instance**: Message queue is not shared across instances; use sticky sessions for horizontal scaling
- **120s timeout**: Long-running agent responses may time out

---

## License

MIT
