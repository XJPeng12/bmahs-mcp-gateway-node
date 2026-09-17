/**
 * BMAHS 发现层常量与编解码（对应最新协议 bmahs/1.0 §3/§4/§5/§A）。
 *
 * 字段名按最新标准：`version` / `protocol` / `timestamp` / `service` /
 * `capabilities` / `security`。解析侧同时接受旧版（bmahs/1.2 时期）的
 * `v` / `proto` / `ts` / `svc` / `caps` / `sec`，便于平滑迁移；
 * 发送侧一律使用新字段名（§7.4：不得用 `v` 之类的旧字段名）。
 */

export const PROTO = "bmahs/1.0";
export const PROTO_PREFIX = "bmahs"; // 智能体必须接受 bmahs*（现行候选 bmahs/1.0）

/** UDP 组播报文的三种类型（§3）：announce=设备上线/状态变化广播，query=智能体主动扫描（设备以 announce 应答），goodbye=设备下线告别。 */
export const KINDS = ["announce", "query", "goodbye"] as const;
export type Kind = (typeof KINDS)[number];

/** 发现层组播组与端口：IPv4/IPv6 双栈，设备与智能体都在这两个组上收发 */
export const MULTICAST_V4 = "239.255.42.42";
export const MULTICAST_V6 = "ff02::4242";
export const DISCOVERY_PORT = 5354;

/** 协议硬性上限：一个 UDP 数据报 = 一个完整 JSON，不得超过 1400 字节（避免 IP 分片） */
export const MAX_DGRAM = 1400;

/** control（TCP 行协议，hello/动作）与 ui（二进制视频流）的缺省端口 */
export const DEFAULT_CONTROL_PORT = 9527;
export const DEFAULT_UI_PORT = 9531;

/** 稳态 announce 间隔（§4.6 存活检测）：出厂默认 5 秒，硬性下限，只允许调大 */
export const DEFAULT_HB = 5.0;
export const HB_MIN = 5.0;

/** 全品类必须在 operations 中声明并实现的动作（§4.5） */
export const GENERIC_ACTIONS: ReadonlySet<string> = new Set([
  "describe",
  "info",
  "register",
  "occupy",
  "release",
  "who",
]);

/** 只读 / 登记刷新动作：不改变受管关系，不需要 token（§4.6 规则 2） */
export const READONLY_ACTIONS: ReadonlySet<string> = new Set([
  "describe",
  "info",
  "who",
  "register",
]);

/** 默认占用租约（§4.6）：未带 ttl 的 occupy 用 60 秒；9999 = 无限期 */
export const DEFAULT_LEASE_SEC = 60;
export const LEASE_UNLIMITED = 9999;

/** query 应答限频（§5.1）：同一发送方（按 id）1 秒内只应答一次 */
export const QUERY_REPLY_MIN_INTERVAL = 1.0;

/** BMAHS 报文：字段在协议各节定义，这里按宽松对象处理（§4.1 必须忽略未知字段） */
export type BmahsMessage = Record<string, unknown>;

const URI_RE = /^tcp:\/\/(\[[0-9A-Fa-f:.]+\]|[^:[\]/]+):(\d+)$/;

export function now(): number {
  return Math.floor(Date.now() / 1000);
}

