/**
 * BMAHS 发现层客户端（协议 §3/§5）。
 *
 * 网关扮演协议中的「智能体」角色：
 * - 发送 `query`（启动时 + 周期性）；
 * - 监听组播，收集 `announce`（按 id 去重）、`goodbye`（移除）；
 * - 浏览 Bonjour `_bmahs._tcp`（协议 §3.2「应当浏览」）：TXT 摘要入库、
 *   服务下线即移除——组播静默但 mDNS/TCP 正常的设备的第二发现通道；
 * - 超过无心跳删除时限（默认 30 分钟）未更新的设备从列表删除（§4.8 第 7 条；
 *   静态/Bonjour 设备除外，后者的生命周期由登记值 / mDNS 记录驱动）。
 *
 * 另支持静态设备表（BMAHS_STATIC_DEVICES，逗号分隔的 tcp://host:port），
 * 用于无组播环境（如容器、跨网段）。
 */

import * as dgram from "node:dgram";
import * as os from "node:os";
import {
  DEFAULT_HB,
  DISCOVERY_PORT,
  MAX_DGRAM,
  MULTICAST_V4,
  MULTICAST_V6,
  build_query,
  expire_sec_for,
  hb_of,
  now,
  parse_control_uri,
  parse_message,
  type BmahsMessage,
} from "./protocol.js";
import { BonjourBrowser, txt_to_announce } from "./bonjour.js";
import { get_logger } from "./logging.js";

/** 简易 stderr 日志（网关以 stdio 运行时绝不能打印 stdout）。 */
const log = get_logger("discovery");

/** 注册表中的一台设备。动态设备以 announce.id 为键；静态/Bonjour 设备
 * 初始以 `static:host:port` / 设备 id（或 `bonjour:host:port` 过渡键）入库，
 * 读到 hello 后统一重键为设备 id。 */
export class Device {
  /** 最近一次 announce 报文原文（§4.2 公共头 + 摘要字段）；Bonjour 通道的设备在 UDP 见到它之前，存放 TXT 还原的摘要 */
  announce: BmahsMessage = {};
  /** 首次发现 / 最近一次确认存活的时间（Unix 秒）；last_seen 是过期删除的依据 */
  first_seen = 0;
  last_seen = 0;
  /** TCP hello（§6.2）；null 表示尚未读过 hello（该设备的动态工具尚未生成） */
  hello: BmahsMessage | null = null;
  /** hello 最近一次成功读取 / 刷新的时刻（monotonic 秒） */
  hello_at = 0.0;
  /** hello 上次读取失败的时刻（monotonic 秒），用于失败后的重试退避 */
  hello_fail_at = 0.0;
  /** 静态设备登记的 tcp://host:port（BMAHS_STATIC_DEVICES）；其余设备为 null */
  static_uri: string | null = null;
  /** Bonjour 浏览登记的 tcp://host:port；该通道设备的生命周期由 mDNS 记录增删驱动，不参与心跳过期 */
  bonjour_uri: string | null = null;

  constructor(public key: string) {}

  /** 设备唯一 id：优先取 hello（最权威），其次 announce，兜底用注册表键。 */
  get id(): string {
    if (this.hello && this.hello.id) return String(this.hello.id);
    return String(this.announce.id ?? this.key);
  }

  /** 设备显示名（人类可读，供模型选型），取不到时退回注册表键。 */
  get name(): string {
    const src = this.hello ?? this.announce;
    return String(src.name ?? this.key);
  }

  /** control 层 TCP 地址。优先级：静态登记 > UDP announce 的 control > Bonjour SRV 地址。 */
  get uri(): string | null {
    return (
      this.static_uri ??
      (typeof this.announce.control === "string" ? this.announce.control : null) ??
      this.bonjour_uri
    );
  }

  /** 设备公告的受管状态（§4.6）：registered=空闲可占用，managed=已被占用，offline=已下线。 */
  get state(): string {
    const src = this.hello ?? this.announce;
    return String(src.state ?? "unknown");
  }

  /** 当前占用方标识（agent 名）；null 表示无人占用。 */
  get holder(): string | null {
    const src = this.hello ?? this.announce;
    return src.holder != null ? String(src.holder) : null;
  }

