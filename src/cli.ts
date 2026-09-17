/**
 * 命令行入口：serve（stdio 网关，默认）/ http（共享网关）/ discover（扫设备）/ ctl（联调单动作）。
 */

import { randomBytes } from "node:crypto";
import { call_action, fetch_hello } from "./client.js";
import { VERSION } from "./version.js";

function usage(): string {
  return `bmahs-mcp-node — BMAHS 设备协议 ↔ MCP 网关（Node 版）v${VERSION}

用法：
  bmahs-mcp-node serve                     启动 MCP 网关（stdio，供 MCP 客户端连接；默认）
  bmahs-mcp-node http [--host H] [--port P] [--path PATH] [--token TOK]
                                           以 Streamable HTTP 模式启动共享网关（多客户端同时连接）
  bmahs-mcp-node discover [--want T] [--seconds S]
                                           扫描局域网内的 BMAHS 设备并列出
  bmahs-mcp-node ctl <设备id> <action> [--arg K=V ...] [--ttl N] [--no-release] [--timeout S]
                                           对设备执行一个动作（联调用）
  bmahs-mcp-node --version

环境变量：BMAHS_AGENT_ID / BMAHS_STATIC_DEVICES / BMAHS_BONJOUR_BROWSE /
BMAHS_AUTO_OCCUPY（系列）/ BMAHS_CALL_TIMEOUT / BMAHS_QUERY_INTERVAL /
BMAHS_EXPIRE_SEC / BMAHS_TOOL_ALLOW / BMAHS_TOOL_DENY / BMAHS_CAPTURE_DIR /
BMAHS_LOG_LEVEL / BMAHS_MCAST_IF_V4 / BMAHS_HTTP_HOST|PORT|PATH|TOKEN
`;
}

interface ParsedArgs {
  positional: string[];
  flags: Map<string, string>;
  /** 可重复的旗标（如 --arg），按出现顺序收集 */
  multi: Map<string, string[]>;
}

function parse_args(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  const multi = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      let key: string;
      let value: string | true;
      if (eq > 0) {
        key = a.slice(2, eq);
        value = a.slice(eq + 1);
      } else {
        key = a.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          value = next;
          i += 1;
        } else {
          value = true;
        }
      }
      if (value === true) {
        flags.set(key, "true");
      } else if (key === "arg") {
        const list = multi.get("arg") ?? [];
        list.push(value);
        multi.set("arg", list);
      } else {
        flags.set(key, value);
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags, multi };
}

function env_or(flags: Map<string, string>, flag: string, env: string, fallback: string): string {
  const f = flags.get(flag);
  if (f !== undefined && f.length > 0) return f;
  const e = process.env[env];
  if (e) return e;
  return fallback;
}

/** 尽力把 K=V 的值解析为 JSON 类型（数字/布尔/null/对象），失败保留字符串。 */
function parse_kv(raw: string): [string, unknown] {
  const eq = raw.indexOf("=");
  if (eq < 0) return [raw, ""];
  const key = raw.slice(0, eq);
  const val = raw.slice(eq + 1);
  try {
    return [key, JSON.parse(val) as unknown];
  } catch {
    return [key, val];
  }
}

async function load_server() {
  return import("./server.js");
}

async function load_discovery() {
  return import("./discovery.js");
}

/** CLI 主入口；返回进程退出码。 */
export async function cli_main(argv: string[]): Promise<number> {
  if (argv.includes("--version") || argv.includes("-V")) {
    console.log(`bmahs-mcp-node ${VERSION}`);
    return 0;
  }
  const { positional, flags, multi } = parse_args(argv);
  const cmd = positional[0] ?? "serve";

  if (cmd === "serve") {
    const { serve_stdio, install_exit_hooks } = await load_server();
    install_exit_hooks(async () => {
      /* serve_stdio 内部在传输关闭时 aclose；这里处理信号强制退出 */
    });
    return serve_stdio();
  }

  if (cmd === "http") {
    const { serve_http, install_exit_hooks } = await load_server();
    install_exit_hooks(async () => {
      /* serve_http 在 server close 后自行 aclose */
    });
    return serve_http({
      host: env_or(flags, "host", "BMAHS_HTTP_HOST", "0.0.0.0"),
      port: parseInt(env_or(flags, "port", "BMAHS_HTTP_PORT", "9530"), 10),
      path: env_or(flags, "path", "BMAHS_HTTP_PATH", "/mcp"),
      token: flags.get("token") ?? process.env.BMAHS_HTTP_TOKEN ?? null,
    });
  }

  if (cmd === "discover") return cmd_discover(flags);
  if (cmd === "ctl") return cmd_ctl(positional.slice(1), flags, multi);

  console.error(usage());
  return 2;
}

// ------------------------------------------------------------------ discover

