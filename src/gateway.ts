/**
 * BMAHS ↔ MCP 网关核心。
 *
 * 实现协议 §4.8「智能体义务」中与运行时相关的部分：
 *
 * 1. 持续发现设备，缓存每台设备的 `hello`（自述 / operations / security）；
 * 2. 把每台设备的 `operations` 动态映射为 MCP 工具（`<设备id>__<动作>`），
 *    工具说明全部来自设备的自然语言字段；
 * 3. 代管占用 `token`：网关以进程唯一 `agent` 身份 `occupy`（自动占用为有限
 *    租约），后续控制自动携带 token，token 不回显给模型、不写入任何日志；
 * 4. 服务退出时统一 `release`，不把设备长期留在 `managed`；
 * 5. `security` 当作硬约束（越界动作由设备拒绝，网关原样转达）。
 *
 * 本模块不依赖 MCP SDK：list_tools/call_tool 返回纯 JSON 结构，SDK 装配
 * 在 server.ts 完成（会话句柄由 server 层传入，充当会话身份）。
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import * as client from "./client.js";
import { Discovery, type Device } from "./discovery.js";
import { get_logger } from "./logging.js";
import {
  GENERIC_ACTIONS,
  LEASE_UNLIMITED,
  READONLY_ACTIONS,
  now as now_sec,
  type BmahsMessage,
} from "./protocol.js";
import { find_op, input_schema, mcp_tool_name, normalize_args, tool_description, type Op } from "./schemas.js";

const log = get_logger("gateway");

/** 回显给模型时的 token 替身：真实 token 只保存在网关内存里，绝不能出现在
 * 模型可见的文本 / 日志 / 会话记录中（§4.8 第 9 条） */
export const TOKEN_PLACEHOLDER = "«token 已由网关保存，调用设备动作时自动携带，无需在会话中传递»";

/** hello 维护循环的轮询周期（秒）：每轮为还没拿到 hello 的设备补读一次 */
const HELLO_PRIME_INTERVAL = 5.0;
/** hello 超过该秒数未刷新即视为过期，bmahs_refresh 时会重读 */
const HELLO_STALE_SEC = 300.0;
/** hello 读取失败后的重试退避间隔（秒），避免对离线设备疯狂建连 */
const HELLO_RETRY_SEC = 30.0;

export class GatewayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GatewayError";
  }
}

/** 未知工具（server 层转成 JSON-RPC INVALID_PARAMS）。 */
export class UnknownToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnknownToolError";
  }
}

/** 设备返回了 `ok=false` 错误信封（§4.7），原样透传给模型。 */
export class DeviceEnvelope extends Error {
  constructor(public envelope: BmahsMessage) {
    super(String(envelope.error || envelope.code || "device error"));
    this.name = "DeviceEnvelope";
  }
}

export type TextBlock = { type: "text"; text: string };
export type ImageBlock = { type: "image"; data: string; mimeType: string };
export type ContentBlock = TextBlock | ImageBlock;
export type ToolDef = {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean };
};

function env_int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const v = parseInt(raw, 10);
  return Number.isFinite(v) ? v : fallback;
}

function env_float(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const v = parseFloat(raw);
  return Number.isFinite(v) ? v : fallback;
}

function env_bool(name: string, fallback: boolean): boolean {
  const raw = (process.env[name] ?? "").trim().toLowerCase();
  if (raw === "") return fallback;
  return !["0", "false", "no"].includes(raw);
}