  /** 当前占用租约的到期时刻（Unix 秒）；0 表示未占用或设备未公告。 */
  get until(): number {
    const src = this.hello ?? this.announce;
    const v = src.until;
    return typeof v === "number" ? v : 0;
  }

  /** 设备来源："static"（环境变量登记）、"bonjour"（mDNS 浏览）或 "multicast"（UDP 组播）。 */
  get source(): string {
    if (this.static_uri) return "static";
    return this.bonjour_uri ? "bonjour" : "multicast";
  }
}

function monotonic(): number {
  return performance.now() / 1000;
}

export interface DiscoveryOptions {
  query_interval?: number;
  expire_sec?: number;
  static_uris?: string[];
  bonjour?: boolean;
  on_change?: () => Promise<void> | void;
}

export class Discovery {
  agent_id: string;
  query_interval: number;
  expire_sec: number;
  static_uris: string[];
  bonjour: boolean;
  on_change: (() => Promise<void> | void) | null;
  /** 注册表：key -> Device；设备的增删与状态更新都发生在这里 */
  devices = new Map<string, Device>();

  private browser: BonjourBrowser | null = null;
  private rx4: dgram.Socket | null = null;
  private rx6: dgram.Socket | null = null;
  private send4: dgram.Socket | null = null;
  private send6: dgram.Socket | null = null;
  private send4_init: Promise<dgram.Socket | null> | null = null;
  private send6_init: Promise<dgram.Socket | null> | null = null;
  private timers: NodeJS.Timeout[] = [];
  private stopping = false;
  /** 多网卡主机（如装有 VMware/Hyper-V 的 Windows）上，内核默认选中的组播
   * 接口往往不是目标网段。因此对全部本机 IPv4 逐一 join + 逐一发送；
   * BMAHS_MCAST_IF_V4 可手动指定（逗号分隔 IP）。列表按查询周期刷新，
   * DHCP 续租 / 网卡变化后能自愈。 */
  private v4_addrs: string[];
  private joined_v4 = new Set<string>();
  private bg = new Set<Promise<unknown>>();

  constructor(agent_id: string, opts: DiscoveryOptions = {}) {
    this.agent_id = agent_id;
    this.query_interval = Math.max(30.0, opts.query_interval ?? 300.0);
    this.expire_sec = Math.max(60.0, opts.expire_sec ?? 1800.0);
    this.static_uris = opts.static_uris ?? [];
    this.bonjour = opts.bonjour ?? true;
    this.on_change = opts.on_change ?? null;
    this.v4_addrs = local_v4_addrs();
  }

  // ------------------------------------------------------------------ 生命周期

  /** 登记静态设备 → 启动 Bonjour 浏览 → 打开 IPv4/IPv6 组播接收 → 启动周期任务 → 立即扫描一次。 */
  async start(): Promise<void> {
    for (const uri of this.static_uris) this.add_static(uri);
    if (this.bonjour) {
      const browser = new BonjourBrowser();
      if (await browser.start((h, p, txt) => this.on_bonjour_add(h, p, txt), (n, id, h, p) => this.on_bonjour_remove(n, id, h, p))) {
        this.browser = browser; // 启动失败（bonjour-service 缺失等）只降级
      } else {
        log.warn("Bonjour 浏览通道启动失败，仅依赖 UDP 组播与静态设备表");
      }
    }
    this.rx4 = await this.open_rx4();
    if (!this.rx4) log.warn("IPv4 组播接收不可用（发现将依赖静态设备表）");
    this.rx6 = await this.open_rx6();
    if (!this.rx6) log.debug("IPv6 组播接收不可用（可忽略，IPv4 仍可用）");
    this.timers.push(setInterval(() => void this.query_loop_tick(), this.query_interval * 1000));
    this.timers.push(setInterval(() => {
      if (this.purge_expired().length > 0) this.fire_change();
    }, 30_000));
    await this.query();
  }

  private async query_loop_tick(): Promise<void> {
    try {
      this.refresh_v4_membership();
      await this.query();
    } catch (e) {
      log.debug(`query 发送失败: ${(e as Error).message}`);
    }
  }

