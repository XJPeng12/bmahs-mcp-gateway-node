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
import { createHash, randomBytes } from "node:crypto";
import * as client from "./client.js";
import { Discovery, type Device } from "./discovery.js";
import { get_logger } from "./logging.js";
import * as sanitize from "./sanitize.js";
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

/** BMAHS_DEVICE_TOOLS=1 时为每台设备生成的零参数 describe 别名的动作定义
 * （通用动作不在各设备 operations 里重复出现，动态别名需要一份描述来源）。 */
const DESCRIBE_OP: Op = {
  name: "describe",
  description: "读取该设备的完整操作清单（operations）、安全边界（security）与自然语言自述。",
};

export class GatewayError extends Error {
  /** 富错误信封（echo/retry_with/candidates，见 sanitize.ts），server 层优先用它 */
  envelope?: Record<string, unknown>;
  constructor(message: string, envelope?: Record<string, unknown>) {
    super(message);
    this.name = "GatewayError";
    this.envelope = envelope;
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
  // —— 工具调用参数死循环防护（docs/工具调用参数死循环_网关侧防护方案.md）——
  /** 防线②：参数净化器（dict 解包 / 字符串数字转类型 / 近似匹配），BMAHS_ARG_COERCE=0 关闭 */
  arg_coerce: boolean;
  /** 防线③：同参重复失败升级提示开关 */
  loop_guard: boolean;
  /** 防线③：第 N 次连续同参失败时下达停止令（下限 2） */
  loop_guard_max: number;
  /** 防线①：bmahs_describe 的 device 可选（唯一设备自动选中；多设备返回选择清单） */
  describe_optional: boolean;
  /** 备用方案：为每台设备生成零参数 <id>__describe 动态别名（工具表膨胀，默认关） */
  device_describe_tools: boolean;
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
  /** 防线③状态：skey -> 最近一次失败 (指纹, 连续次数, 时刻)；任何成功调用即清除。
   * 只记「最近一次」：威胁不是历史累计失败，而是连续原样重放，换调用即重置。 */
  private fail_streak = new Map<string, [string, number, number]>();

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
    // —— 工具调用参数死循环防护 ——
    this.arg_coerce = env_bool("BMAHS_ARG_COERCE", true);
    this.loop_guard = env_bool("BMAHS_LOOP_GUARD", true);
    this.loop_guard_max = Math.max(2, env_int("BMAHS_LOOP_GUARD_MAX", 3));
    this.describe_optional = env_bool("BMAHS_DESCRIBE_OPTIONAL", true);
    const ddt = (process.env.BMAHS_DEVICE_TOOLS ?? "").trim().toLowerCase();
    this.device_describe_tools = ddt === "1" || ddt === "true" || ddt === "yes";
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
      if (this.device_describe_tools) {
        // 备用方案（BMAHS_DEVICE_TOOLS=1）：零参数 <id>__describe 别名，
        // 把「查详情必须手填 device」这个参数从工具面上消灭
        let name = mcp_tool_name(dev.id, "describe");
        const base = name;
        let n = 2;
        while (mapping.has(name) && mapping.get(name)!.join("|") !== `${dev.id}|describe`) {
          const suffix = `-${n}`;
          name = base.slice(0, 64 - suffix.length) + suffix;
          n += 1;
        }
        if (!this.tool_hidden(name, dev.id, "describe")) {
          mapping.set(name, [dev.id, "describe"]);
          const desc_hash = djb2_hash(tool_description(hello, { ...DESCRIBE_OP })) & 0xffffff;
          sig_parts.push(`${name}:${desc_hash}`);
        }
      }
    }
    const sig = sig_parts.sort().join("|");
    const changed = sig !== this.tools_sig;
    this.tool_map = mapping;
    this.tools_sig = sig;
    return changed;
  }

  // ------------------------------------------------------------------ 设备解析与控制

  /** resolve_device 的不抛错版：id 精确 → 唯一同名 → 唯一子串；落空返回 null。 */
  resolve_quiet(ref: unknown): Device | null {
    const r = String(ref ?? "").trim();
    if (!r) return null;
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
    return dev;
  }

  /** 把模型给的设备引用解析为 Device：先按 id 精确匹配 → 唯一同名 → 唯一子串模糊匹配。
   *
   * 三级都落空时抛带富错误信封的 GatewayError（echo 回显实际传参、retry_with
   * 给示例 id、candidates 列出当前已知设备），引导模型下一轮照抄正确形态。
   */
  resolve_device(ref: unknown): Device {
    const r = String(ref ?? "").trim();
    if (!r) {
      throw new GatewayError("未指定设备（请传设备 id 或显示名，可先用 bmahs_devices 查询）");
    }
    const dev = this.resolve_quiet(r);
    if (dev === null) {
      const known = this.discovery.all().map((d) => `${d.id}（${d.name}）`);
      const listing = known.length > 0 ? known.join("；") : "（局域网内暂无设备，可调用 bmahs_refresh 重新扫描）";
      throw new GatewayError(
        `找不到设备 ${JSON.stringify(r)}。当前已知设备：${listing}`,
        sanitize.rich_error(`找不到设备 ${JSON.stringify(r)}。当前已知设备：${listing}`, {
          echo: { device: r },
          retry_with: known.length > 0 ? { device: sanitize.example_device_ref(this) } : undefined,
          candidates: known.length > 0 ? sanitize.known_device_list(this) : undefined,
        }),
      );
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

  /** 组装 MCP 工具表：7 个固定工具 + 每台设备的每个非通用动作一个动态工具。
   *
   * 防线①（docs/工具调用参数死循环_网关侧防护方案.md §4）：device 参数描述带
   * 可照抄的字面量正例 + 负例（示例 id 取当前真实设备），从源头压低首错率。
   */
  list_tools(): ToolDef[] {
    const example = sanitize.example_device_ref(this);
    const device_desc =
      "设备 id 或显示名。必须直接填字符串本身，如 " +
      `${JSON.stringify(example)}；禁止传对象、禁止传 ` +
      `{${JSON.stringify(example)}: "设备名"} 这类 {id: 名称} 映射。`;
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
        description:
          "读取某台 BMAHS 设备的完整操作清单（operations）、安全边界（security）与自然语言自述。" +
          `device 直接填 id 字符串（如 ${JSON.stringify(example)}）；局域网内只有一台已知设备时可省略 device。`,
        inputSchema: {
          type: "object",
          properties: { device: { type: "string", description: device_desc } },
          ...(this.describe_optional ? {} : { required: ["device"] }),
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
            device: { type: "string", description: device_desc },
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
          properties: { device: { type: "string", description: device_desc } },
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
            device: { type: "string", description: device_desc },
            action: { type: "string", description: "动作名，必须在设备 operations 清单中" },
            args: {
              type: "object",
              description:
                "动作参数对象，键=参数名，值类型按该设备 operations 中该动作 args 的声明。" +
                '示例：亮度动作传 {"brightness": 50}（整数），不要传 {"brightness": "50"}，不要传数组。',
            },
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
            device: { type: "string", description: device_desc },
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
      const op = find_op(dev.hello, action) ?? (action === "describe" ? { ...DESCRIBE_OP } : null);
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

  /** MCP 工具调用总入口：参数净化（防线②）→ 分发执行 → 错误统一过防循环守卫（防线③）。
   *
   * 动态动作执行前校验 any_of（至少提供一个参数）约束；所有响应经 mask
   * 遮蔽 token、经 require_ok 校验后以文本内容返回；任何成功调用都会重置
   * 该会话的「连续同参失败」计数。
   */
  async call_tool(name: string, args: Record<string, unknown> | null, skey = "local"): Promise<ContentBlock[]> {
    const arguments_ = { ...(args ?? {}) };
    try {
      const result = await this.dispatch_tool(name, arguments_, skey);
      this.fail_streak.delete(skey);
      return result;
    } catch (e) {
      if (e instanceof DeviceEnvelope) {
        e.envelope = this.guarded_error(skey, name, arguments_, e.envelope);
      } else if (e instanceof GatewayError) {
        const env = e.envelope ?? { ok: false, code: "gateway", error: String(e), retryable: false };
        e.envelope = this.guarded_error(skey, name, arguments_, env as Record<string, unknown>);
      }
      throw e;
    }
  }

  /** 防线②：净化 device 参数（BMAHS_ARG_COERCE=0 时原样透传）。 */
  private prep_device(args: Record<string, unknown>): [unknown, sanitize.CoercedNote[], sanitize.SanitizeError | null] {
    const value = args.device;
    if (!this.arg_coerce) return [value, [], null];
    return sanitize.coerce_device_ref(this, value);
  }

  /** 成功响应附 coerced 透明标注（防线②原则 2：让模型知道被矫正了什么）。 */
  private static attach_coerced(resp: BmahsMessage, notes: sanitize.CoercedNote[]): BmahsMessage {
    if (notes.length > 0 && resp && typeof resp === "object" && !Array.isArray(resp)) {
      return { ...resp, coerced: notes };
    }
    return resp;
  }

  /** 防线③：同一会话以完全相同参数连续失败时升级纠错提示。
   *
   * 指纹 = 工具名 + 规范化参数（换任何其他调用即重置）。第 2 次起在错误前加
   * 「第 N 次相同失败」警示并附 retry_with 模板；第 loop_guard_max 次下达停止令。
   * 提示逐级改写——字节级相同的错误响应本身就会成为强化燃料。
   */
  private guarded_error(
    skey: string,
    name: string,
    args: Record<string, unknown>,
    envelope: Record<string, unknown>,
  ): Record<string, unknown> {
    if (!this.loop_guard) return envelope;
    const canon = name + "\x00" + JSON.stringify(args);
    const fingerprint = createHash("sha1").update(canon, "utf-8").digest("hex");
    const prev = this.fail_streak.get(skey);
    const count = prev && prev[0] === fingerprint ? prev[1] + 1 : 1;
    this.fail_streak.set(skey, [fingerprint, count, monotonic()]);
    if (count < 2) return envelope;
    const out: Record<string, unknown> = { ...envelope };
    out.repeat_count = count;
    const base = `⚠️ 这是第 ${count} 次以完全相同的参数调用「${name}」失败。`;
    if (count >= this.loop_guard_max) {
      out.error =
        base +
        "原样重试不会成功：请立即停止重试此调用，改用其他工具或修正参数" +
        "（参见 retry_with / candidates），或向用户说明情况并请求人工介入。";
      out.directive = "stop";
    } else {
      out.error = base + String(out.error ?? "");
      out.hint = "请直接复制 retry_with 中的参数重试，或改用其他工具/参数；不要原样重放。";
    }
    log.warn(`会话 ${skey} 工具 ${name} 以相同参数连续失败 ${count} 次`);
    return out;
  }

  /** bmahs_describe：device 可选（防线①P1-4）+ 引用净化（防线②）。
   *
   * 未传 device 时：唯一已知设备自动选中；多台返回信息性选择清单（不报错，
   * 不产生错误先例）；零台返回刷新提示。
   */
  private async tool_describe(args: Record<string, unknown>, skey: string): Promise<ContentBlock[]> {
    let notes: sanitize.CoercedNote[] = [];
    const ref = args.device;
    const blank = ref === null || ref === undefined || (typeof ref === "string" && ref.trim() === "");
    if (blank && this.describe_optional) {
      const devs = [...this.discovery.all()].sort((a, b) => (a.id < b.id ? -1 : 1));
      if (devs.length === 0) {
        return this.text({
          ok: true,
          count: 0,
          devices: [],
          note: "局域网内暂无已知设备：可调用 bmahs_refresh 重新扫描后再试。",
        });
      }
      if (devs.length > 1) {
        return this.text({
          ok: true,
          count: devs.length,
          devices: devs.map((d) => ({ id: d.id, name: d.name, type: Gateway.dev_type(d) })),
          note:
            "未指定 device 且当前有多台设备：请从上面选一台，并按 {\"device\": \"<id>\"} 传 id 字符串" +
            `（如 {\"device\": ${JSON.stringify(devs[0]!.id)}}）重新调用。`,
        });
      }
      notes.push({
        arg: "device",
        from: null,
        to: devs[0]!.id,
        note: `未指定 device，已自动选择唯一已知设备 ${devs[0]!.id}`,
      });
      const [, resp] = await this.raw_call(devs[0]!, { action: "describe", agent: this.agent_for(skey) });
      return this.text(Gateway.attach_coerced(Gateway.require_ok(resp), notes));
    }
    const [ref2, dev_notes, err] = this.prep_device(args);
    if (err) throw new DeviceEnvelope(err as BmahsMessage);
    notes = dev_notes;
    const dev = this.resolve_device(ref2);
    await this.ensure_hello(dev);
    const [, resp2] = await this.raw_call(dev, { action: "describe", agent: this.agent_for(skey) });
    return this.text(Gateway.attach_coerced(Gateway.require_ok(resp2), notes));
  }

  /** 路由分发：先固定工具，再按 tool_map 路由到具体设备动作。 */
  private async dispatch_tool(
    name: string,
    arguments_: Record<string, unknown>,
    skey: string,
  ): Promise<ContentBlock[]> {
    if (name === "bmahs_devices") return this.text(await this.tool_devices(arguments_.type));
    if (name === "bmahs_refresh") return this.text(await this.tool_refresh());
    if (name === "bmahs_describe") return this.tool_describe(arguments_, skey);
    if (name === "bmahs_occupy") {
      const [ref, notes, err] = this.prep_device(arguments_);
      if (err) throw new DeviceEnvelope(err as BmahsMessage);
      const dev = this.resolve_device(ref);
      let ttl: unknown = null;
      let tnotes: sanitize.CoercedNote[] = [];
      if (this.arg_coerce) {
        const [v, n2, e2] = sanitize.coerce_int(arguments_.ttl, "ttl", this.auto_occupy_ttl);
        if (e2) throw new DeviceEnvelope(e2 as BmahsMessage);
        ttl = v;
        tnotes = n2;
      } else {
        ttl = arguments_.ttl ?? null;
      }
      const resp = Gateway.require_ok(Gateway.mask(await this.occupy(dev, ttl as number | null, skey)));
      return this.text(Gateway.attach_coerced(resp, [...notes, ...tnotes]));
    }
    if (name === "bmahs_release") {
      const [ref, notes, err] = this.prep_device(arguments_);
      if (err) throw new DeviceEnvelope(err as BmahsMessage);
      const dev = this.resolve_device(ref);
      const resp = Gateway.require_ok(Gateway.mask(await this.release(dev, skey)));
      return this.text(Gateway.attach_coerced(resp, notes));
    }
    if (name === "bmahs_call") {
      const [ref, notes, err] = this.prep_device(arguments_);
      if (err) throw new DeviceEnvelope(err as BmahsMessage);
      const dev = this.resolve_device(ref);
      let action = String(arguments_.action ?? "").trim();
      if (!action) throw new GatewayError("缺少 action 参数");
      const hello = await this.ensure_hello(dev);
      let op = find_op(hello, action);
      if (!op && this.arg_coerce) {
        // 动作名近似：只读动作自动改写；控制动作只建议、不代执行（防线②原则 3）
        const [hit, names] = sanitize.near_match_action(hello, action);
        if (hit !== null && READONLY_ACTIONS.has(hit)) {
          notes.push({
            arg: "action",
            from: action,
            to: hit,
            note:
              `动作名 ${JSON.stringify(action)} 不存在，已近似矫正为只读动作 ${JSON.stringify(hit)}`,
          });
          action = hit;
          op = find_op(hello, hit);
        } else if (hit !== null) {
          throw new DeviceEnvelope(
            sanitize.rich_error(
              `设备 ${dev.id} 的操作清单中没有动作 ${JSON.stringify(action)}。` +
                `最接近的是 ${JSON.stringify(hit)}（控制类动作，为安全起见网关不代为改写，请确认后显式调用）。`,
              { echo: { device: dev.id, action }, retry_with: { device: dev.id, action: hit } },
            ) as BmahsMessage,
          );
        } else {
          throw new DeviceEnvelope(
            sanitize.rich_error(`设备 ${dev.id} 的操作清单中没有动作 ${JSON.stringify(action)}。`, {
              echo: { device: dev.id, action },
              candidates: names.length > 0 ? names : undefined,
              retry_with: { device: dev.id, action: names[0] ?? action },
            }) as BmahsMessage,
          );
        }
      }
      let extra: unknown = arguments_.args;
      if (extra !== null && extra !== undefined && (typeof extra !== "object" || Array.isArray(extra)) && !this.arg_coerce) {
        throw new GatewayError("args 必须是对象（键为该动作的参数名）");
      }
      const anotes: sanitize.CoercedNote[] = [];
      if (this.arg_coerce) {
        const [a2, n2, e2] = sanitize.coerce_args_object(extra, op);
        if (e2) throw new DeviceEnvelope(e2 as BmahsMessage);
        extra = a2;
        if (a2 && op) {
          const [a3, n3] = sanitize.coerce_op_arguments(op, a2);
          extra = a3;
          anotes.push(...n3);
        }
        anotes.push(...n2);
      }
      const resp = Gateway.require_ok(
        Gateway.mask(await this.send_control(dev, action, extra as BmahsMessage, skey)),
      );
      return this.text(Gateway.attach_coerced(resp, [...notes, ...anotes]));
    }
    if (name === "bmahs_screenshot") {
      const [ref, notes, err] = this.prep_device(arguments_);
      if (err) throw new DeviceEnvelope(err as BmahsMessage);
      const dev = this.resolve_device(ref);
      let max_width: unknown = arguments_.max_width;
      if (this.arg_coerce && max_width !== null && max_width !== undefined) {
        const [v, n2, e2] = sanitize.coerce_int(max_width, "max_width", 640);
        if (e2) throw new DeviceEnvelope(e2 as BmahsMessage);
        max_width = v;
        notes.push(...n2);
      }
      return this.tool_screenshot(dev, max_width, skey, notes);
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
    if (!op && action === "describe") {
      // BMAHS_DEVICE_TOOLS 零参数别名：复用 describe 的可选参数实现
      return this.tool_describe({}, skey);
    }
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
    let payload_args = arguments_;
    let dnotes: sanitize.CoercedNote[] = [];
    if (this.arg_coerce) {
      const [a2, n2] = sanitize.coerce_op_arguments(op, arguments_);
      payload_args = a2;
      dnotes = n2;
    }
    const resp = Gateway.require_ok(Gateway.mask(await this.send_control(dev, action, payload_args, skey)));
    return this.text(Gateway.attach_coerced(resp, dnotes));
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
        "也可能是同一设备多网卡），控制结果可能不确定，建议先人工核实。" +
        "填参提醒：需要 device 参数的工具，device 直接填上面 devices[].id 的字符串本身，" +
        `例如 {\"device\": ${JSON.stringify(sanitize.example_device_ref(this))}}；` +
        "不要传对象或 {\"id\": \"名称\"} 映射。查单台设备状态优先用它的动态工具 " +
        "<id>__<动作>（各设备的 tool_names 已列出），bmahs_describe 用于读取完整操作清单。",
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
  async tool_screenshot(
    dev: Device,
    max_width?: unknown,
    skey = "local",
    coerced: sanitize.CoercedNote[] = [],
  ): Promise<ContentBlock[]> {
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
            ...(coerced.length > 0 ? { coerced } : {}),
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
