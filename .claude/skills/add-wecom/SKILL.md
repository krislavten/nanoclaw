---
name: add-wecom
description: 添加企业微信（WeCom）channel 支持。运行此 skill 让 NanoClaw 通过企业微信自建应用收发消息。
---

# 添加企业微信 Channel

此 skill 为 NanoClaw 添加企业微信支持，然后引导完成交互式配置。

## Phase 1: 预检

### 检查是否已安装

检查 `src/channels/wecom.ts` 是否存在。如果存在，跳到 Phase 3（配置）。

### 确认用户意图

AskUserQuestion: 你是否已经创建了企业微信自建应用？如果有，请准备好 Corp ID、Agent ID 和 Secret。如果没有，我会引导你创建。

## Phase 2: 合并代码

### 确认文件存在

检查以下文件是否已存在于代码库中：
- `src/channels/wecom.ts` — WeCom channel 实现
- `src/channels/wecom.test.ts` — 单元测试

### 更新 barrel file

确认 `src/channels/index.ts` 中包含：
```typescript
import './wecom.js';
```

如果缺少，添加到 `// wecom` 注释后面。

### 验证构建

```bash
npm install
npm run build
npx vitest run src/channels/wecom.test.ts
```

所有测试必须通过且构建成功后再继续。

## Phase 3: 企业微信应用配置

### 创建自建应用（如需要）

引导用户：

> 我需要你在企业微信管理后台创建一个自建应用：
>
> 1. 登录 [企业微信管理后台](https://work.weixin.qq.com/wework_admin/frame)
> 2. 进入 **应用管理** → **自建** → **创建应用**
>    - 应用名称：如 "Andy 助手"
>    - 应用logo：可选
>    - 可见范围：选择需要使用的部门/人员
> 3. 创建完成后，记录 **AgentId**
> 4. 在应用详情页点击 **Secret** 旁的"查看"，记录 Secret
> 5. 进入 **我的企业** → **企业信息**，记录 **企业ID**（Corp ID）

等待用户提供 Corp ID、Agent ID 和 Secret。

### 配置消息接收（可选）

> **接收消息回调配置**（如需要企业微信主动推送消息给 NanoClaw）：
>
> 1. 在应用详情页，找到 **API 接收消息**
> 2. 点击 **设置**：
>    - URL: `http://<你的服务器IP>:9880/`（确保端口对外可访问）
>    - Token: 自定义一个字符串（记录下来）
>    - EncodingAESKey: 点击"随机获取"（MVP 阶段暂不使用加密）
> 3. 点击保存（企业微信会向 URL 发送验证请求）
>
> 如果服务器尚未启动，先完成 Phase 4 配置后再来验证。

## Phase 4: 配置凭证

将获取的信息写入 `.env`：

```bash
# 企业微信配置
WECOM_CORP_ID=wxxxxxxxxxxxxxxxxx
WECOM_CORP_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
WECOM_AGENT_ID=1000002
WECOM_CALLBACK_TOKEN=your-custom-token
WECOM_CALLBACK_PORT=9880
```

同步到容器环境：

```bash
mkdir -p data/env && cp .env data/env/env
```

## Phase 5: 注册 Group

### 获取用户 ID

> 在企业微信管理后台 → **通讯录** → 点击成员 → 查看 **账号**（即 userid）。
> 例如：`zhangsan`

### 注册主聊天

```bash
npx tsx setup/index.ts --step register \
  --jid "wecom:<userid>@<corpid>" \
  --name "WeCom Main" \
  --folder "wecom_main" \
  --trigger "@Andy" \
  --channel wecom \
  --no-trigger-required \
  --is-main
```

### 构建并重启

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
# Linux: systemctl --user restart nanoclaw
```

## Phase 6: 验证

### 测试连接

告诉用户：

> 在企业微信中打开刚创建的应用，发送一条消息，如 "你好"。
> 机器人应该在几秒内回复。

### 查看日志

```bash
tail -f logs/nanoclaw.log
```

## 故障排查

### 机器人不回复

检查：
1. `.env` 中的凭证已同步到 `data/env/env`
2. Group 已注册：`sqlite3 store/nanoclaw.db "SELECT * FROM registered_groups WHERE jid LIKE 'wecom:%'"`
3. 服务正在运行：`launchctl list | grep nanoclaw`（macOS）
4. 回调端口可访问：`curl http://localhost:9880/`
5. Access token 有效：查看日志中是否有 "WeCom access token refreshed"

### 消息回调验证失败

- 确认 `WECOM_CALLBACK_TOKEN` 与企业微信后台配置一致
- 确认服务器 IP 和端口对外可访问
- 检查防火墙规则

### Access token 获取失败

- 确认 `WECOM_CORP_ID` 和 `WECOM_CORP_SECRET` 正确
- 确认 IP 白名单（企业微信后台 → 应用 → 企业可信IP）包含服务器 IP

## 卸载

1. 删除 `src/channels/wecom.ts` 和 `src/channels/wecom.test.ts`
2. 从 `src/channels/index.ts` 移除 `import './wecom.js'`
3. 从 `.env` 移除 `WECOM_*` 变量
4. 删除注册：`sqlite3 store/nanoclaw.db "DELETE FROM registered_groups WHERE jid LIKE 'wecom:%'"`
5. 重新构建：`npm run build && launchctl kickstart -k gui/$(id -u)/com.nanoclaw`（macOS）