  /** 停掉周期任务、关闭组播套接字与 Bonjour 浏览；幂等，进程退出前调用。 */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.browser) {
      await this.browser.stop();
      this.browser = null;
    }
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    for (const s of [this.rx4, this.rx6, this.send4, this.send6]) {
      try {
        s?.close();
      } catch {
        /* 已关闭/未初始化 */
      }
    }
    this.rx4 = this.rx6 = this.send4 = this.send6 = null;
    this.send4_init = this.send6_init = null;
    this.joined_v4.clear();
  }

  // ------------------------------------------------------------------ 查询与注册表

  /** 向两个组播组各发一次 query（§3.1：智能体应对两个组各发一次）。 */
  async query(want = "*"): Promise<void> {
    const payload = build_query(this.agent_id, want);
    await this.send_multicast(payload);
  }

  /** 登记一台静态设备（无组播环境用）；URI 非法时告警并返回 null。 */
  add_static(uri: string): Device | null {
    const target = parse_control_uri(uri.trim());
    if (!target) {
      log.warn(`无法解析静态设备地址: ${JSON.stringify(uri)}`);
      return null;
    }
    const key = `static:${target.host}:${target.port}`;
    let dev = this.devices.get(key);
    if (!dev) {
      dev = new Device(key);
      dev.static_uri = `tcp://${target.host}:${target.port}`;
      dev.first_seen = dev.last_seen = now();
      this.devices.set(key, dev);
      log.info(`登记静态设备 ${dev.static_uri}`);
    }
    return dev;
  }

  // ------------------------------------------------------------------ Bonjour 通道（§3.2）

  /** Bonjour 服务出现/更新（BonjourBrowser 投递回主循环后调用）。
   *
   * TXT 还原出 announce 摘要，使 UDP 组播静默的设备在 hello 前就能被列表
   * 展示与选中；已被 UDP/静态通道发现的设备只补 bonjour_uri，不重复建条目。
   */
  on_bonjour_add(host: string, port: number, txt: Record<string, string | Buffer>): void {
    if (this.stopping || !host || port <= 0) return;
    const uri = `tcp://${host}:${port}`;
    const preview = txt_to_announce(txt, host, port);
    const dev_id = preview.id ? String(preview.id) : "";
    let dev = dev_id ? this.get(dev_id) : null;
    if (!dev) dev = this.devices.get(dev_id || `bonjour:${host}:${port}`) ?? null;
    const is_new = dev === null;
    if (!dev) {
      dev = new Device(dev_id || `bonjour:${host}:${port}`);
      dev.first_seen = now();
      this.devices.set(dev.key, dev);
      log.info(
        `Bonjour 发现设备 ${dev_id || dev.key}（${preview.type}/${preview.service}，${preview.name}）@ ${uri}`,
      );
    }
    const changed = is_new || dev.bonjour_uri !== uri;
    dev.bonjour_uri = uri;
    dev.last_seen = now();
    if (dev.announce.kind !== "announce") {
      // UDP 通道从未见过它（当前只是 TXT 还原的摘要）：摘要顶上并随
      // Bonjour 记录刷新（换端口/换地址）；组播可见的设备以 announce 为准
      dev.announce = preview;
    }
    if (changed) this.fire_change();
  }

  /** Bonjour 服务记录消失（mDNS 过期/注销）；按通道优先级收敛设备条目。 */
  on_bonjour_remove(name: string, dev_id: string, host: string, port: number): void {
    if (this.stopping) return;
    let dev = dev_id ? this.get(dev_id) : null;
    if (!dev && host) dev = this.devices.get(`bonjour:${host}:${port}`) ?? null;
    if (!dev || dev.static_uri) return; // 静态登记的设备不随 mDNS 下线（登记值仍在，重连即恢复）
    dev.bonjour_uri = null;
    if (dev.announce.kind !== "announce") {
      // 只有 Bonjour 见过它（announce 是 TXT 还原的摘要）：随 mDNS 记录一起下线
      this.devices.delete(dev.key);
      log.info(`Bonjour 服务 ${name} 已下线，移除设备 ${dev_id || dev.key}`);
    }
    this.fire_change();
  }

  /** 按注册表键或设备 id 查设备（兼容静态设备重键前的过渡期）。 */
  get(device_id: string): Device | null {
    const dev = this.devices.get(device_id);
    if (dev) return dev;
    for (const d of this.devices.values()) {
      if (d.id === device_id) return d;
    }
    return null;
  }

  /** 当前注册表快照（所有已知设备，含尚未读到 hello 的）。 */
  all(): Device[] {
    return [...this.devices.values()];
  }

  /** 把 hello 绑定到设备；静态/Bonjour 设备借此从过渡键重键为设备 id。 */
  bind_hello(key: string, hello: BmahsMessage): Device | null {
    const dev = this.devices.get(key);
    if (!dev) {
      return this.get(String(hello.id ?? key));
    }
    dev.hello = hello;
    dev.hello_at = monotonic();
    dev.hello_fail_at = 0.0;
    // TCP 上成功读到 hello 即证明设备存活：刷新 last_seen，跨网段/组播静默
    // 设备不会被心跳过期误删
    dev.last_seen = now();
    const dev_id = hello.id ? String(hello.id) : "";
    if ((dev.static_uri || dev.bonjour_uri) && dev_id && dev.key !== dev_id) {
      this.devices.delete(dev.key);
      dev.key = dev_id;
      const existing = this.devices.get(dev_id);
      if (existing !== dev) this.devices.set(dev_id, dev);
    }
    return dev;
  }

  // ------------------------------------------------------------------ 报文处理

  /** 处理一个组播报文：announce 入库（新增/变化触发回调），goodbye 移除，其余忽略。 */
  on_datagram(data: Buffer, _addr: dgram.RemoteInfo): void {
    if (this.stopping || data.length > MAX_DGRAM) return;
    const msg = parse_message(data);
    if (!msg) return;
    const kind = msg.kind;
    const dev_id = String(msg.id);
    if (dev_id === this.agent_id) return; // 收到自己的报文（协议 §5.1：忽略）
    if (kind === "query") return; // 别的智能体在扫描，与网关无关
    if (kind === "announce") {
      if (this.upsert(dev_id, msg)) this.fire_change();
    } else if (kind === "goodbye") {
      if (this.remove(dev_id)) {
        log.info(`设备 ${dev_id} 已下线（goodbye）`);
        this.fire_change();
      }
    }
  }

  /** 入库一条 announce：新建设备或刷新其 announce/last_seen。
   *
   * 返回 true 表示注册表发生了可观察变化（新设备，或 control/state 变化），
   * 调用方据此触发 on_change（进而重建 MCP 工具表）。
   */
  private upsert(dev_id: string, msg: BmahsMessage): boolean {
    let dev = this.devices.get(dev_id) ?? null;
    if (!dev) {
      for (const d of this.devices.values()) {
        if ((d.static_uri || d.bonjour_uri) && d.id === dev_id) {
          dev = d;
          break;
        }
      }
    }
    const is_new = dev === null;
    if (!dev) {
      dev = new Device(dev_id);
      dev.first_seen = now();
      this.devices.set(dev.key, dev);
      log.info(`发现设备 ${dev_id}（${msg.type}/${msg.service}，${msg.name}）@ ${msg.control}`);
    }
    const changed =
      dev.announce.control !== msg.control || dev.announce.state !== msg.state;
    dev.announce = msg;
    dev.last_seen = now();
    return is_new || changed;
  }

  /** 把设备移出注册表（goodbye 下线）；静态设备不删（登记值仍在，重连即恢复）。 */
  private remove(dev_id: string): boolean {
    const dev = this.get(dev_id);
    if (!dev || dev.static_uri) return false;
    this.devices.delete(dev.key);
    return true;
  }

  /** 调度一次 on_change 回调（异步、异常隔离），通知上层设备列表已变化。 */
  private fire_change(): void {
    if (!this.on_change) return;
    const p = Promise.resolve()
      .then(() => this.on_change!())
      .catch((e: Error) => log.debug(`on_change 回调失败: ${e.message}`));
    this.bg.add(p);
    void p.finally(() => this.bg.delete(p));
  }

  // ------------------------------------------------------------------ 周期任务

  /** 删除超过无心跳时限的设备（静态/Bonjour 设备不过期），返回被移除的键。
   *
   * §4.6/§4.8-7：时限按设备公告的 `hb` 逐台计算 = clamp(12 × hb, 60 秒, 30 分钟)；
   * 无 hb / 未知对端按缺省 5 秒（即 60 秒）。Bonjour 设备的存活由 mDNS 记录增删
   * 驱动（on_bonjour_remove），不参与心跳过期，否则无组播心跳的它们会被立即误删。
   */
  purge_expired(): string[] {
    const gone: string[] = [];
    for (const d of this.devices.values()) {
      if (d.static_uri || d.bonjour_uri) continue;
      const hb = Object.keys(d.announce).length > 0 ? hb_of(d.announce) : DEFAULT_HB;
      // 上限仍受构造参数 expire_sec 约束（缺省 1800s = 协议上限 30 分钟）
      const limit = Math.min(expire_sec_for(hb), this.expire_sec);
      if (d.last_seen < now() - Math.floor(limit)) gone.push(d.key);
    }
    for (const key of gone) {
      this.devices.delete(key);
      log.info(`设备 ${key} 超过无心跳删除时限，已移除`);
    }
    return gone;
  }

  // ------------------------------------------------------------------ 套接字

  /** 创建 IPv4 组播接收套接字：REUSEADDR + 绑定 5354 端口 + 在全部网卡上 join。失败返回 null。 */
  private open_rx4(): Promise<dgram.Socket | null> {
    return new Promise((resolve) => {
      const s = dgram.createSocket({ type: "udp4", reuseAddr: true });
      let bound = false;
      s.on("error", (e) => {
        if (!bound) {
          log.warn(`IPv4 绑定 ${DISCOVERY_PORT} 失败: ${e.message}`);
          try {
            s.close();
          } catch {
            /* 忽略 */
          }
          resolve(null);
        }
        // 绑定后的错误（网卡抖动等）在这里吞掉，避免打崩进程
      });
      s.bind(DISCOVERY_PORT, () => {
        bound = true;
        s.on("message", (data, rinfo) => this.on_datagram(data as Buffer, rinfo));
        let joined = 0;
        for (const ip of this.v4_addrs) {
          if (join_v4(s, ip, this.joined_v4)) joined += 1;
        }
        if (joined === 0) {
          s.close();
          log.warn("无法加入 239.255.42.42 组播组");
          resolve(null);
          return;
        }
        resolve(s);
      });
    });
  }

  /** 创建 IPv6 组播接收套接字：在每个接口的 scope 上 join ff02::4242（尽力而为）。失败返回 null。 */
  private open_rx6(): Promise<dgram.Socket | null> {
    return new Promise((resolve) => {
      let s: dgram.Socket;
      try {
        s = dgram.createSocket({ type: "udp6", reuseAddr: true });
      } catch {
        resolve(null);
        return;
      }
      let bound = false;
      s.on("error", () => {
        if (!bound) {
          try {
            s.close();
          } catch {
            /* 忽略 */
          }
          resolve(null);
        }
      });
      s.bind(DISCOVERY_PORT, () => {
        bound = true;
        let joined = 0;
        for (const idx of v6_if_indexes()) {
          try {
            s.addMembership(MULTICAST_V6, String(idx));
            joined += 1;
          } catch {
            continue;
          }
        }
        if (joined === 0) {
          s.close();
          resolve(null);
          return;
        }
        resolve(s);
      });
    });
  }

  /** 重解析本机地址：新增接口补 join，消失的接口退组。
   *
   * 接口列表若只在初始化时快照一次，DHCP 续租 / 换网后旧成员关系失效、
   * 新地址未加入，组播会永久失聪，只能重启进程恢复。
   */
  refresh_v4_membership(): void {
    if (!this.rx4) return;
    const addrs = local_v4_addrs();
    if (JSON.stringify(addrs) === JSON.stringify(this.v4_addrs)) return;
    for (const ip of addrs) {
      if (!this.joined_v4.has(ip)) join_v4(this.rx4, ip, this.joined_v4);
    }
    for (const ip of [...this.joined_v4]) {
      if (!addrs.includes(ip)) {
        try {
          this.rx4.dropMembership(MULTICAST_V4, ip);
        } catch {
          /* 接口已消失 */
        }
        this.joined_v4.delete(ip);
      }
    }
    this.v4_addrs = addrs;
    log.info(`组播接口已刷新: ${addrs.join(", ")}`);
  }

  /** 惰性创建并绑定发送套接字（Windows 上必须先 bind 才能设组播参数）。 */
  private get_send4(): Promise<dgram.Socket | null> {
    if (this.send4) return Promise.resolve(this.send4);
    if (!this.send4_init) {
      this.send4_init = new Promise((resolve) => {
        const s = dgram.createSocket("udp4");
        s.on("error", () => {
          /* 发送失败按逐次 try/catch 处理 */
        });
        s.bind(() => {
          try {
            s.setMulticastTTL(2);
          } catch {
            /* 平台不支持 */
          }
          try {
            s.setMulticastLoopback(true);
          } catch {
            /* 平台不支持 */
          }
          this.send4 = s;
          resolve(s);
        });
      });
    }
    return this.send4_init;
  }

  private get_send6(): Promise<dgram.Socket | null> {
    if (this.send6) return Promise.resolve(this.send6);
    if (!this.send6_init) {
      this.send6_init = new Promise((resolve) => {
        let s: dgram.Socket;
        try {
          s = dgram.createSocket("udp6");
        } catch {
          resolve(null);
          return;
        }
        s.on("error", () => {});
        s.bind(() => {
          try {
            s.setMulticastTTL(2);
          } catch {
            /* 平台不支持 */
          }
          this.send6 = s;
          resolve(s);
        });
      });
    }
    return this.send6_init;
  }

  private async send_multicast(payload: Buffer): Promise<void> {
    // IPv4：逐网卡各发一次（TTL=2）
    try {
      const s4 = await this.get_send4();
      if (!s4) throw new Error("发送套接字创建失败");
      let sent = 0;
      for (const ip of this.v4_addrs) {
        try {
          s4.setMulticastInterface(ip);
          s4.send(payload, DISCOVERY_PORT, MULTICAST_V4);
          sent += 1;
        } catch {
          continue;
        }
      }
      if (sent === 0) throw new Error(`所有网卡的 IPv4 组播发送均失败: ${this.v4_addrs.join(",")}`);
    } catch (e) {
      log.warn(`IPv4 组播发送失败: ${(e as Error).message}`);
    }
    // IPv6 尽力而为：链路本地组播需要 scope id，逐接口尝试
    try {
      const s6 = await this.get_send6();
      if (!s6) throw new Error("发送套接字创建失败");
      let sent = false;
      for (const idx of v6_if_indexes()) {
        try {
          s6.setMulticastInterface(String(idx));
          s6.send(payload, DISCOVERY_PORT, MULTICAST_V6);
          sent = true;
          break;
        } catch {
          continue;
        }
      }
      if (!sent) throw new Error("所有网卡的 IPv6 组播发送均失败");
    } catch (e) {
      log.debug(`IPv6 组播发送失败（忽略）: ${(e as Error).message}`);
    }
  }
}

