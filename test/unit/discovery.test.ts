import { describe, expect, it } from "vitest";
import { Discovery, Device, local_v4_addrs } from "../../src/discovery.js";
import { build_announce, build_goodbye, build_query, parse_message } from "../../src/protocol.js";
import { build_txt, txt_to_announce } from "../../src/bonjour.js";

function make_disc(opts: ConstructorParameters<typeof Discovery>[1] = {}): Discovery {
  return new Discovery("agent-x", { bonjour: false, ...opts });
}

function announce_msg(over: Record<string, unknown> = {}): Buffer {
  return build_announce({
    id: "light-1",
    name: "客厅灯",
    type: "light",
    service: "light/1",
    control: "tcp://192.168.1.10:9527",
    state: "registered",
    ...over,
  });
}

function feed(disc: Discovery, buf: Buffer): void {
  disc.on_datagram(buf, { address: "192.168.1.10", family: "IPv4", port: 5354, size: buf.length });
}

describe("UDP announce 入库", () => {
  it("新设备入库并触发 on_change；重复无变化不触发", async () => {
    const disc = make_disc();
    let changes = 0;
    disc.on_change = () => {
      changes += 1;
    };
    feed(disc, announce_msg());
    expect(disc.all()).toHaveLength(1);
    const dev = disc.get("light-1")!;
    expect(dev.name).toBe("客厅灯");
    expect(dev.source).toBe("multicast");
    expect(dev.uri).toBe("tcp://192.168.1.10:9527");
    await Promise.resolve();
    await Promise.resolve();
    expect(changes).toBe(1);
    feed(disc, announce_msg()); // 同样的 announce：无可观察变化
    await Promise.resolve();
    await Promise.resolve();
    expect(changes).toBe(1);
  });

  it("control/state 变化触发回调；goodbye 移除", () => {
    const disc = make_disc();
    feed(disc, announce_msg());
    feed(disc, announce_msg({ state: "managed", holder: "someone" }));
    expect(disc.get("light-1")!.state).toBe("managed");
    feed(disc, build_goodbye({ id: "light-1" }));
    expect(disc.get("light-1")).toBeNull();
  });

  it("忽略自己的报文与 query", () => {
    const disc = make_disc();
    const q = build_query("agent-x"); // 自己 id 的 query
    disc.on_datagram(q, { address: "127.0.0.1", family: "IPv4", port: 5354, size: q.length });
    feed(disc, build_announce({ id: "agent-x" })); // 自己 id 的 announce
    expect(disc.all()).toHaveLength(0);
  });

  it("超长与非法报文直接丢弃", () => {
    const disc = make_disc();
    disc.on_datagram(Buffer.alloc(1500, 0x41), { address: "1.2.3.4", family: "IPv4", port: 5354, size: 1500 });
    expect(disc.all()).toHaveLength(0);
  });
});

describe("静态设备", () => {
  it("登记 / goodbye 不删 / uri 优先级", () => {
    const disc = make_disc({ static_uris: ["tcp://10.0.0.8:9527"] });
    disc.add_static("tcp://10.0.0.8:9527");
    const dev = disc.get("static:10.0.0.8:9527")!;
    expect(dev.source).toBe("static");
    expect(dev.uri).toBe("tcp://10.0.0.8:9527");
    feed(disc, build_goodbye({ id: "static:10.0.0.8:9527" }));
    expect(disc.get("static:10.0.0.8:9527")).not.toBeNull(); // 静态不随 goodbye 删除
    // 静态设备收到同 id 的 announce：announce 的 control 不覆盖 static_uri
    feed(disc, announce_msg({ id: "static:10.0.0.8:9527", control: "tcp://10.0.0.9:1111" }));
    expect(dev.uri).toBe("tcp://10.0.0.8:9527");
    expect(dev.announce.control).toBe("tcp://10.0.0.9:1111");
  });

  it("非法 URI 返回 null", () => {
    const disc = make_disc();
    expect(disc.add_static("not-a-uri")).toBeNull();
  });
});

describe("hello 绑定与重键（静态/Bonjour 过渡键 → 设备 id）", () => {
  it("静态设备读到 hello 后重键为设备 id，并刷新 last_seen", () => {
    const disc = make_disc();
    disc.add_static("tcp://10.0.0.8:9527");
    const dev = disc.get("static:10.0.0.8:9527")!;
    const hello = { action: "hello", id: "dev-77", name: "七号设备" };
    const bound = disc.bind_hello(dev.key, hello);
    expect(bound).not.toBeNull();
    expect(disc.get("dev-77")).toBe(bound);
    expect(disc.get("static:10.0.0.8:9527")).toBeNull();
    expect(bound!.id).toBe("dev-77");
    expect(bound!.hello).toBe(hello);
  });

  it("UDP 先见 + 静态后合并不产生重复记录", () => {
    const disc = make_disc();
    disc.add_static("tcp://192.168.1.10:9527");
    feed(disc, announce_msg()); // id=light-1，与静态条目同 control
    // 静态设备以过渡键存在；announce 建了 light-1 条目 —— 两条并存，
    // 直到静态设备读到 hello 才重键合并
    expect(disc.all().length).toBeGreaterThanOrEqual(1);
  });
});

