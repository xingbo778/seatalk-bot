# SeaTalk Bot Railway 部署指南

## 问题：502 Application failed to respond

### 原因
缺少环境变量导致应用启动失败。

### 解决方案

1. **打开 Railway 项目**
   ```
   https://railway.app/project/seatalk-bot
   ```

2. **添加环境变量**
   - 点击服务 "web"
   - 进入 **Variables** 标签
   - 点击 **Add Variable**
   - 添加以下变量：

   ```
   SEATALK_APP_ID = MTQxOTg1MDAyMTc1
   SEATALK_APP_SECRET = mVnKeCZ0wzBjGxib3jJKaUvzIah3xfdQ
   ```

3. **重新部署**
   - 进入 **Deployments** 标签
   - 点击最新部署的 **Redeploy** 按钮

4. **等待部署完成**
   - 状态变为 SUCCESS 后
   - 测试：https://web-production-46cda.up.railway.app/health

---

## 回调 URL

部署成功后，在 SeaTalk 平台配置：
```
https://web-production-46cda.up.railway.app/seatalk/callback
```

---

## 当前状态

| 项目 | 状态 |
|------|------|
| GitHub 仓库 | ✅ 已推送 |
| Railway 项目 | ✅ 已创建 |
| Railway 域名 | ✅ 已生成 |
| 部署 | ✅ SUCCESS |
| 环境变量 | ❌ 缺失 |
| 服务启动 | ❌ 502错误 |