// ------------------------------------------------------------------ 模块级套接字工具

/** 枚举本机全部 IPv4 地址；解析失败回退内核默认（0.0.0.0）。BMAHS_MCAST_IF_V4 可手动指定。 */
export function local_v4_addrs(): string[] {
  const raw = process.env.BMAHS_MCAST_IF_V4 ?? "";
  const explicit = raw
    .replace(/;/g, ",")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (explicit.length > 0) return explicit;
  const addrs: string[] = [];
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces ?? []) {
      if (iface.family === "IPv4" && iface.address !== "127.0.0.1" && !addrs.includes(iface.address)) {
        addrs.push(iface.address);
      }
    }
  }
  return addrs.length > 0 ? addrs : ["0.0.0.0"];
}

function join_v4(sock: dgram.Socket, ip: string, joined: Set<string>): boolean {
  try {
    sock.addMembership(MULTICAST_V4, ip);
    joined.add(ip);
    return true;
  } catch (e) {
    if (process.env.BMAHS_MCAST_IF_V4) {
      log.warn(`无法在 ${ip} 上加入组播组: ${(e as Error).message}`);
    }
    return false;
  }
}

/** 枚举 IPv6 接口的 scope id（链路本地组播 join/send 需要），全失败时回退 [0]。 */
function v6_if_indexes(): number[] {
  const idxs = new Set<number>();
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces ?? []) {
      if (iface.family === "IPv6" && iface.scopeid) idxs.add(iface.scopeid);
    }
  }
  return idxs.size > 0 ? [...idxs] : [0];
}
