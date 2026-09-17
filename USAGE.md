# BMAHS ↔ MCP 网关使用指南（Python 版与 Node 版）

本指南覆盖两个功能对等的网关包：**`bmahs-mcp-gateway`**（Python，PyPI）与 **`bmahs-mcp-gateway-node`**（Node.js，npm）。它们把局域网内按 BMAHS 协议（`bmahs/1.0`）发布的硬件设备动态映射为 MCP（Model Context Protocol）工具，让 ZCode、Claude Desktop 等大模型客户端可以直接发现、占用和操作这些设备。

## 一、怎么选

| | Python 版 | Node 版 |
| --- | --- | --- |
| 安装包 | `bmahs-mcp-gateway`（PyPI） | `bmahs-mcp-gateway-node`（npm） |
| 环境要求 | Python ≥ 3.10 | Node.js ≥ 20 |
| 命令行工具 | `bmahs-mcp` | `bmahs-mcp-node` |
| 功能 | 完全一致（发现/动态工具/占用安全/stdio + HTTP） | 同左 |

按你机器上现成的运行环境选一个即可，不需要两个都装。两者连的是同一批设备、遵循同一协议；若同时运行，占用互斥规则也会正常生效（各自有独立的 agent 身份）。

## 二、下载与安装

### Python 版

```bash
pip install bmahs-mcp-gateway              # 基础安装（stdio 模式够用）
pip install "bmahs-mcp-gateway[http]"      # 需要多客户端共享的 HTTP 模式时
```

推荐用隔离安装，避免污染系统 Python：

```bash
pipx install "bmahs-mcp-gateway[http]"     # 或：uv tool install "bmahs-mcp-gateway[http]"
```

### Node 版

```bash
npm install -g bmahs-mcp-gateway-node      # 全局安装，得到命令 bmahs-mcp-node
npx -y bmahs-mcp-gateway-node@latest serve # 或者免安装直接运行
```

国内网络若 npm 安装慢，可临时走镜像：`npm install -g bmahs-mcp-gateway-node --registry=https://registry.npmmirror.com`（镜像同步可能有几分钟延迟）。

### 验证安装

```bash
bmahs-mcp --version          # Python 版，输出 bmahs-mcp 0.1.0
bmahs-mcp-node --version     # Node 版，输出 bmahs-mcp-node 0.1.0
```

## 三、快速上手（命令行）

两个版本命令行参数一致，下面以 Python 版为例（Node 版把 `bmahs-mcp` 换成 `bmahs-mcp-node` 即可）。

### 1. 扫描局域网设备

```bash
bmahs-mcp discover                     # 监听 4 秒，列出全部设备
bmahs-mcp discover --want light        # 只看 light 品类
```

输出每台设备的 id、显示名、品类、占用状态与地址，并对第一台做一次连通性校验。

### 2. 单动作联调

```bash
bmahs-mcp ctl 客厅灯 on                          # 支持设备 id 或显示名
bmahs-mcp ctl 客厅灯 brightness --arg level=80   # 带参数（值按 JSON 解析）
bmahs-mcp ctl 客厅灯 scene --arg name=cinema --ttl 600   # occupy 租约 600 秒
bmahs-mcp ctl 客厅灯 on --no-release             # 动作后保持占用（会打印释放命令）
```

控制类动作自动先 occupy（独占）、动作后自动 release；只读动作（describe/info/who/register）直接执行。

### 3. 常驻网关（供大模型客户端连接）

```bash
bmahs-mcp serve                        # stdio 模式（最常用，客户端自动拉起）
bmahs-mcp http --port 9530 --token 你的令牌   # HTTP 共享模式（多客户端同时连接）
```

## 四、接入 MCP 客户端（主要用法）

### 方式 A：stdio（推荐，单客户端）

在 MCP 客户端的配置文件（如 ZCode / Claude Desktop 的 `mcpServers`）中加入：

```json
{
  "mcpServers": {
    "bmahs": {
      "command": "bmahs-mcp",
      "args": ["serve"]
    }
  }
}
```

Node 版则写：

```json
{
  "mcpServers": {
    "bmahs": {
      "command": "bmahs-mcp-node",
      "args": ["serve"]
    }
  }
}
```