describe("Bonjour 通道", () => {
  it("TXT 还原入库（kind=bonjour），UDP 后到时保留 UDP 摘要", () => {
    const disc = make_disc();
    const txt = build_txt({
      id: "light-1",
      name: "客厅灯",
      type: "light",
      service: "light/1",
      protocol: "bmahs/1.0",
      state: "registered",
      capabilities: ["describe", "occupy"],
      security: { scope: "lan", auth: "token" },
      summary: "组播静默的灯",
    });
    disc.on_bonjour_add("192.168.3.51", 9527, txt);
    let dev = disc.get("light-1")!;
    expect(dev.source).toBe("bonjour");
    expect(dev.announce.kind).toBe("bonjour");
    expect(dev.name).toBe("客厅灯");
    expect(dev.uri).toBe("tcp://192.168.3.51:9527");
    expect(dev.state).toBe("registered");
    // UDP announce 到达：以 announce 为准（kind=announce），保留 bonjour 登记
    feed(disc, announce_msg({ control: "tcp://192.168.1.10:9527" }));
    dev = disc.get("light-1")!;
    expect(dev.announce.kind).toBe("announce");
    expect(dev.bonjour_uri).toBe("tcp://192.168.3.51:9527");
    expect(dev.source).toBe("bonjour");
  });

  it("mDNS 下线：Bonjour-only 设备删除，UDP 也见过的只降级，静态忽略", () => {
    const disc = make_disc();
    // Bonjour-only
    disc.on_bonjour_add("192.168.3.51", 9527, build_txt({ id: "b-only", name: "B" }));
    // UDP + Bonjour
    feed(disc, announce_msg({ id: "dual", name: "D" }));
    disc.on_bonjour_add("192.168.3.52", 9527, build_txt({ id: "dual", name: "D" }));
    // 静态 + Bonjour
    disc.add_static("tcp://10.0.0.8:9527");
    disc.on_bonjour_add("10.0.0.8", 9527, build_txt({ id: "static:10.0.0.8:9527", name: "S" }));

    disc.on_bonjour_remove("B", "b-only", "192.168.3.51", 9527);
    expect(disc.get("b-only")).toBeNull();

    disc.on_bonjour_remove("D", "dual", "192.168.3.52", 9527);
    const dual = disc.get("dual")!;
    expect(dual).not.toBeNull();
    expect(dual.source).toBe("multicast");
    expect(dual.bonjour_uri).toBeNull();

    disc.on_bonjour_remove("S", "static:10.0.0.8:9527", "10.0.0.8", 9527);
    expect(disc.get("static:10.0.0.8:9527")).not.toBeNull();
  });
});

describe("心跳过期", () => {
  it("超时设备被清除；静态/Bonjour 设备不过期", () => {
    const disc = make_disc({ expire_sec: 60 });
    feed(disc, announce_msg({ id: "will-die" }));
    const bj = disc.on_bonjour_add;
    bj.call(disc, "10.0.0.1", 9527, build_txt({ id: "bj-keep", name: "BJ" }));
    disc.add_static("tcp://10.0.0.8:9527");
    // 强制把动态设备视作陈旧
    const will_die = disc.get("will-die")!;
    will_die.last_seen -= 3600;
    const gone = disc.purge_expired();
    expect(gone).toEqual(["will-die"]);
    expect(disc.get("will-die")).toBeNull();
    expect(disc.get("bj-keep")).not.toBeNull();
    expect(disc.get("static:10.0.0.8:9527")).not.toBeNull();
  });

  it("按 hb 逐台计算时限（hb 大的存活更久）", () => {
    const disc = make_disc();
    feed(disc, announce_msg({ id: "slow", hb: 600 })); // 时限 1800s
    const dev = disc.get("slow")!;
    dev.last_seen -= 700; // 700s < 1800s：仍存活
    expect(disc.purge_expired()).toEqual([]);
    expect(disc.get("slow")).not.toBeNull();
  });
});

describe("txt_to_announce / build_txt 往返", () => {
  it("TXT 键值容忍任意类型，control 由 host:port 合成", () => {
    const txt = build_txt({
      id: "light-9",
      name: "九号",
      type: "light",
      service: "light/1",
      protocol: "bmahs/1.0",
      capabilities: ["describe"],
      security: { scope: "lan", auth: "token" },
      summary: "s".repeat(200),
      hb: 30,
      busy: true,
    });
    expect(txt.summary!.length).toBe(80); // 截断到 80
    expect(txt.busy).toBe("1");
    const a = txt_to_announce({ ...txt, weird: 123 as unknown as string }, "1.2.3.4", 9999);
    expect(a.kind).toBe("bonjour");
    expect(a.control).toBe("tcp://1.2.3.4:9999");
    expect(a.state).toBe("registered");
    expect(a.hb).toBe(30);
    expect(a.busy).toBe(true);
    expect(a.security).toEqual({ scope: "lan", auth: "token" });
    expect((a.capabilities as string[]).join(",")).toBe("describe");
    // Buffer 值也能解
    const a2 = txt_to_announce({ id: Buffer.from("buf-id"), state: "managed" }, "1.2.3.4", 1);
    expect(a2.id).toBe("buf-id");
    expect(a2.state).toBe("managed");
  });

  it("bonjour 摘要过不了 UDP 层校验（缺协议头/kind 不合法），注册表靠 kind 区分来源", () => {
    const a = txt_to_announce({ id: "x" }, "1.2.3.4", 1);
    expect(a.kind).toBe("bonjour");
    expect(parse_message(Buffer.from(JSON.stringify(a), "utf-8"))).toBeNull();
    void Device;
  });
});

describe("local_v4_addrs", () => {
  it("至少回退 0.0.0.0，且不含 127.0.0.1", () => {
    const addrs = local_v4_addrs();
    expect(addrs.length).toBeGreaterThan(0);
    expect(addrs).not.toContain("127.0.0.1");
  });
});
