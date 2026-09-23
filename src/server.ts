/**
 * 把网关装配为 MCP 服务器（stdio 传输；Streamable HTTP 共享传输）。
 *
 * stdio：整个进程一个会话，占用身份为进程主 agent。
 * HTTP：每个 MCP 会话独立 Server/Transport 实例与会话键（s1/s2…），占用身份
 * 为 `<agent_id>-sN`，多客户端的占用互斥可追溯到具体会话；并带 Bearer Token
 * 常量时间比较鉴权。
 */

import * as http from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from "@modelcontextprotocol/sdk/types.js";
import { DeviceEnvelope, Gateway, GatewayError, UnknownToolError, type ToolDef } from "./gateway.js";
import { get_logger } from "./logging.js";
import { VERSION } from "./version.js";

const log = get_logger("server");

const INSTRUCTIONS =
  "本服务器是 BMAHS（比马斯）设备网关：每台发现的 BMAHS 设备的 operations 已映射为" +
  "「<设备id>__<动作>」形式的工具，工具说明含设备的自然语言自述与安全边界。" +
  "先用 bmahs_devices 查看设备并按 name/summary 选型；控制类动作网关会自动" +
  "occupy 并携带 token；任务结束（含失败/取消）必须 bmahs_release，" +
  "否则设备会一直对其它智能体显示被占用。" +
  "填参守则：所有工具的 device 参数直接填设备 id 字符串本身（如 \"lamp-01\"），" +
  "不要传对象或 {id: 名称} 映射；数值参数按 schema 类型传（整数不要加引号）。" +
  "同一调用失败时不要原样重试：按错误信息里的 retry_with/hint 修正参数，" +
  "连续失败请改用其他工具或向用户求助。";

/** 装配一个 MCP Server（对应一条传输/一个会话）。
 *
 * `handle` 是稳定的会话身份对象（HTTP 模式传 transport 实例；stdio 传 null →
 * "local"）；`notify` 是该会话的 tools/list_changed 通知器。
 */
export function build_server(gw: Gateway, handle: object | null, notify: () => Promise<void> | void): Server {
  const server = new Server({ name: "bmahs-mcp-gateway", version: VERSION }, {
    capabilities: { tools: { listChanged: true } },
    instructions: INSTRUCTIONS,
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    gw.note_session(handle, notify);
    const tools: ToolDef[] = gw.list_tools();
    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    gw.note_session(handle, notify);
    try {
      const content = await gw.call_tool(name, args ?? {}, gw.session_key(handle));
      return { content, isError: false };
    } catch (e) {
      if (e instanceof DeviceEnvelope) {
        // 设备明确拒绝（occupied / unauthorized / bad-arg / denied …）：
        // 把协议错误信封完整交给模型判断
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(Gateway.mask(e.envelope), null, 2),
            },
          ],
          isError: true,
        };
      }
      if (e instanceof GatewayError) {
        // 优先用富错误信封（echo/retry_with/candidates，参数净化与防循环守卫
        // 附加字段都在里面），没有信封时退回纯文本格式
        const payload = e.envelope ?? { ok: false, code: "gateway", error: String(e) };
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(payload, null, 2),
            },
          ],
          isError: true,
        };
      }
      if (e instanceof UnknownToolError) {
        throw new McpError(ErrorCode.InvalidParams, String(e));
      }
      log.error(`工具 ${name} 执行异常: ${(e as Error).stack ?? e}`);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ ok: false, code: "internal", error: `网关内部错误：${String(e)}` }, null, 2),
          },
        ],
        isError: true,
      };
    }
  });

  return server;
}

/** stdio 模式主循环：启动网关 → 挂到标准输入输出上跑 MCP 协议 → 退出前释放设备。 */
export async function serve_stdio(): Promise<number> {
  const gw = new Gateway();
  const server = build_server(gw, null, () =>
    server.notification({ method: "notifications/tools/list_changed" }),
  );
  await gw.start();
  log.info(`stdio 网关已启动（agent=${gw.agent_id}）`);
  const transport = new StdioServerTransport();
  const closed = new Promise<void>((resolve) => {
    transport.onclose = () => resolve();
  });
  await server.connect(transport);
  await closed;
  await gw.aclose();
  return 0;
}

// ------------------------------------------------------------------ HTTP 共享模式

