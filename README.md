# SeaTalk Bot

A simple SeaTalk bot server.

## Local Development

```bash
node server.js
```

## Endpoints

- `GET /health` - Health check
- `GET /seatalk/callback?seatalk_challenge=xxx` - SeaTalk verification
- `POST /seatalk/callback` - SeaTalk events
