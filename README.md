# bmahs-mcp-gateway-node

> **BMAHS（比马斯）** 是一个开放的局域网硬件协议：每台设备上电即用自然语言「自我介绍」——我是谁、能做什么、安全边界在哪——让大模型智能体像接入 USB 设备一样，即插即用地发现、识别、按权限独占并安全地操作它们。

BMAHS（比马斯）设备协议 ↔ MCP 网关的 **Node.js / TypeScript 实现**：把局域网内按 `bmahs/1.0` 协议发布的硬件设备（解析侧兼容旧版 1–1.2 字段名）动态映射为 [Model Context Protocol](https://modelcontextprotocol.io) 工具，让大模型客户端可以直接发现、占用与操作这些设备。

与 Python 版（[bmahs-mcp-gateway](https://github.com/XJPeng12/bmahs-mcp-gateway)）功能全量对齐，两者可互换使用，也可与对方的参考设备跨语言互通（`npm run smoke:py`）。

## 特性

- **零配置发现**：UDP 组播（`239.255.42.42:5354` / `[ff02::4242]:5354`，多网卡全 join + 自愈）+ Bonjour/mDNS 双通道；`BMAHS_STATIC_DEVICES` 静态设备表适配容器/跨网段。
- **动态工具映射**：设备 `operations` 自动映射为 MCP 工具（`<设备id>__<动作>`），含 JSON Schema、any_of 约束与自然语言说明，无需为每类设备写适配。
- **协议级占用安全**：控制前自动 `occupy`（有限租约）、token 按会话保管并自动携带、进程退出统一 `release`、token 递归遮蔽绝不回显。
- **两种接入模式**：stdio（单客户端）与 Streamable HTTP（多客户端共享，Bearer Token 常量时间鉴权，占用方可追溯到 `-sN` 会话）。
- **实验性抓屏**：声明了 `ui` 能力的设备可 `bmahs_screenshot` 抓帧（§4.9 二进制流解析）。

## 安装

```bash
npm install -g bmahs-mcp-gateway-node       # 全局安装，得到命令 bmahs-mcp-node（与 pip 版的 bmahs-mcp 不冲突）
npx -y bmahs-mcp-gateway-node@latest serve  # 免安装直接运行
```

验证：`bmahs-mcp-node --version` 输出 `bmahs-mcp-node 0.1.1`。要求 Node.js ≥ 20。国内网络安装慢可临时走镜像 `--registry=https://registry.npmmirror.com`（同步可能有几分钟延迟）。

从源码构建开发：

```bash
npm install
npm run build        # tsc → dist/
node dist/bin.js --version
```

## 快速开始

```bash
# 扫描局域网内的 BMAHS 设备（全局安装后把 node dist/bin.js 换成 bmahs-mcp-node）
node dist/bin.js discover

# 联调：对设备执行一个动作（控制类动作自动 occupy → 执行 → release）
node dist/bin.js ctl 客厅灯 on
node dist/bin.js ctl 客厅灯 brightness --arg level=80
node dist/bin.js ctl 客厅灯 scene --arg name=cinema --ttl 600        # 指定占用租约 600 秒
node dist/bin.js ctl 客厅灯 on --no-release                          # 动作后保持占用（打印 token）
node dist/bin.js ctl 客厅灯 release --arg token=<占有时返回的 token>  # 手动释放保持的占用

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

重启客户端后，模型可见两类工具：**7 个固定工具**——`bmahs_devices`（列设备）、`bmahs_refresh`（重扫描）、`bmahs_describe`（读自述）、`bmahs_occupy` / `bmahs_release`（占用/释放）、`bmahs_call`（泛化调用）、`bmahs_screenshot`（ui 设备抓屏）；以及**每台设备的动态工具**——`<设备id>__<动作>`（如 `demo-light-001__brightness`），参数说明来自设备自述。典型流程：`bmahs_devices` 选型 → 直接调动态工具（网关自动 occupy 并携带 token，默认 120 秒租约）→ 用完 `bmahs_release`；token 由网关代管并遮蔽，不进模型上下文。

## 常见问题

- **扫不到设备？** 确认设备已上电且同网段、Windows 防火墙放行 UDP 5354 入站；多网卡机器用 `BMAHS_MCAST_IF_V4` 指定网卡；跨网段/容器用 `BMAHS_STATIC_DEVICES=tcp://IP:端口` 静态表兜底。
- **报「正被 xxx 占用」（occupied）？** 设备独占中：`bmahs_devices` 看 `holder`/`until`，等租约到期或请占用方 `bmahs_release`；协议无强夺机制（防止两个模型打架）。
- **HTTP 模式 401？** 请求头须带 `Authorization: Bearer <--token 设置的值>`。
- **stdio 模式没有输出？** 正常：stdout 是 MCP 协议通道，日志全走 stderr（`BMAHS_LOG_LEVEL=debug` 调高）。

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

## 协议

完整协议文档见 Python 主仓库的 [docs/BMAHS1.0.md](https://github.com/XJPeng12/bmahs-mcp-gateway/blob/main/docs/BMAHS1.0.md)：UDP 组播一报文一 JSON（≤1400 字节）负责发现，TCP 一行 JSON + `\n` 负责控制，连上先读 hello；网关在协议中承担「智能体」角色（§4.8）。

## License

[MIT](LICENSE)
