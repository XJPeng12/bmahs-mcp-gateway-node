# bmahs-mcp-gateway-node

BMAHS（比马斯）设备协议 ↔ MCP 网关的 **Node.js / TypeScript 实现**：把局域网内按 `bmahs/1.0` 协议发布的硬件设备（解析侧兼容旧版 1–1.2 字段名）动态映射为 [Model Context Protocol](https://modelcontextprotocol.io) 工具，让大模型客户端可以直接发现、占用与操作这些设备。

与 Python 版（[bmahs-mcp-gateway](https://github.com/XJPeng12/bmahs-mcp-gateway)）功能全量对齐，两者可互换使用，也可与对方的参考设备跨语言互通（`npm run smoke:py`）。

## 特性

- **零配置发现**：UDP 组播（`239.255.42.42:5354` / `[ff02::4242]:5354`，多网卡全 join + 自愈）+ Bonjour/mDNS 双通道；`BMAHS_STATIC_DEVICES` 静态设备表适配容器/跨网段。
- **动态工具映射**：设备 `operations` 自动映射为 MCP 工具（`<设备id>__<动作>`），含 JSON Schema、any_of 约束与自然语言说明，无需为每类设备写适配。
- **协议级占用安全**：控制前自动 `occupy`（有限租约）、token 按会话保管并自动携带、进程退出统一 `release`、token 递归遮蔽绝不回显。
- **两种接入模式**：stdio（单客户端）与 Streamable HTTP（多客户端共享，Bearer Token 常量时间鉴权，占用方可追溯到 `-sN` 会话）。
- **实验性抓屏**：声明了 `ui` 能力的设备可 `bmahs_screenshot` 抓帧（§4.9 二进制流解析）。

## 安装与构建

```bash
npm install
npm run build        # tsc → dist/
node dist/bin.js --version
```

全局安装后命令名为 `bmahs-mcp-node`（与 pip 版的 `bmahs-mcp` 不冲突）。

## 快速开始

```bash
# 扫描局域网内的 BMAHS 设备
node dist/bin.js discover

# 联调：对设备执行一个动作
node dist/bin.js ctl 客厅灯 on
node dist/bin.js ctl 客厅灯 brightness --arg level=80

# 启动 MCP 网关（stdio，默认子命令）
node dist/bin.js serve

# 以 Streamable HTTP 共享模式启动（多客户端同时连接）
node dist/bin.js http --host 0.0.0.0 --port 9530 --token 换成你的令牌
```

在 MCP 客户端中配置 stdio 接入：

```json
{
  "mcpServers": {
    "bmahs-node": {
      "command": "node",
      "args": ["/绝对路径/bmahs-mcp-gateway-node/dist/bin.js", "serve"]
    }
  }
}
```

HTTP 模式端点为 `http://<host>:9530/mcp`；设置了 `--token` 后客户端须携带 `Authorization: Bearer <token>`。

## 环境变量

与 Python 版同名同义：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `BMAHS_AGENT_ID` | `bmahs-mcp-<主机名>-<6位hex>` | 网关在协议中的智能体 id |
| `BMAHS_STATIC_DEVICES` | 空 | 静态设备表，逗号/分号分隔 `tcp://host:port` |
| `BMAHS_BONJOUR_BROWSE` | `1` | `0` 关闭 mDNS 浏览通道 |
| `BMAHS_AUTO_OCCUPY` / `BMAHS_AUTO_OCCUPY_TTL` / `BMAHS_MAX_LEASE` | `1` / `120` / `3600` | 自动占用策略与租约上限 |
| `BMAHS_CALL_TIMEOUT` / `BMAHS_QUERY_INTERVAL` / `BMAHS_EXPIRE_SEC` | `30` / `300` / `1800` | 调用超时、query 周期与设备过期时限 |
| `BMAHS_TOOL_ALLOW` / `BMAHS_TOOL_DENY` | 空 | 动态工具黑白名单（fnmatch 通配符，deny 优先） |
| `BMAHS_CAPTURE_DIR` | `<系统临时目录>/bmahs_captures` | bmahs_screenshot 帧落盘目录 |
| `BMAHS_MCAST_IF_V4` | 自动枚举 | 手动指定组播网卡（逗号分隔本机 IPv4） |
| `BMAHS_HTTP_HOST` / `BMAHS_HTTP_PORT` / `BMAHS_HTTP_PATH` / `BMAHS_HTTP_TOKEN` | `0.0.0.0` / `9530` / `/mcp` / 无 | HTTP 模式默认参数 |
| `BMAHS_LOG_LEVEL` | `info` | 日志级别（一律走 stderr） |

## 开发与测试

```bash
npm test          # vitest 单元/集成测试（假设备，不需要真实硬件）
npm run smoke     # 端到端 17 项契约（假设备 + stdio 网关 + MCP 客户端）
npm run smoke:py  # 跨语言联调（拉起 ../examples/demo_light.py，需要上层 .venv）
```

测试拓扑：`fake-device.ts` 是只实现控制层与 UI 流的测试假设备（不绑组播、状态可注入），与 Python 版 `tests/fake_device.py` 行为对齐。

发布到 npm 的完整流程与注意事项见 [RELEASING.md](RELEASING.md)。

## 协议

完整协议文档见 Python 主仓库的 [docs/BMAHS.md](https://github.com/XJPeng12/bmahs-mcp-gateway/blob/main/docs/BMAHS.md)：UDP 组播一报文一 JSON（≤1400 字节）负责发现，TCP 一行 JSON + `\n` 负责控制，连上先读 hello；网关在协议中承担「智能体」角色（§4.8）。

## License

[MIT](LICENSE)