async function cmd_discover(flags: Map<string, string>): Promise<number> {
  const { Discovery } = await load_discovery();
  const want = flags.get("want") || "*";
  const seconds = parseFloat(flags.get("seconds") || "4");
  const agent_id = `bmahs-cli-${randomBytes(3).toString("hex")}`;
  const disc = new Discovery(agent_id, { bonjour: (process.env.BMAHS_BONJOUR_BROWSE ?? "1") !== "0" });
  await disc.start();
  console.error(`正在扫描（${seconds}s，组播 239.255.42.42/[ff02::4242]:5354，want=${want}）…`);
  await new Promise((r) => setTimeout(r, Math.max(1, seconds) * 1000));
  const want_parts = want
    .split(",")
    .map((w) => w.trim().toLowerCase())
    .filter((w) => w.length > 0);
  const devices = disc
    .all()
    .filter((dev) => {
      if (want === "*" || want_parts.length === 0 || want_parts.includes("bmahs")) return true;
      const t = String((dev.hello ?? dev.announce).type ?? "").toLowerCase();
      return want_parts.includes(t);
    })
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  if (devices.length === 0) {
    console.error("未发现 BMAHS 设备。请确认设备已上电并在同一局域网（UDP 5354 组播可达）。");
    await disc.stop();
    return 1;
  }
  for (const dev of devices) {
    const src = dev.hello ?? dev.announce;
    console.error(
      `• ${dev.id}  ${dev.name}  [${src.type ?? "?"}/${src.service ?? "?"}]  ` +
        `state=${dev.state}${dev.holder ? ` holder=${dev.holder}` : ""}  ${dev.uri ?? "?"}  (${dev.source})`,
    );
  }
  // 对第一台做一次 hello 连通性校验
  const first = devices[0]!;
  if (first.uri) {
    try {
      const hello = await fetch_hello(first.uri);
      const ops = (hello.operations as unknown[] | undefined)?.length ?? 0;
      console.error(`连通性 OK：${hello.name ?? hello.id}（${ops} 个操作）`);
    } catch (e) {
      console.error(`连通性校验失败：${(e as Error).message}`);
    }
  }
  await disc.stop();
  return 0;
}

// ------------------------------------------------------------------ ctl

async function cmd_ctl(
  rest: string[],
  flags: Map<string, string>,
  multi: Map<string, string[]>,
): Promise<number> {
  const device_ref = rest[0];
  const action = rest[1];
  if (!device_ref || !action) {
    console.error("用法：bmahs-mcp-node ctl <设备id> <action> [--arg K=V ...] [--ttl N] [--no-release] [--timeout S]");
    return 2;
  }
  const { Discovery } = await load_discovery();
  const timeout = parseFloat(flags.get("timeout") || "30");
  const args: Record<string, unknown> = {};
  for (const raw of multi.get("arg") ?? []) {
    const [k, v] = parse_kv(raw);
    args[k] = v;
  }
  const agent_id = `bmahs-cli-${randomBytes(3).toString("hex")}`;
  const disc = new Discovery(agent_id, { bonjour: false });
  await disc.start();

  // 最多等 4 秒让设备出现（或已被静态表登记）
  let dev: import("./discovery.js").Device | null = null;
  const deadline = performance.now() / 1000 + 4;
  while (performance.now() / 1000 < deadline) {
    dev = disc.get(device_ref);
    if (!dev) {
      const named = disc.all().filter((d) => d.name === device_ref);
      if (named.length === 1) dev = named[0]!;
    }
    if (dev?.uri) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  if (!dev?.uri) {
    console.error(`找不到设备 ${JSON.stringify(device_ref)}（等待 4 秒仍未见；可用 discover 先扫一遍）`);
    await disc.stop();
    return 1;
  }
  const hello = await fetch_hello(dev.uri, Math.min(timeout, 8)).catch((e: Error) => {
    console.error(`读取 hello 失败：${e.message}`);
    return null;
  });
  if (!hello) {
    await disc.stop();
    return 1;
  }
  console.error(`目标：${hello.name ?? dev.id}（${dev.uri}，state=${dev.state}）`);

  const READONLY = new Set(["describe", "info", "who", "register"]);
  const payload: Record<string, unknown> = { action, ...args, agent: agent_id };
  let token: string | null = null;

  try {
    if (action === "release") {
      // release 需要原 token：要求显式通过 --arg token=... 提供
      if (!args.token) {
        console.error("release 需要原占用 token：--arg token=<16位十六进制>");
        return 2;
      }
      const { resp } = await call_action(dev.uri, payload, timeout);
      console.log(JSON.stringify(resp, null, 2));
      return resp.ok ? 0 : 1;
    }
    if (!READONLY.has(action)) {
      // 控制类：先 occupy（--ttl 或设备默认租约）
      const occ_payload: Record<string, unknown> = { action: "occupy", agent: agent_id };
      const ttl_flag = flags.get("ttl");
      if (ttl_flag !== undefined) occ_payload.ttl = parseInt(ttl_flag, 10);
      const { resp: occ } = await call_action(dev.uri, occ_payload, timeout);
      if (!occ.ok) {
        console.log(JSON.stringify(occ, null, 2));
        return 1;
      }
      token = String(occ.token ?? "");
      console.error(`已占用（lease_security=${occ.lease_security}，until=${occ.until}）`);
      payload.token = token;
    }
    const { resp } = await call_action(dev.uri, payload, timeout);
    console.log(JSON.stringify(resp, null, 2));
    const failed = !resp.ok;
    if (!flags.has("no-release") && token) {
      const { resp: rel } = await call_action(dev.uri, { action: "release", agent: agent_id, token }, timeout);
      console.error(`已释放：${rel.ok ? "ok" : JSON.stringify(rel)}`);
    } else if (token) {
      console.error(`保持占用中（--no-release）。释放请用：bmahs-mcp-node ctl ${dev.id} release --arg token=${token}`);
    }
    return failed ? 1 : 0;
  } catch (e) {
    console.error(`执行失败：${(e as Error).message}`);
    return 1;
  } finally {
    await disc.stop();
  }
}