/** fnmatch 风格通配符（`*` `?` `[seq]`）→ RegExp。 */
export function glob_to_regexp(pattern: string): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "*") out += "[^/]*";
    else if (c === "?") out += "[^/]";
    else if (c === "[") {
      const end = pattern.indexOf("]", i);
      if (end < 0) out += "\\[";
      else {
        out += pattern.slice(i, end + 1);
        i = end;
      }
    } else out += c.replace(/[.+^${}()|\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

/** 带超时地等待一个 Promise（超时抛 GatewayError）。 */
async function with_timeout<T>(p: Promise<T>, sec: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new GatewayError(`${what} 超时（${sec.toFixed(0)}s）`)), sec * 1000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 并发闸门（对应 Python asyncio.Semaphore）。 */
class Semaphore {
  private queue: Array<() => void> = [];
  private running = 0;
  constructor(private limit: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.running >= this.limit) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.running += 1;
    try {
      return await fn();
    } finally {
      this.running -= 1;
      this.queue.shift()?.();
    }
  }
}

function djb2_hash(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h;
}

function monotonic(): number {
  return performance.now() / 1000;
}

export class Gateway {
  /** 每进程唯一：同机多个网关进程身份不同，占用方崩溃后可按名辨识，
   * 且避免「同名不同 token」造成的相互锁死（§4.8） */
  agent_id: string;
  auto_occupy: boolean;
  /** 自动占用（模型未显式 occupy 时）用有限租约：网关进程若崩溃未 release，
   * 设备在租约到期后自动收回，不会永久锁死 */
  auto_occupy_ttl: number;
  /** 租约上限：无论模型请求多长的租约，都不会超过它 */
  max_lease: number;
  call_timeout: number;
  capture_dir: string;
  discovery: Discovery;
  tool_allow: string[];
  tool_deny: string[];
  /** id 冲突处置策略（docs/设备id冲突-现状与改进.md §5.1） */
  id_conflict_policy: "warn" | "isolate" | "off";
  /** 占用 token 按会话隔离：stdio 单会话用 "local"；HTTP 模式每个 MCP 会话一个键
   * （s1/s2…），占用方显示为 <agent_id>-sN，可追溯到对话会话。仅内存，不落盘。 */
  tokens: Map<string, Map<string, string>> = new Map();
  /** MCP 动态工具名 -> (设备 id, 动作名)：call_tool 时按它路由到具体设备动作 */
  tool_map: Map<string, [string, string]> = new Map();

  private session_keys = new Map<object, string>();
  private notifiers = new Map<object, () => Promise<void> | void>();
  private session_seq = 0;
  private tools_sig = "";
  private hello_sema = new Semaphore(8);
  private hello_timer: NodeJS.Timeout | null = null;

  constructor() {
    this.agent_id =
      process.env.BMAHS_AGENT_ID ||
      `bmahs-mcp-${(os.hostname().split(".")[0] || "gateway").toLowerCase()}-${randomBytes(3).toString("hex")}`;
    this.auto_occupy = env_bool("BMAHS_AUTO_OCCUPY", true);
    this.auto_occupy_ttl = Math.max(10, Math.min(9998, env_int("BMAHS_AUTO_OCCUPY_TTL", 120)));
    this.max_lease = Math.max(this.auto_occupy_ttl, Math.min(9998, env_int("BMAHS_MAX_LEASE", 3600)));
    this.call_timeout = env_float("BMAHS_CALL_TIMEOUT", 30);
    const static_raw = process.env.BMAHS_STATIC_DEVICES ?? "";
    const static_uris = static_raw
      .replace(/;/g, ",")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    this.capture_dir = process.env.BMAHS_CAPTURE_DIR || path.join(tmpdir(), "bmahs_captures");
    // id 冲突处置策略：warn=标记+告警+工具描述警示（默认，兼容多网卡设备的持续
    // 误报源）；isolate=冲突设备不生成动态工具且拒绝控制类调用；off=完全不检测
    const conflict_policy = (process.env.BMAHS_ID_CONFLICT_POLICY ?? "warn")
      .trim()
      .toLowerCase();
    this.id_conflict_policy =
      conflict_policy === "isolate" || conflict_policy === "off" ? conflict_policy : "warn";
    this.discovery = new Discovery(this.agent_id, {
      query_interval: env_float("BMAHS_QUERY_INTERVAL", 300),
      expire_sec: env_float("BMAHS_EXPIRE_SEC", 1800),
      static_uris,
      bonjour: env_bool("BMAHS_BONJOUR_BROWSE", true),
      conflict_detect: this.id_conflict_policy !== "off",
      on_change: () => this.on_devices_changed(),
    });
    // 工具暴露过滤：BMAHS_TOOL_ALLOW / BMAHS_TOOL_DENY，逗号分隔通配符，
    // 匹配动态工具名 / 「设备id__动作」/ 纯动作名；deny 优先，只作用于动态工具
    this.tool_allow = Gateway.patterns("BMAHS_TOOL_ALLOW");
    this.tool_deny = Gateway.patterns("BMAHS_TOOL_DENY");
  }

  private static patterns(env: string): string[] {
    return (process.env[env] ?? "")
      .replace(/;/g, ",")
      .split(",")
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
  }

  // ------------------------------------------------------------------ 生命周期

  /** 启动发现层、构建初始工具表，并拉起 hello 维护后台任务。 */
  async start(): Promise<void> {
    await this.discovery.start();
    this.rebuild_tools();
    this.hello_timer = setInterval(() => void this.hello_loop_tick(), HELLO_PRIME_INTERVAL * 1000);
  }

  private async hello_loop_tick(): Promise<void> {
    try {
      let changed = false;
      const now_mono = monotonic();
      for (const dev of this.discovery.all()) {
        if (dev.hello !== null) continue;
        // monotonic() 是进程启动起的秒数，hello_fail_at=0 表示从未失败；
        // 不排除 0 的话进程启动后前 30 秒所有设备都会被误判为退避中
        if (dev.hello_fail_at > 0 && now_mono - dev.hello_fail_at < HELLO_RETRY_SEC) continue;
        try {
          await this.hello_sema.run(() => this.refresh_hello(dev));
          changed = true;
        } catch (e) {
          dev.hello_fail_at = monotonic();
          log.debug(`读取设备 ${dev.id} hello 失败: ${(e as Error).message}`);
        }
      }
      if (changed && this.rebuild_tools()) await this.notify_tools_changed();
    } catch (e) {
      log.debug(`hello 维护循环异常: ${(e as Error).message}`);
    }
  }

  /** 退出前统一释放占用的设备（§4.8 第 6 条：任务结束 / 进程退出必须 release）。 */
  async aclose(): Promise<void> {
    if (this.hello_timer) {
      clearInterval(this.hello_timer);
      this.hello_timer = null;
    }
    for (const [skey, toks] of [...this.tokens.entries()]) {
      const agent = this.agent_for(skey);
      for (const [dev_id, token] of [...toks.entries()]) {
        try {
          const dev = this.discovery.get(dev_id);
          if (dev?.uri) {
            await with_timeout(
              client.call_action(dev.uri, { action: "release", agent, token }, 5.0),
              8.0,
              `释放设备 ${dev_id}`,
            );
            log.info(`退出前已释放设备 ${dev_id}（会话 ${skey}）`);
          }
        } catch (e) {
          log.warn(`退出时释放设备 ${dev_id} 失败（可能需重启该设备以解除占用）: ${(e as Error).message}`);
        }
      }
    }
    this.tokens.clear();
    await this.discovery.stop();
  }

  // ------------------------------------------------------------------ 会话管理

  /** 登记一个 MCP 会话（句柄对象由 server 层保证稳定）并返回会话键；null → "local"。
   * notify 同时注册该会话的 tools/list_changed 通知器。 */
  note_session(handle: object | null, notify?: () => Promise<void> | void): string {
    if (handle === null) return "local";
    if (notify) this.notifiers.set(handle, notify);
    let key = this.session_keys.get(handle);
    if (key === undefined) {
      this.session_seq += 1;
      key = `s${this.session_seq}`;
      this.session_keys.set(handle, key);
      this.tokens.set(key, new Map());
      log.info(`新 MCP 会话 ${key}（占用方身份 ${this.agent_for(key)}）`);
    }
    return key;
  }

  /** 查询会话键（未登记过则顺带登记）；null → "local"。 */
  session_key(handle: object | null): string {
    if (handle === null) return "local";
    const key = this.session_keys.get(handle);
    if (key === undefined) return this.note_session(handle);
    return key;
  }

  /** 会话在协议中的占用方身份：stdio 用进程主身份，HTTP 会话带 -sN 后缀。 */
  agent_for(session_key: string | null): string {
    if (!session_key || session_key === "local") return this.agent_id;
    return `${this.agent_id}-${session_key}`;
  }

  private token(skey: string, dev_id: string): string | null {
    return this.tokens.get(skey)?.get(dev_id) ?? null;
  }

  /** 记录 occupy 成功后设备签发的 token（仅内存，不落盘不打日志）。 */
  private set_token(skey: string, dev_id: string, token: string): void {
    let m = this.tokens.get(skey);
    if (!m) {
      m = new Map();
      this.tokens.set(skey, m);
    }
    m.set(dev_id, token);
  }

  /** 取出并清除某设备的 token（release 时用，防止重复释放）。 */
  private pop_token(skey: string, dev_id: string): string | null {
    const m = this.tokens.get(skey);
    if (!m) return null;
    const t = m.get(dev_id) ?? null;
    m.delete(dev_id);
    return t;
  }

  private async on_devices_changed(): Promise<void> {
    if (this.rebuild_tools()) await this.notify_tools_changed();
  }

  /** 向所有已知 MCP 会话广播 tools/list_changed，促使客户端重新拉取工具表。 */
  private async notify_tools_changed(): Promise<void> {
    let count = 0;
    for (const notify of [...this.notifiers.values()]) {
      try {
        await notify();
        count += 1;
      } catch (e) {
        log.debug(`发送 tools/list_changed 失败: ${(e as Error).message}`);
      }
    }
    log.info(`已发送 tools/list_changed 通知（${count}/${this.notifiers.size} 个会话）`);
  }

  // ------------------------------------------------------------------ hello 维护

  /** 建连读取（必要时 describe 补全）并缓存设备 hello；工具表变化则通知客户端。 */
  async refresh_hello(dev: Device): Promise<BmahsMessage> {
    if (!dev.uri) {
      throw new GatewayError(`设备 ${dev.id} 当前没有可连的 control 地址，请稍后重新发现`);
    }
    let hello = await client.fetch_hello(dev.uri, Math.min(this.call_timeout, 8.0));
    // §4.5：args 仍是字符串数组的旧版（bmahs/1）设备，应再发 describe 要求完整清单
    if (Gateway.hello_is_legacy(hello)) {
      try {
        const { resp: full } = await client.call_action(dev.uri, { action: "describe" }, this.call_timeout);
        if (Array.isArray(full.operations) || Array.isArray(full.ops)) hello = full;
      } catch {
        /* 拿不到 describe 时按原 hello 降级使用 */
      }
    }
    const bound = this.discovery.bind_hello(dev.key, hello) ?? dev;
    bound.hello = hello;
    bound.hello_at = monotonic();
    bound.hello_fail_at = 0.0;
    if (this.rebuild_tools()) await this.notify_tools_changed();
    return hello;
  }

  /** 取设备 hello，缓存缺失时现场补读一次；失败抛异常。 */
  async ensure_hello(dev: Device): Promise<BmahsMessage> {
    if (dev.hello === null) await this.refresh_hello(dev);
    return dev.hello as BmahsMessage;
  }

  /** 旧版字符串数组 args（仅名字，无类型/说明）检测（§4.5 兼容条款）。 */
  static hello_is_legacy(hello: BmahsMessage): boolean {
    const ops = (hello.operations ?? hello.ops ?? []) as unknown[];
    for (const op of ops) {
      if (typeof op === "object" && op !== null) {
        const args = ((op as Op).args as unknown[] | undefined) ?? [];
        if (args.some((a) => typeof a === "string")) return true;
      }
    }
    return false;
  }

  // ------------------------------------------------------------------ 工具表

  private tool_hidden(name: string, dev_id: string, action: string): boolean {
    const targets = [name, `${dev_id}__${action}`, action];
    const matches = (pattern: string): boolean => {
      const re = glob_to_regexp(pattern);
      return targets.some((t) => re.test(t));
    };
    if (this.tool_deny.some(matches)) return true;
    if (this.tool_allow.length > 0) return !this.tool_allow.some(matches);
    return false;
  }

  /** 根据缓存 hello 重建工具名映射；返回签名是否变化（决定是否通知客户端）。 */
  rebuild_tools(): boolean {
    const mapping = new Map<string, [string, string]>();
    const sig_parts: string[] = [];
    for (const dev of [...this.discovery.all()].sort((a, b) => (a.id < b.id ? -1 : 1))) {
      const hello = dev.hello;
      if (!hello) continue;
      if (this.id_conflict_policy === "isolate" && dev.id_conflict) continue; // isolate：疑似 id 冲突不暴露动态工具
      const ops = (hello.operations ?? hello.ops ?? []) as unknown[];
      for (const op_raw of ops) {
        if (typeof op_raw !== "object" || op_raw === null) continue;
        const op = op_raw as Op;
        const action = String(op.name ?? "");
        if (!action || GENERIC_ACTIONS.has(action)) continue; // 通用动作由固定工具统一提供
        let name = mcp_tool_name(dev.id, action);
        const base = name;
        let n = 2;
        while (mapping.has(name) && mapping.get(name)!.join("|") !== `${dev.id}|${action}`) {
          const suffix = `-${n}`;
          name = base.slice(0, 64 - suffix.length) + suffix;
          n += 1;
        }
        if (this.tool_hidden(name, dev.id, action)) continue;
        mapping.set(name, [dev.id, action]);
        const desc_hash = djb2_hash(tool_description(hello, op)) & 0xffffff;
        sig_parts.push(`${name}:${desc_hash}`);
      }
    }
    const sig = sig_parts.sort().join("|");
    const changed = sig !== this.tools_sig;
    this.tool_map = mapping;
    this.tools_sig = sig;
    return changed;
  }

  // ------------------------------------------------------------------ 设备解析与控制

  /** 把模型给的设备引用解析为 Device：先按 id 精确匹配 → 唯一同名 → 唯一子串模糊匹配。 */
  resolve_device(ref: unknown): Device {
    const r = String(ref ?? "").trim();
    if (!r) {
      throw new GatewayError("未指定设备（请传设备 id 或显示名，可先用 bmahs_devices 查询）");
    }
    let dev = this.discovery.get(r);
    if (dev === null) {
      const named = this.discovery.all().filter((d) => d.name === r);
      if (named.length === 1) dev = named[0]!;
    }
    if (dev === null) {
      const needle = r.toLowerCase();
      const fuzzy = this.discovery
        .all()
        .filter((d) => d.id.toLowerCase().includes(needle) || d.name.toLowerCase().includes(needle));
      if (fuzzy.length === 1) dev = fuzzy[0]!;
    }
    if (dev === null) {
      const known = this.discovery
        .all()
        .map((d) => `${d.id}（${d.name}）`);
      const listing = known.length > 0 ? known.join("；") : "（局域网内暂无设备，可调用 bmahs_refresh 重新扫描）";
      throw new GatewayError(`找不到设备 ${JSON.stringify(r)}。当前已知设备：${listing}`);
    }
    return dev;
  }

  /** 递归遮蔽 token：不回显给模型，也不进入会话记录（§4.8 第 9 条）。 */
  static mask(obj: unknown): unknown {
    if (typeof obj === "object" && obj !== null && !Array.isArray(obj)) {
      const out: BmahsMessage = {};
      for (const [k, v] of Object.entries(obj as BmahsMessage)) {
        out[k] = k === "token" && typeof v === "string" ? TOKEN_PLACEHOLDER : Gateway.mask(v);
      }
      return out;
    }
    if (Array.isArray(obj)) return obj.map((x) => Gateway.mask(x));
    return obj;
  }

  /** 设备回 ok=false 信封时转成 DeviceEnvelope 抛出（由 server 层透传给模型）。 */
  static require_ok(resp: unknown): BmahsMessage {
    const r = resp as BmahsMessage;
    if (r && r.ok === false) throw new DeviceEnvelope(r);
    return r;
  }

  /** 对设备发一次原始动作请求（不自动占用/带 token），返回 (hello, 响应信封)。
   *
   * 顺带把 TCP 可达当作存活信号刷新 last_seen，并用新 hello 更新自述缓存。
   */
  async raw_call(dev: Device, payload: BmahsMessage): Promise<[BmahsMessage, BmahsMessage]> {
    if (!dev.uri) {
      throw new GatewayError(
        `设备 ${dev.id} 当前没有可连的 control 地址（可能刚换网），请稍后调用 bmahs_refresh 重新发现`,
      );
    }
    let hello: BmahsMessage;
    let resp: BmahsMessage;
    try {
      ({ hello, resp } = await client.call_action(dev.uri, payload, this.call_timeout));
    } catch (e) {
      if (e instanceof client.BmahsError) throw new GatewayError(e.message);
      throw e;
    }
    // TCP 可达即视为存活：刷新 last_seen，跨网段/组播静默设备不会被心跳过期误删
    dev.last_seen = now_sec();
    if (hello.action === "hello") {
      dev.hello = hello;
      dev.hello_at = monotonic();
      if (this.rebuild_tools()) await this.notify_tools_changed();
    }
    return [hello, resp];
  }

  /** 占用一台设备并把签发的 token 存入本会话；返回设备响应信封。
   *
   * ttl 缺省用自动占用租约，超上限截断；已持有 token 时带上它以刷新租约，
   * token 失效则去掉重占一次。
   */
  /** isolate 策略下拒绝与疑似 id 冲突设备的控制交互；只读动作放行，便于诊断。 */
  private guard_conflict(dev: Device): void {
    if (this.id_conflict_policy !== "isolate" || !dev.id_conflict) return;
    const controls = [...dev.controls_seen.keys()].sort().join("、") || "多个地址";
    throw new GatewayError(
      `设备 ${dev.id} 疑似 id 冲突（局域网内多个控制地址自称 ${dev.id}，观测到 ${controls}），` +
        "已按 BMAHS_ID_CONFLICT_POLICY=isolate 隔离控制类动作；请人工核实并修改重复的设备 id 后重试",
    );
  }

  async occupy(dev: Device, ttl: unknown = null, skey = "local"): Promise<BmahsMessage> {
    this.guard_conflict(dev);
    const agent = this.agent_for(skey);
    const payload: BmahsMessage = { action: "occupy", agent };
    // 网关租约策略：不允许无限期占用。不带 ttl 用默认有限租约（120s），
    // 显式请求值超过上限截断到上限（默认 3600s），9999（无限期）一律截断。
    if (ttl === null || ttl === undefined) ttl = this.auto_occupy_ttl;
    if (typeof ttl !== "number" || !Number.isInteger(ttl) || ttl < 10) {
      throw new GatewayError("ttl 必须是 ≥10 的整数秒");
    }
    if (ttl >= LEASE_UNLIMITED || ttl > this.max_lease) ttl = this.max_lease;
    payload.ttl = ttl;
    const held = this.token(skey, dev.id);
    if (held) payload.token = held; // 已持有时带上以便刷新租约
    const [, r1] = await this.raw_call(dev, payload);
    let resp = r1;
    if (resp.code === "unauthorized" && held) {
      // 旧 token 已作废（设备重启 / 租约被接管）：去掉 token 重新占用
      delete payload.token;
      const [, r2] = await this.raw_call(dev, payload);
      resp = r2;
    }
    if (resp.ok && typeof resp.token === "string") {
      this.set_token(skey, dev.id, resp.token);
    }
    return resp;
  }

  /** 释放本会话对设备的占用；未持有 token 直接返回提示信封，token 已失效视同已释放。 */
  async release(dev: Device, skey = "local"): Promise<BmahsMessage> {
    const token = this.pop_token(skey, dev.id);
    if (!token) {
      return {
        ok: false,
        action: "release",
        code: "no-token",
        error: "当前会话未持有该设备的占用 token，无需释放",
        retryable: false,
      };
    }
    const [, resp] = await this.raw_call(dev, { action: "release", agent: this.agent_for(skey), token });
    if (resp.ok === false && resp.code === "unauthorized") {
      return {
        ok: true,
        action: "release",
        state: "registered",
        event: "release",
        note: "原 token 已失效（设备重启或租约变化），视同已释放",
      };
    }
    return resp;
  }

  /** 发送一条动作请求；按需自动占用并携带 token，token 失效自动重占用一次。 */
  async send_control(
    dev: Device,
    action: string,
    extra: BmahsMessage | null = null,
    skey = "local",
  ): Promise<BmahsMessage> {
    const extras: BmahsMessage = { ...(extra ?? {}) };
    if (READONLY_ACTIONS.has(action)) {
      const [, resp] = await this.raw_call(dev, { action, agent: this.agent_for(skey), ...extras });
      return resp;
    }
    this.guard_conflict(dev);
    let token = this.token(skey, dev.id);
    if (token === null) {
      if (!this.auto_occupy) {
        throw new GatewayError(
          `设备 ${dev.id} 尚未被本会话占用（BMAHS_AUTO_OCCUPY=0 时须先调用 bmahs_occupy）`,
        );
      }
      const occ = await this.occupy(dev, this.auto_occupy_ttl, skey);
      if (!occ.ok) return occ; // occupied / offline 等设备信封原样返回
      token = this.token(skey, dev.id);
    }
    const payload: BmahsMessage = { action, ...extras, agent: this.agent_for(skey) };
    if (token) payload.token = token;
    let [, resp] = await this.raw_call(dev, payload);
    if (resp.code === "unauthorized" && token) {
      this.pop_token(skey, dev.id);
      const occ = await this.occupy(dev, null, skey);
      if (!occ.ok) return occ; // 重占用失败（如已被他人占用）：返回最新信封
      const new_token = this.token(skey, dev.id);
      if (new_token) payload.token = new_token;
      [, resp] = await this.raw_call(dev, payload);
    }
    return resp;
  }

  // ------------------------------------------------------------------ MCP: list_tools

  /** 组装 MCP 工具表：7 个固定工具 + 每台设备的每个非通用动作一个动态工具。 */
  list_tools(): ToolDef[] {
    const tools: ToolDef[] = [
      {
        name: "bmahs_devices",
        description:
          "列出当前发现的全部 BMAHS 设备（id、显示名、自然语言自述、类型、状态、占用方与连接地址）。选设备、查占用状态时先用这个工具。",
        inputSchema: {
          type: "object",
          properties: {
            type: { type: "string", description: "按品类过滤（可选），如 light、display" },
          },
          additionalProperties: false,
        },
        annotations: { readOnlyHint: true },
      },
      {
        name: "bmahs_refresh",
        description:
          "重新扫描 BMAHS 设备：发送组播 query 并刷新各设备的自述（hello）。当设备列表为空、新设备刚上电、或怀疑列表过期时调用。",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true },
      },
      {
        name: "bmahs_describe",
        description: "读取某台 BMAHS 设备的完整操作清单（operations）、安全边界（security）与自然语言自述。",
        inputSchema: {
          type: "object",
          properties: { device: { type: "string", description: "设备 id 或显示名" } },
          required: ["device"],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: true },
      },
      {
        name: "bmahs_occupy",
        description:
          "独占占用一台 BMAHS 设备（返回的 token 由网关保存并自动携带）。租约由网关强制为有限时长：不带 ttl 默认 120 秒（2 分钟），请求值超过上限（默认 3600 秒）会被截断，不支持无限期占用。租约到期设备自动收回占用权；任务结束也可调用 bmahs_release 提前释放。",
        inputSchema: {
          type: "object",
          properties: {
            device: { type: "string", description: "设备 id 或显示名" },
            ttl: {
              type: "integer",
              minimum: 10,
              maximum: 9998,
              description: "租约秒数（默认 120=2 分钟；超过上限会被截断）",
            },
          },
          required: ["device"],
          additionalProperties: false,
        },
      },
      {
        name: "bmahs_release",
        description:
          "释放对某台 BMAHS 设备的占用。任务结束、失败或取消后必须调用，否则其它智能体会一直收到「被占用」。",
        inputSchema: {
          type: "object",
          properties: { device: { type: "string", description: "设备 id 或显示名" } },
          required: ["device"],
          additionalProperties: false,
        },
      },
      {
        name: "bmahs_call",
        description:
          "对 BMAHS 设备执行任意其操作清单内（operations）的动作，参数按该动作的 args 传。适合调用尚未生成独立工具的动作，或临时查看新设备。",
        inputSchema: {
          type: "object",
          properties: {
            device: { type: "string", description: "设备 id 或显示名" },
            action: { type: "string", description: "动作名，必须在设备 operations 清单中" },
            args: { type: "object", description: "动作参数（按该设备 operations 中该动作 args 的字段名与类型）" },
          },
          required: ["device", "action"],
          additionalProperties: false,
        },
      },
      {
        name: "bmahs_screenshot",
        description:
          "（实验）对声明了 ui 能力的 BMAHS 设备抓取一帧当前画面：自动 ui.start → 二进制流取一帧 JPEG → ui.stop，返回图片与保存路径。",
        inputSchema: {
          type: "object",
          properties: {
            device: { type: "string", description: "设备 id 或显示名" },
            max_width: {
              type: "integer",
              minimum: 64,
              description: "期望画面最大宽度（像素），设备按自身能力缩放",
            },
          },
          required: ["device"],
          additionalProperties: false,
        },
      },
    ];
    for (const [name, [dev_id, action]] of [...this.tool_map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      const dev = this.discovery.get(dev_id);
      if (!dev?.hello) continue;
      const op = find_op(dev.hello, action);
      if (!op) continue;
      let description = tool_description(dev.hello, op);
      if (dev.id_conflict && this.id_conflict_policy === "warn") {
        description +=
          "\n⚠️ 该设备 id 在局域网内观测到多个控制地址（疑似 id 冲突），" +
          "控制结果可能并非总是命中同一台实体设备，建议人工核实后再依赖。";
      }
      tools.push({
        name,
        description,
        inputSchema: input_schema(op),
      });
    }
    return tools;
  }

  // ------------------------------------------------------------------ MCP: call_tool

  /** MCP 工具调用总入口：先路由固定工具，再按 tool_map 路由到具体设备动作。
   *
   * 动态动作执行前校验 any_of（至少提供一个参数）约束；所有响应经 mask
   * 遮蔽 token、经 require_ok 校验后以文本内容返回。
   */
  async call_tool(name: string, args: Record<string, unknown> | null, skey = "local"): Promise<ContentBlock[]> {
    const arguments_ = { ...(args ?? {}) };
    if (name === "bmahs_devices") return this.text(await this.tool_devices(arguments_.type));
    if (name === "bmahs_refresh") return this.text(await this.tool_refresh());
    if (name === "bmahs_describe") {
      const dev = this.resolve_device(arguments_.device);
      await this.ensure_hello(dev);
      const [, resp] = await this.raw_call(dev, { action: "describe", agent: this.agent_for(skey) });
      return this.text(Gateway.require_ok(resp));
    }
    if (name === "bmahs_occupy") {
      const dev = this.resolve_device(arguments_.device);
      return this.text(Gateway.require_ok(Gateway.mask(await this.occupy(dev, arguments_.ttl, skey))));
    }
    if (name === "bmahs_release") {
      const dev = this.resolve_device(arguments_.device);
      return this.text(Gateway.require_ok(Gateway.mask(await this.release(dev, skey))));
    }
    if (name === "bmahs_call") {
      const dev = this.resolve_device(arguments_.device);
      const action = String(arguments_.action ?? "").trim();
      if (!action) throw new GatewayError("缺少 action 参数");
      const extra = arguments_.args;
      if (extra !== null && extra !== undefined && (typeof extra !== "object" || Array.isArray(extra))) {
        throw new GatewayError("args 必须是对象（键为该动作的参数名）");
      }
      return this.text(
        Gateway.require_ok(Gateway.mask(await this.send_control(dev, action, extra as BmahsMessage, skey))),
      );
    }
    if (name === "bmahs_screenshot") {
      const dev = this.resolve_device(arguments_.device);
      return this.tool_screenshot(dev, arguments_.max_width, skey);
    }
    const entry = this.tool_map.get(name);
    if (!entry) {
      throw new UnknownToolError(`未知工具：${name}（设备列表可能已变化，可调用 bmahs_refresh 后重试）`);
    }
    const [dev_id, action] = entry;
    const dev = this.discovery.get(dev_id);
    if (!dev) throw new GatewayError(`设备 ${dev_id} 已下线，请调用 bmahs_refresh 刷新列表`);
    const hello = await this.ensure_hello(dev);
    const op = find_op(hello, action);
    if (!op) throw new GatewayError(`设备 ${dev_id} 的操作清单中已没有 ${action}（设备能力可能已更新）`);
    const any_of = (op.any_of as string[] | undefined) ?? [];
    if (Array.isArray(any_of) && any_of.length > 0 && !any_of.some((a) => a in arguments_)) {
      throw new DeviceEnvelope({
        ok: false,
        action,
        code: "bad-arg",
        error: `参数 ${any_of.map((a) => `「${a}」`).join("、")} 至少需要提供一个（二选一/多选一约束，见工具说明）`,
        retryable: false,
      });
    }
    return this.text(Gateway.require_ok(Gateway.mask(await this.send_control(dev, action, arguments_, skey))));
  }

  // ------------------------------------------------------------------ 静态工具实现

  /** bmahs_devices：列出全部设备（含占用状态、动态工具名、hello 是否就绪）。 */
  async tool_devices(type_filter?: unknown): Promise<Record<string, unknown>> {
    await this.query_once();
    const items: Record<string, unknown>[] = [];
    const now_s = now_sec();
    for (const dev of [...this.discovery.all()].sort((a, b) => (a.id < b.id ? -1 : 1))) {
      if (type_filter && String(type_filter).toLowerCase() !== Gateway.dev_type(dev).toLowerCase()) continue;
      const hello = dev.hello ?? {};
      const tools = [...this.tool_map.entries()]
        .filter(([, [d]]) => d === dev.id)
        .map(([n]) => n)
        .sort();
      items.push({
        id: dev.id,
        name: dev.name,
        summary: hello.summary ?? dev.announce.summary ?? "",
        type: Gateway.dev_type(dev),
        service: hello.service ?? hello.svc ?? dev.announce.service ?? "",
        state: dev.state,
        holder: dev.holder,
        until: dev.until || null,
        occupied_by_gateway: [...this.tokens.values()].some((toks) => toks.has(dev.id)),
        control: dev.uri,
        id_conflict: dev.id_conflict,
        conflict_controls: dev.id_conflict ? [...dev.controls_seen.keys()].sort() : [],
        model: hello.model ?? dev.announce.model ?? "",
        last_seen_age_sec: dev.last_seen ? Math.max(0, now_s - dev.last_seen) : null,
        source: dev.source,
        ops_ready: dev.hello !== null,
        tool_names: tools,
        hint: hello.hint ?? "",
      });
    }
    return {
      ok: true,
      count: items.length,
      devices: items,
      note:
        "控制类动作前网关会自动 occupy（默认 120 秒有限租约，可用 BMAHS_AUTO_OCCUPY_TTL 调整）并携带 token；" +
        "任务结束请 bmahs_release。ops_ready=false 的设备稍后自动就绪，或调用 bmahs_refresh。" +
        "id_conflict=true 的设备：局域网内观测到多个控制地址自称同一 id（可能是两台设备撞 id，" +
        "也可能是同一设备多网卡），控制结果可能不确定，建议先人工核实。",
    };
  }

  /** bmahs_refresh：重发 query → 等待 announce → 为 hello 缺失/过期的设备补读 → 返回设备快照。 */
  async tool_refresh(): Promise<Record<string, unknown>> {
    await this.query_once();
    const deadline = monotonic() + 3.0;
    while (monotonic() < deadline) {
      const devs = this.discovery.all();
      if (devs.length > 0 && devs.every((d) => d.hello !== null)) break;
      await new Promise((r) => setTimeout(r, 300));
    }
    const stale = this.discovery
      .all()
      .filter((d) => d.hello === null || monotonic() - d.hello_at > HELLO_STALE_SEC);
    const results = await Promise.allSettled(stale.map((d) => this.hello_sema.run(() => this.refresh_hello(d))));
    const failures = results.filter((r) => r.status === "rejected").length;
    const snapshot = await this.tool_devices();
    snapshot.refreshed = stale.length - failures;
    snapshot.refresh_failures = failures;
    return snapshot;
  }

  /** 快速扫描：连发两次 query（间隔 0.2 秒防丢包），给设备留出应答窗口。 */
  async query_once(): Promise<void> {
    await this.discovery.query();
    await new Promise((r) => setTimeout(r, 200));
    await this.discovery.query();
  }

  /** 设备品类（light/display/switch…），优先 hello，其次 announce。 */
  static dev_type(dev: Device): string {
    return String((dev.hello ?? dev.announce).type ?? "");
  }

  // ------------------------------------------------------------------ 截图（ui 剖面 §4.9）

  /** bmahs_screenshot：抓一帧设备画面（ui.start → 读一帧二进制流 → ui.stop）。
   *
   * 返回 [文本元数据, JPEG 图片内容] 两个内容块，帧同时落盘到 capture_dir；
   * 设备未声明 ui 能力、未占用或流失败时抛 GatewayError / DeviceEnvelope。
   */
  async tool_screenshot(dev: Device, max_width?: unknown, skey = "local"): Promise<ContentBlock[]> {
    const hello = await this.ensure_hello(dev);
    const op = find_op(hello, "ui.start");
    if (!op) throw new GatewayError(`设备 ${dev.id} 未声明 ui 能力（operations 中没有 ui.start），无法抓屏`);
    if (this.token(skey, dev.id) === null) {
      if (!this.auto_occupy) {
        throw new GatewayError("抓屏前须先 bmahs_occupy（ui 动作要求携带占用 token）");
      }
      const occ = await this.occupy(dev, this.auto_occupy_ttl, skey);
      if (!occ.ok) throw new DeviceEnvelope(occ);
    }
    const token = this.token(skey, dev.id);
    if (token === null) {
      // 设备回了 ok 却没签发 token（协议违规）：避免后续空 token
      throw new GatewayError(`设备 ${dev.id} 占用成功但未返回 token（设备协议实现有误），无法抓屏`);
    }
    const extra: BmahsMessage = {};
    const arg_names = new Map<string, Record<string, unknown>>();
    for (const a of normalize_args(op)) arg_names.set(String(a.name), a);
    if (arg_names.has("codec")) extra.codec = "jpeg";
    if (arg_names.has("max_width") && max_width) {
      const spec = arg_names.get("max_width")!;
      let w = parseInt(String(max_width), 10);
      if (!Number.isFinite(w)) throw new GatewayError("max_width 必须是整数");
      if (typeof spec.min === "number") w = Math.max(w, spec.min);
      if (typeof spec.max === "number") w = Math.min(w, spec.max);
      extra.max_width = w;
    }
    const [, resp] = await this.raw_call(dev, {
      action: "ui.start",
      ...extra,
      agent: this.agent_for(skey),
      token,
    });
    if (!resp.ok) throw new DeviceEnvelope(resp);
    const ui_uri = String(resp.ui ?? "");
    let frame: client.UiFrame;
    try {
      frame = await client.read_ui_frame(ui_uri, token);
    } catch (e) {
      if (e instanceof client.BmahsError) {
        await this.safe_ui_stop(dev, skey);
        throw new DeviceEnvelope({
          ok: false,
          action: "screenshot",
          code: "ui-stream",
          error: e.message,
          retryable: true,
        });
      }
      throw e;
    }
    await this.safe_ui_stop(dev, skey);
    await fs.mkdir(this.capture_dir, { recursive: true });
    const ext = frame.codec === 1 ? "jpg" : "h264";
    const file = path.join(this.capture_dir, `${dev.id}_${now_sec()}.${ext}`);
    await fs.writeFile(file, frame.payload);
    const blocks: ContentBlock[] = [
      {
        type: "text",
        text: JSON.stringify(
          {
            ok: true,
            action: "screenshot",
            device: dev.id,
            width: frame.width,
            height: frame.height,
            codec: frame.codec === 1 ? "jpeg" : `codec-${frame.codec}`,
            saved_to: file,
            bytes: frame.payload.length,
          },
          null,
          2,
        ),
      },
    ];
    if (frame.codec === 1) {
      blocks.push({
        type: "image",
        data: frame.payload.toString("base64"),
        mimeType: "image/jpeg",
      });
    }
    return blocks;
  }

  /** 尽力停止设备的 UI 流会话：失败只记 debug，不影响主流程。 */
  private async safe_ui_stop(dev: Device, skey = "local"): Promise<void> {
    const token = this.token(skey, dev.id);
    if (token === null || !dev.uri) return;
    try {
      await with_timeout(
        client.call_action(dev.uri, { action: "ui.stop", agent: this.agent_for(skey), token }, 5.0),
        8.0,
        "ui.stop",
      );
    } catch (e) {
      log.debug(`ui.stop 失败（忽略）: ${(e as Error).message}`);
    }
  }

  // ------------------------------------------------------------------ 输出

  /** 把 dict/str 包装成 MCP 文本内容块（工具返回值的标准出口）。 */
  static text(this: void, obj: unknown): ContentBlock[] {
    const t = typeof obj === "string" ? obj : JSON.stringify(obj, null, 2);
    return [{ type: "text", text: t }];
  }

  private text(obj: unknown): ContentBlock[] {
    return Gateway.text(obj);
  }
}