/** 常量时间比较 Authorization 头与期望值；不符回 401 + JSON 信封。 */
function bearer_guard(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  token: string,
): boolean {
  const expected = Buffer.from(`Bearer ${token}`, "utf-8");
  const got = Buffer.from(String(req.headers.authorization ?? ""), "utf-8");
  const ok =
    expected.length === got.length &&
    timingSafeEqual(new Uint8Array(expected), new Uint8Array(got));
  if (ok) return true;
  res.writeHead(401, {
    "Content-Type": "application/json",
    "WWW-Authenticate": "Bearer",
  });
  res.end(
    JSON.stringify({ ok: false, code: "unauthorized", error: "缺少或错误的访问令牌" }),
  );
  return false;
}

function read_body(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

export interface HttpGatewayOptions {
  host: string;
  port: number;
  path: string;
  token?: string | null;
}

/** 构建并启动 Streamable HTTP 共享网关（多客户端同时连接），返回 http.Server。 */
export async function start_http_gateway(gw: Gateway, opts: HttpGatewayOptions): Promise<http.Server> {
  // 会话 id -> transport；DELETE/重复 POST 时复用同一会话
  const transports = new Map<string, StreamableHTTPServerTransport>();
  const cleanup = (session_id: string): void => {
    transports.delete(session_id);
  };

  const http_server = http.createServer(async (req, res) => {
    try {
      if (opts.token && !bearer_guard(req, res, opts.token)) return;
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname !== opts.path) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, code: "not-found", error: `未知路径 ${url.pathname}` }));
        return;
      }
      const session_id = req.headers["mcp-session-id"];
      const existing = typeof session_id === "string" ? transports.get(session_id) : undefined;
      if (existing) {
        const body = req.method === "POST" ? await read_body(req) : undefined;
        await existing.handleRequest(req, res, body ? JSON.parse(body) : undefined);
        return;
      }
      if (req.method === "POST") {
        // 新会话：客户端发来的第一条必是 initialize
        const body_text = await read_body(req);
        let parsed: unknown;
        try {
          parsed = JSON.parse(body_text);
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, code: "bad-request", error: "请求体不是合法 JSON" }));
          return;
        }
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id: string) => {
            transports.set(id, transport);
            log.info(`新 MCP 会话 ${id.slice(0, 8)}…（当前 ${transports.size} 个）`);
          },
        });
        transport.onclose = () => {
          const id = transport.sessionId;
          if (id) cleanup(id);
        };
        const server = build_server(gw, transport, () =>
          server.notification({ method: "notifications/tools/list_changed" }),
        );
        await server.connect(transport);
        await transport.handleRequest(req, res, parsed);
        return;
      }
      // GET（SSE 监听）/DELETE（关会话）没有已登记的会话：按协议拒绝
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: false,
          code: "session-not-found",
          error: "未知的 MCP 会话（先 POST initialize 建立）",
        }),
      );
    } catch (e) {
      log.error(`HTTP 请求处理失败: ${(e as Error).stack ?? e}`);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
      }
      res.end(JSON.stringify({ ok: false, code: "internal", error: "网关内部错误" }));
    }
  });

  await new Promise<void>((resolve, reject) => {
    http_server.once("error", reject);
    http_server.listen(opts.port, opts.host, () => resolve());
  });
  return http_server;
}

/** HTTP 模式主循环：启动网关后持续服务，进程退出前释放设备。 */
export async function serve_http(opts: HttpGatewayOptions): Promise<number> {
  const gw = new Gateway();
  const http_server = await start_http_gateway(gw, opts);
  await gw.start();
  log.info(`HTTP 共享网关已启动：http://${opts.host}:${opts.port}${opts.path}`);
  const closed = new Promise<void>((resolve) => http_server.on("close", resolve));
  await closed;
  await gw.aclose();
  return 0;
}

/** 注册进程级优雅退出：SIGINT/SIGTERM 时先释放设备再退出。 */
export function install_exit_hooks(cleanup: () => Promise<void>): void {
  let exiting = false;
  const handler = (signal: string): void => {
    if (exiting) return;
    exiting = true;
    log.info(`收到 ${signal}，退出前释放设备…`);
    Promise.resolve()
      .then(cleanup)
      .catch(() => {})
      .finally(() => process.exit(0));
  };
  process.on("SIGINT", () => handler("SIGINT"));
  process.on("SIGTERM", () => handler("SIGTERM"));
}
