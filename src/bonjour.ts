/**
 * Bonjour / DNS-SD 助手（协议 §3.2 / §6.4，应当实现）。
 *
 * 网关只用到智能体端：浏览 `_bmahs._tcp`，把服务增删事件回调给发现层
 * （协议 §3.2：智能体应发送 query 并/或浏览 Bonjour）。这是组播之外的第二
 * 发现通道：UDP 组播静默但 mDNS/TCP 正常的设备（多网卡绑错接口的常见病）
 * 也能进入注册表。设备端 Advertiser 见 examples/demo_light.py（Python 版），
 * 网关不需要。
 *
 * 降级（重要）：bonjour-service 不可用或浏览失败不致命——start 返回 false，
 * 设备照常走 UDP 发现（§3.1 是必须项，本节是应当项）。Node 侧 bonjour-service
 * 为纯 JS 实现，事件回调在本进程事件循环内执行；所有回调入口 try/catch 收敛，
 * 浏览器异常只导致 Bonjour 通道降级，不影响 UDP 组播发现与网关进程。
 */

import { log_debug } from "./logging.js";

export const SERVICE_TYPE = "bmahs"; // bonjour-service 会展开为 _bmahs._tcp.local.
export const TXTVERS = "1";

type AnyRecord = Record<string, unknown>;

/** 按协议 §6.4 把 announce 摘要转成 TXT 键值（全部字符串，capabilities 逗号分隔）。 */
export function build_txt(props: AnyRecord): Record<string, string> {
  const caps = (props.capabilities as unknown[] | undefined) ?? [];
  const sec = (props.security as AnyRecord | undefined) ?? {};
  const txt: Record<string, string> = {
    txtvers: TXTVERS,
    protocol: str_of(props.protocol, ""),
    type: str_of(props.type, ""),
    service: str_of(props.service, ""),
    id: str_of(props.id, ""),
    name: str_of(props.name, ""),
    capabilities: caps.map((c) => String(c)).join(","),
    security: `${sec.scope ?? ""},${sec.auth ?? ""}`,
    state: str_of(props.state, "registered"),
    busy: props.busy ? "1" : "0",
  };
  if (props.summary) {
    // TXT 建议整包 < 400 字节：summary 截断到 80 字，完整语义以 TCP hello 为准
    txt.summary = String(props.summary).slice(0, 80);
  }
  if (props.model) txt.model = String(props.model);
  if (props.event) txt.event = String(props.event);
  if (props.ip) txt.ip = String(props.ip);
  if (props.ipv6) txt.ipv6 = String(props.ipv6);
  if (props.hb) txt.hb = String(props.hb);
  if (props.holder) txt.holder = String(props.holder);
  return txt;
}

function str_of(v: unknown, fallback: string): string {
  return v === null || v === undefined ? fallback : String(v);
}

/** 把 `_bmahs._tcp` 的 TXT 记录 + SRV 地址还原为 announce 摘要（build_txt 的逆）。
 *
 * 供智能体端 Bonjour 浏览通道使用：设备 TCP hello 到手前，注册表里也能展示
 * name/summary/type 等摘要。字段缺失一律留空，完整自述以 TCP hello 为准；
 * 键值容忍 bytes（mDNS 文本记录的原始形态）。
 */
export function txt_to_announce(txt: Record<string, string | Buffer>, host: string, port: number): AnyRecord {
  const s = (v: string | Buffer | undefined): string => {
    if (typeof v === "string") return v;
    if (Buffer.isBuffer(v)) return v.toString("utf-8");
    return "";
  };
  const norm: Record<string, string | Buffer> = {};
  for (const [k, v] of Object.entries(txt)) norm[String(k)] = v;
  const sec = s(norm.security as string | Buffer).split(",");
  const hb = s(norm.hb as string | Buffer);
  return {
    // 来源标记：真 UDP announce 的 kind 是 "announce"；注册表靠它区分
    // 「UDP 见过的设备」与「只有 Bonjour 见过的设备」（影响下线/过期语义）
    kind: "bonjour",
    protocol: s(norm.protocol as string | Buffer),
    type: s(norm.type as string | Buffer),
    service: s(norm.service as string | Buffer),
    id: s(norm.id as string | Buffer),
    name: s(norm.name as string | Buffer),
    summary: s(norm.summary as string | Buffer),
    model: s(norm.model as string | Buffer),
    control: `tcp://${host}:${port}`,
    capabilities: s(norm.capabilities as string | Buffer)
      .split(",")
      .filter((c) => c.length > 0),
    security: sec.length >= 2 ? { scope: sec[0], auth: sec[1] } : {},
    state: s(norm.state as string | Buffer) || "registered",
    busy: s(norm.busy as string | Buffer) === "1",
    hb: /^\d+$/.test(hb) ? parseInt(hb, 10) : null,
  };
}

