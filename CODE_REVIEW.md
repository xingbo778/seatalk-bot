# SeaTalk Bot - Code Review Report

## 项目概述

SeaTalk Bot 是一个 Node.js 服务，用于将 SeaTalk 企业通讯平台与 OpenClaw AI 助手集成。支持多机器人实例、Bridge 模式（AI 自动回复）和 Queue 模式（被动消息收集）。

**技术栈：** Node.js 18，纯内置模块（无第三方依赖）

---

## 架构评价

### 优点
- **零依赖**：仅使用 Node.js 内置模块，攻击面极小，部署简单
- **多机器人设计**：通过 `BOTS` 环境变量配置多个 bot，共享单一服务实例
- **签名验证**：使用 HMAC-SHA256 + `timingSafeEqual` 防止时序攻击，实现规范
- **向后兼容**：单机器人模式和多机器人模式共存，平滑迁移
- **请求体大小限制**：`MAX_BODY_SIZE = 1MB`，防止 DoS

### 需要注意

| 严重度 | 问题 | 位置 | 建议 |
|--------|------|------|------|
| **严重** | 签名验证可被跳过 | `server.js:312` | `if (signature && ...)` — 当请求没有 `x-seatalk-signature` 头时，签名验证被完全跳过。应改为：无签名 → 拒绝请求（`event_verification` 除外） |
| **严重** | Token 竞态条件 | `server.js:128-162` | 多个并发请求可能同时触发 token 刷新，导致重复的 API 调用。建议引入 Promise 锁 |
| **高** | 内存队列无持久化 | `server.js:335-336` | 消息队列存在内存中，服务重启后全部丢失。生产环境应使用 Redis 或数据库 |
| **高** | OpenClaw 认证使用 setup_password | `server.js:242` | `Basic user:setup_password` — 应使用专用 API Key，而非管理密码 |
| **中** | 无速率限制 | 全局 | webhook 端点没有任何限流，可能遭受滥用 |
| **中** | 无输入校验 | `server.js:321,347` | 用户消息内容未做长度或格式校验，直接转发给 OpenClaw |
| **中** | 响应清洗依赖硬编码正则 | `server.js:264` | OpenClaw 输出格式变更将导致清洗逻辑失效 |
| **中** | Poll 端点可能无认证 | `server.js:463-467` | 未设置 `openclaw_api_key` 时，任何人可读取消息队列 |
| **低** | HTTP 超时过长 | `server.js:119` | 120 秒超时，如果 OpenClaw 响应缓慢会长期占用连接 |
| **低** | 无结构化日志 | 全局 | 全部使用 `console.log`，无日志级别、无 JSON 格式，生产环境难以检索 |
| **低** | `server.js.bak` 残留 | 根目录 | 归档文件应删除或移到 archive 目录 |

---

## 关键代码片段审查

### 1. 签名验证漏洞 (server.js:310-315)

```javascript
// 当前实现 - signature 为空时跳过验证
const signature = req.headers['x-seatalk-signature'];
if (signature && !verifySignature(bot.seatalk_app_secret, body, signature)) {
  res.writeHead(401);
  return res.end(JSON.stringify({ error: 'Invalid signature' }));
}
```

**建议修复：**
```javascript
const signature = req.headers['x-seatalk-signature'];
if (!signature) {
  console.warn(`[${bot.id}] Missing signature header`);
  res.writeHead(401);
  return res.end(JSON.stringify({ error: 'Missing signature' }));
}
if (!verifySignature(bot.seatalk_app_secret, body, signature)) {
  res.writeHead(401);
  return res.end(JSON.stringify({ error: 'Invalid signature' }));
}
```

### 2. Token 刷新竞态 (server.js:128-162)

```javascript
// 当前：多个请求可能同时进入 token 刷新
async function getAccessToken(bot) {
  const state = botState.get(bot.id);
  if (state.accessToken && Date.now() < state.tokenExpiry) return state.accessToken;
  // ↑ 多个并发请求都会到达这里并同时发起 token 请求
```

**建议修复：**
```javascript
async function getAccessToken(bot) {
  const state = botState.get(bot.id);
  if (state.accessToken && Date.now() < state.tokenExpiry) return state.accessToken;
  // Promise 锁：复用正在进行的刷新请求
  if (state._refreshPromise) return state._refreshPromise;
  state._refreshPromise = refreshToken(bot, state).finally(() => {
    state._refreshPromise = null;
  });
  return state._refreshPromise;
}
```

### 3. @mention 清洗可能引入 ReDoS (server.js:352-354)

```javascript
for (const m of mentionedList) {
  if (m.username) {
    cleanMessage = cleanMessage.replace(new RegExp(`@${m.username}\\s*`, 'g'), '');
  }
}
```

`m.username` 来自外部输入，直接用于正则构造，可能导致 ReDoS 攻击。应对 username 做转义：

```javascript
function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
cleanMessage = cleanMessage.replace(new RegExp(`@${escapeRegex(m.username)}\\s*`, 'g'), '');
```

---

## 总结

代码整体结构清晰，功能完整。零依赖是亮点，降低了供应链风险。主要需要关注的是：
1. **签名验证逻辑** — 安全漏洞，优先修复
2. **ReDoS 风险** — 用户名注入正则，需转义
3. **Token 竞态** — 并发场景下的稳定性
4. **消息持久化** — 生产环境必须解决的可靠性问题
