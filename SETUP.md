# SeaTalk Bot 配置指南

## 设置步骤

### 第一步：创建 SeaTalk 应用

1. 访问 https://open.seatalk.io
2. 点击 "Create app" 或 "Start building"
3. 填写基本信息：
   - App Name: `xbclaw-bot` (或你喜欢的名字)
   - Description: `OpenClaw AI Assistant Bot`
   - Category: 选择合适的分类

### 第二步：启用 Bot 能力

1. 在 App 设置页面找到 "Bot" 卡片
2. 点击 "Enable" 按钮
3. 记录以下凭证：
   - App ID
   - App Secret
   - Verification Token

### 第三步：配置凭证

编辑 `/home/node/.openclaw/seatalk/.env`:

```env
SEATALK_APP_ID=your_actual_app_id
SEATALK_APP_SECRET=your_actual_app_secret
SEATALK_VERIFICATION_TOKEN=your_actual_token
SEATALK_CALLBACK_URL=https://your-server.com/seatalk/callback
```

### 第四步：部署服务器

```bash
cd /home/node/.openclaw/seatalk
npm install express  # 如果没有安装
node server.js       # 启动服务器
```

### 第五步：配置回调 URL

在 SeaTalk 开放平台：
1. 进入 Advanced Settings → Event Callback
2. 设置回调 URL: `https://your-server.com/seatalk/callback`
3. 启用需要的事件：
   - ✅ Message Received From Bot User
   - ✅ Bot Added to Group Chat
   - ✅ New Mentioned Message Received From Group Chat
   - ✅ Bot Removed From Group Chat

### 第六步：测试

发送消息给你的 Bot，检查是否收到回调。

---

## 文件位置

| 文件 | 用途 |
|------|------|
| `~/.openclaw/skills/seatalk-bot/SKILL.md` | SeaTalk Bot 技能文档 |
| `~/.openclaw/seatalk/server.js` | Bot 服务器代码 |
| `~/.openclaw/seatalk/.env` | 凭证配置 |
| `~/.openclaw/seatalk/config.json` | 配置文件 |

---

## 下一步

你需要：
1. 在 open.seatalk.io 创建应用
2. 获取 App ID、Secret、Token
3. 填入 `.env` 文件
4. 部署到公网服务器（需要 HTTPS）

需要我帮你完成哪一步？