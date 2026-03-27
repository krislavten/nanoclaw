---
name: add-rca
description: 配置 MCP 可观测数据连接，启用 RCA（根因分析）能力。运行此 skill 连接你的 trace/metric/log 数据源。
---

# 配置 RCA 连接

此 skill 引导你配置 MCP（Model Context Protocol）可观测数据连接，让 NanoClaw agent 能直接查询 trace、metric、log 进行根因分析。

## Phase 1: 预检

### 检查是否已配置

```bash
grep -q "MCP_URL" .env 2>/dev/null && echo "已配置" || echo "未配置"
```

如果已配置，询问用户是否要重新配置。

## Phase 2: 收集 MCP 端点信息

AskUserQuestion: 请提供你的 MCP 服务端点 URL。这是你的可观测平台（如 Octopus、Datadog 等）提供的 MCP 协议地址。格式示例：`https://your-mcp-server.example.com/mcp`

等待用户提供 URL。

AskUserQuestion: 请选择环境：`online`（生产）还是 `test`（测试）？

## Phase 3: 写入配置

将 MCP 连接信息写入 `.env`：

```bash
# 追加到 .env（如果已存在则替换）
sed -i '' '/^MCP_URL=/d; /^MCP_ENV=/d' .env 2>/dev/null || true
echo "MCP_URL=<用户提供的 URL>" >> .env
echo "MCP_ENV=<用户选择的环境>" >> .env
```

同步到容器环境：

```bash
mkdir -p data/env && cp .env data/env/env
```

## Phase 4: 验证连接

```bash
# 设置环境变量并测试
export $(grep -E '^MCP_URL=|^MCP_ENV=' .env | xargs)
tentaclaw-mcp alarm_search ""
```

如果返回告警列表（即使为空数组 `[]`），连接成功。

如果报错 `MCP_URL and MCP_ENV environment variables are required`，检查 `.env` 是否写入成功。

如果报网络错误，检查 URL 是否正确、网络是否可达。

## Phase 5: 重启服务

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
# Linux: systemctl --user restart nanoclaw
```

## 验证完成

告诉用户：

> RCA 连接已配置。现在 agent 收到告警时会自动使用 `tentaclaw-mcp` 查询 trace/metric/log 进行根因分析。
>
> 你可以在 Slack 中测试：发送一条告警信息给 Repo Agent，它会自动触发 RCA 流程。

## 故障排查

### tentaclaw-mcp 命令不存在

确认容器镜像包含 TentaClaw CLI 工具：
```bash
docker run --rm tentaclaw-agent sh -c 'which tentaclaw-mcp'
```

如果不存在，需要重新构建容器镜像：
```bash
pnpm turbo build --filter=@tentaclaw/cli
docker build -f docker/Dockerfile.agent -t tentaclaw-agent .
```

### MCP 连接超时

- 确认 MCP 端点 URL 正确
- 确认服务器网络可达：`curl -s <MCP_URL> | head -5`
- 检查是否需要 VPN 或代理

## 卸载

从 `.env` 移除 MCP 配置：
```bash
sed -i '' '/^MCP_URL=/d; /^MCP_ENV=/d' .env
mkdir -p data/env && cp .env data/env/env
```