> 若客户端找不到命令，把 `command` 换成绝对路径（`where bmahs-mcp` / `where bmahs-mcp-node` 可查；pipx 装的在 `%USERPROFILE%\.local\bin\`，npm 全局装的在 `%APPDATA%\npm\`）。

重启客户端后，模型即可看到两类工具：

- **7 个固定工具**：`bmahs_devices`（列设备）、`bmahs_refresh`（重扫描）、`bmahs_describe`（读设备自述）、`bmahs_occupy` / `bmahs_release`（占用/释放）、`bmahs_call`（泛化调用）、`bmahs_screenshot`（有 ui 能力的设备抓屏）；
- **每台设备的动态工具**：命名 `<设备id>__<动作>`，如 `demo-light-001__brightness`，参数说明来自设备自述。

典型对话流程：让模型先 `bmahs_devices` 看有什么设备 → 按显示名/自述选型 → 直接调动态工具（网关会**自动 occupy 并携带 token**，默认 120 秒租约）→ 用完 `bmahs_release`。会话里看不到 token 是正常的（网关代管并遮蔽，不进模型上下文）。

### 方式 B：Streamable HTTP（多客户端共享一个网关）

在一台常开的机器上启动共享网关：

```bash
bmahs-mcp http --host 0.0.0.0 --port 9530 --token 换成强随机令牌
```

客户端以 URL 方式接入：端点 `http://<主机>:9530/mcp`，请求头带 `Authorization: Bearer <令牌>`。多个客户端（乃至多个对话会话）同时连接时，占用互斥可追溯到具体会话（占用方显示为 `<agent>-sN`）。

## 五、常用环境变量

所有变量两端通用：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `BMAHS_STATIC_DEVICES` | 空 | **静态设备表**：`tcp://IP:端口`，逗号分隔。跨网段/容器/组播不可用时必配 |
| `BMAHS_AGENT_ID` | 自动生成 | 本网关在协议中的智能体 id |
| `BMAHS_AUTO_OCCUPY` / `BMAHS_AUTO_OCCUPY_TTL` / `BMAHS_MAX_LEASE` | 开 / 120 / 3600 | 自动占用开关与租约上限（秒） |
| `BMAHS_CALL_TIMEOUT` | 30 | 单次设备调用超时（秒） |
| `BMAHS_BONJOUR_BROWSE` | 开 | `0` 关闭 mDNS 通道 |
| `BMAHS_TOOL_ALLOW` / `BMAHS_TOOL_DENY` | 空 | 动态工具黑白名单，通配符如 `*__reboot`，deny 优先 |
| `BMAHS_LOG_LEVEL` | info | 日志级别（日志一律走 stderr，不影响 stdio 协议） |
| `BMAHS_HTTP_HOST` / `PORT` / `PATH` / `TOKEN` | 0.0.0.0 / 9530 / /mcp / 无 | HTTP 模式默认值 |

## 六、常见问题

**discover 扫不到设备？**
按顺序检查：① 设备已上电且与电脑同一网段；② Windows 防火墙放行 UDP 5354 入站（首次运行弹窗时点"允许"）；③ 多网卡机器（装了 VMware/Hyper-V）可用 `BMAHS_MCAST_IF_V4=192.168.x.x` 指定网卡；④ 都不行就用静态表兜底：`BMAHS_STATIC_DEVICES=tcp://192.168.1.10:9527`（跨网段部署的标准做法）。

**模型调用时报「正被 xxx 占用」（occupied）？**
设备是独占的。用 `bmahs_devices` 看 `holder` 和 `until`：等租约到期自动释放，或请占用方 `bmahs_release`。协议没有强夺机制（这是特性，防止两个模型打架）。

**HTTP 模式返回 401？**
客户端没带令牌或令牌不对：请求头须有 `Authorization: Bearer <启动时 --token 设置的值>`。

**stdio 模式下看不到任何输出？**
正常。stdout 是 MCP 协议通道，日志全部走 stderr；`BMAHS_LOG_LEVEL=debug` 可调高日志。

**怎么升级 / 卸载？**

```bash
pip install -U bmahs-mcp-gateway        # pipx install -U / uv tool upgrade 同理
npm update -g bmahs-mcp-gateway-node
pip uninstall bmahs-mcp-gateway
npm uninstall -g bmahs-mcp-gateway-node
```

## 七、相关链接

- Python 版：[PyPI](https://pypi.org/project/bmahs-mcp-gateway/) · [GitHub](https://github.com/XJPeng12/bmahs-mcp-gateway)（含 [协议文档](https://github.com/XJPeng12/bmahs-mcp-gateway/blob/main/docs/BMAHS.md)）
- Node 版：[npm](https://www.npmjs.com/package/bmahs-mcp-gateway-node) · [GitHub](https://github.com/XJPeng12/bmahs-mcp-gateway-node)
- 各仓库的 `RELEASING.md` 面向维护者（发版流程）。
