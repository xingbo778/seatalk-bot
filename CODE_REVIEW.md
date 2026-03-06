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

| 严重度 | 问题 | 状态 | 说明 |
|--------|------|------|------|
| **严重** | 签名验证可被跳过 | ✅ 已修复 | 无签名请求现在返回 401 |
| **严重** | Token 竞态条件 | ✅ 已修复 | 引入 Promise 锁，复用进行中的刷新请求 |
| **高** | 内存队列无持久化 | ⬚ 待定 | 消息队列存在内存中，服务重启后丢失。生产环境应使用 Redis 或数据库 |
| **高** | OpenClaw 认证使用 setup_password | ⬚ 待定 | `Basic user:setup_password` — 应使用专用 API Key |
| **中** | 无速率限制 | ⬚ 待定 | webhook 端点没有限流 |
| **中** | 无输入校验 | ✅ 已修复 | 新增 `MAX_MESSAGE_LENGTH = 5000` 截断 |
| **中** | 响应清洗依赖硬编码正则 | ⬚ 待定 | OpenClaw 输出格式变更将导致清洗逻辑失效 |
| **中** | Poll/Send 端点可能无认证 | ⚠ 部分修复 | `/send` 已加认证；未配置 API key 时启动会打印警告 |
| **低** | HTTP 超时过长 | ✅ 已修复 | 默认 30s，AI 后端 60s |
| **低** | 无结构化日志 | ✅ 已修复 | 新增 `log()` 函数，JSON 格式输出 |
| **低** | `server.js.bak` 残留 | ✅ 已修复 | 已删除 |

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

代码整体结构清晰，功能完整。零依赖是亮点，降低了供应链风险。

**已修复（7/11）：** 签名验证、ReDoS、Token 竞态、输入校验、超时、结构化日志、备份文件清理。

**待解决：**
1. **消息持久化** — 生产环境应使用 Redis 或数据库
2. **速率限制** — webhook 端点无限流
3. **OpenClaw 认证方式** — 应使用专用 API Key
4. **响应清洗正则** — 依赖硬编码，易失效