export type BonjourAddCallback = (host: string, port: number, txt: Record<string, string | Buffer>) => void;
export type BonjourRemoveCallback = (name: string, dev_id: string, host: string, port: number) => void;

/** 浏览局域网内的 `_bmahs._tcp`（协议 §3.2 智能体端「应当浏览」）。
 *
 * 第二发现通道：UDP 组播静默但 mDNS/TCP 正常的设备也能进入注册表。
 * 依赖缺失或浏览失败只降级（start 返回 false），不影响 UDP 组播发现。
 */
export class BonjourBrowser {
  private on_add: BonjourAddCallback | null = null;
  private on_remove: BonjourRemoveCallback | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- bonjour-service 的类型随版本变动，动态导入后用 any
  private browser: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private instance: any = null;
  /** 服务实例名 -> { host, port, dev_id }：remove 事件只给名字，靠它找回设备 */
  private seen = new Map<string, { host: string; port: number; dev_id: string }>();
  private alive = false;

  /** 浏览当前是否生效（false 不影响 UDP 发现，仅少了 Bonjour 通道）。 */
  get active(): boolean {
    return this.alive;
  }

  /** 开始浏览。on_add / on_remove 都在当前事件循环线程执行。返回 false 表示依赖不可用（降级）。 */
  async start(on_add: BonjourAddCallback, on_remove: BonjourRemoveCallback): Promise<boolean> {
    let mod: any;
    try {
      mod = await import("bonjour-service");
    } catch {
      log_debug("未安装 bonjour-service，跳过 Bonjour 浏览（不影响 UDP 组播发现）");
      return false;
    }
    this.on_add = on_add;
    this.on_remove = on_remove;
    try {
      const instance = new mod.Bonjour();
      this.instance = instance;
      const browser = instance.find({ type: SERVICE_TYPE }, (svc: any) => {
        this.safe(() => this.service_up(svc));
      });
      browser.on("down", (svc: any) => {
        this.safe(() => this.service_down(svc));
      });
      browser.on("error", (e: Error) => {
        log_debug(`Bonjour 浏览错误（降级忽略）: ${e.message}`);
      });
      this.browser = browser;
      this.alive = true;
      return true;
    } catch (e) {
      log_debug(`Bonjour 浏览启动失败（降级）: ${(e as Error).message}`);
      this.alive = false;
      return false;
    }
  }

  /** 停浏览、释放 mDNS 资源；失败静默（进程本就要退出了）。 */
  async stop(): Promise<void> {
    this.alive = false;
    try {
      this.browser?.stop?.();
    } catch {
      /* 忽略 */
    }
    try {
      this.instance?.destroy?.();
    } catch {
      /* 忽略 */
    }
    this.browser = null;
    this.instance = null;
    this.seen.clear();
  }

  // ------------------------------------------------------------------ 事件处理

  private service_up(svc: any): void {
    const addresses: string[] = Array.isArray(svc.addresses) ? svc.addresses : [];
    // 优先 IPv4：BMAHS control 层公告的是 IPv4 地址
    const host = addresses.find((a) => !a.includes(":")) ?? addresses[0] ?? "";
    const port = typeof svc.port === "number" ? svc.port : 0;
    if (!host || port <= 0) return; // 地址还没解析出来：等下一次 update
    const txt: Record<string, string | Buffer> = {};
    for (const [k, v] of Object.entries(svc.txt ?? {})) {
      if (v !== undefined && v !== null) txt[String(k)] = typeof v === "string" ? v : String(v);
    }
    const dev_id = txt.id != null ? String(txt.id) : "";
    this.seen.set(String(svc.name), { host, port, dev_id });
    this.on_add?.(host, port, txt);
  }

  private service_down(svc: any): void {
    const name = String(svc?.name ?? "");
    const rec = this.seen.get(name) ?? { host: "", port: 0, dev_id: "" };
    this.seen.delete(name);
    this.on_remove?.(name, rec.dev_id, rec.host, rec.port);
  }

  private safe(fn: () => void): void {
    try {
      fn();
    } catch (e) {
      log_debug(`Bonjour 事件处理失败（忽略）: ${(e as Error).message}`);
    }
  }
}