/** 由显示名生成稳定 id（§4.3）：非法字符改 -，去首尾 -，小写。 */
export function sanitize_id(name: string): string {
  const out = String(name)
    .replace(/[^A-Za-z0-9-]/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return out || "bmahs-device";
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/**
 * 解析并校验一个 UDP 报文；不合规按 §4.1 直接丢弃（返回 null）。
 *
 * 兼容期：公共头同时接受新（`version`/`protocol`）旧（`v`/`proto`）
 * 字段名；返回的对象统一补齐新字段名，调用方无需再区分。
 */
export function parse_message(data: Buffer | string): BmahsMessage | null {
  let msg: unknown;
  try {
    const text = typeof data === "string" ? data : data.toString("utf-8");
    msg = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(msg)) return null;
  const version = msg.version ?? msg.v;
  if (version !== 1) return null;
  const proto = msg.protocol ?? msg.proto;
  if (typeof proto !== "string" || !proto.startsWith(PROTO_PREFIX)) return null;
  if (!KINDS.includes(msg.kind as Kind)) return null;
  if (typeof msg.id !== "string" || !msg.id) return null;
  // 统一回填新字段名（原文里可能只有旧名）
  if (!("version" in msg)) msg.version = 1;
  if (!("protocol" in msg)) msg.protocol = proto;
  if (!("timestamp" in msg)) msg.timestamp = typeof msg.ts === "number" ? msg.ts : now();
  if (!("service" in msg) && typeof msg.svc === "string") msg.service = msg.svc;
  if (!("capabilities" in msg) && Array.isArray(msg.caps)) msg.capabilities = msg.caps;
  if (!("security" in msg) && isRecord(msg.sec)) msg.security = msg.sec;
  return msg;
}

/** 构造智能体的扫描报文（§3.1）：设备收到后按 want 过滤并以 announce 应答。 */
export function build_query(agent_id: string, want = "*"): Buffer {
  return dump_message({
    version: 1,
    protocol: PROTO,
    kind: "query",
    timestamp: now(),
    id: agent_id,
    want: want || "*",
  });
}

/** 构造设备上线/状态变化广播（§4.2）：周期性发送，兼作心跳；新设备上电后立即发一次。 */
export function build_announce(device: BmahsMessage): Buffer {
  return dump_message({
    version: 1,
    protocol: PROTO,
    kind: "announce",
    timestamp: now(),
    ...device,
  });
}

/** 构造设备下线告别报文（§4.3）：设备优雅退出时发送，智能体收到后移除该设备。 */
export function build_goodbye(device: BmahsMessage): Buffer {
  return dump_message({
    version: 1,
    protocol: PROTO,
    kind: "goodbye",
    timestamp: now(),
    state: "offline",
    event: "offline",
    ...device,
  });
}

function json_encode(msg: BmahsMessage): Buffer {
  return Buffer.from(JSON.stringify(msg), "utf-8");
}

/** 一个数据报 = 一个 UTF-8 JSON 对象，≤1400 字节。
 *
 * 超长时逐级收缩摘要字段（截短 summary → 丢弃 summary/model/ipv6/event →
 * 丢弃 capabilities/security 摘要），保证接收方拿到的始终是合法 JSON；
 * 仅极端情况下才硬截断。
 */
function dump_message(msg: BmahsMessage): Buffer {
  let data = json_encode(msg);
  if (data.length <= MAX_DGRAM) return data;
  const trimmed: BmahsMessage = { ...msg };
  const summary = trimmed.summary;
  if (typeof summary === "string") {
    for (const cut of [80, 40]) {
      trimmed.summary = summary.slice(0, cut);
      data = json_encode(trimmed);
      if (data.length <= MAX_DGRAM) return data;
    }
    delete trimmed.summary;
  }
  for (const key of ["model", "event", "ipv6", "capabilities", "security"]) {
    delete trimmed[key];
    data = json_encode(trimmed);
    if (data.length <= MAX_DGRAM) return data;
  }
  return data.subarray(0, MAX_DGRAM);
}

/** 解析 tcp://IP:PORT / tcp://[IPv6]:PORT → { host, port }。 */
export function parse_control_uri(uri: string | null | undefined): { host: string; port: number } | null {
  if (!uri) return null;
  const m = URI_RE.exec(uri.trim());
  if (!m) return null;
  let host = m[1] as string;
  if (host.startsWith("[")) host = host.slice(1, -1);
  return { host, port: parseInt(m[2] as string, 10) };
}

/** query.want 匹配算法（§4.4）：空 / * / bmahs = 全部；否则逗号分隔 type 列表。 */
export function matches_want(device_type: string | null | undefined, want: string | null | undefined): boolean {
  const t = (device_type || "").toLowerCase();
  const parts = (want || "*")
    .split(",")
    .map((w) => w.trim().toLowerCase())
    .filter((w) => w.length > 0);
  if (parts.length === 0 || parts.includes("*") || parts.includes("bmahs")) return true;
  return parts.includes(t);
}

/** 读取设备公告的心跳间隔（§5.1 `hb`，缺省视为 5 秒）。 */
export function hb_of(msg: BmahsMessage): number {
  const hb = msg.hb;
  if (typeof hb === "number" && Number.isFinite(hb) && hb > 0) return hb;
  return DEFAULT_HB;
}

/** 无心跳删除时限（§4.6/§4.8-7）：clamp(12 × hb, 60 秒, 30 分钟)。 */
export function expire_sec_for(hb: number): number {
  return Math.max(60.0, Math.min(12.0 * Math.max(hb, DEFAULT_HB), 1800.0));
}
