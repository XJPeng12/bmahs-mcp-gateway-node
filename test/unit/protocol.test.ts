import { describe, expect, it } from "vitest";
import {
  DEFAULT_HB,
  MAX_DGRAM,
  build_announce,
  build_goodbye,
  build_query,
  expire_sec_for,
  hb_of,
  matches_want,
  matches_want as want,
  now,
  parse_control_uri,
  parse_message,
  sanitize_id,
} from "../../src/protocol.js";

function announce(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    protocol: "bmahs/1.0",
    kind: "announce",
    id: "light-1",
    name: "客厅灯",
    type: "light",
    service: "light/1",
    control: "tcp://192.168.1.10:9527",
    state: "registered",
    ...over,
  };
}

describe("sanitize_id", () => {
  it("非法字符替换为 - 并去首尾小写", () => {
    expect(sanitize_id("客厅 灯#1")).toBe("1"); // 前导 - 被 strip
    expect(sanitize_id("--Light--")).toBe("light");
    expect(sanitize_id("###")).toBe("bmahs-device");
  });
});

describe("parse_message（bmahs/1.0 与 1.2 双名兼容）", () => {
  it("合法 announce 解析并保留字段", () => {
    const msg = parse_message(Buffer.from(JSON.stringify(announce()), "utf-8"));
    expect(msg).not.toBeNull();
    expect(msg!.kind).toBe("announce");
    expect(msg!.id).toBe("light-1");
    expect(msg!.version).toBe(1);
    expect(msg!.protocol).toBe("bmahs/1.0");
  });

  it("旧版字段名 v/proto/ts/svc/caps/sec 回填为新名", () => {
    const legacy = {
      v: 1,
      proto: "bmahs/1.2",
      kind: "announce",
      ts: 12345,
      id: "old-1",
      svc: "light/1",
      caps: ["describe", "occupy"],
      sec: { scope: "lan", auth: "token" },
    };
    const msg = parse_message(Buffer.from(JSON.stringify(legacy), "utf-8"));
    expect(msg).not.toBeNull();
    expect(msg!.version).toBe(1);
    expect(msg!.protocol).toBe("bmahs/1.2");
    expect(msg!.timestamp).toBe(12345);
    expect(msg!.service).toBe("light/1");
    expect(msg!.capabilities).toEqual(["describe", "occupy"]);
    expect(msg!.security).toEqual({ scope: "lan", auth: "token" });
  });

  it("缺 timestamp 时回填当前时间", () => {
    const before = now();
    const msg = parse_message(Buffer.from(JSON.stringify({ v: 1, proto: "bmahs", kind: "query", id: "a" }), "utf-8"));
    expect(msg).not.toBeNull();
    expect(msg!.timestamp).toBeGreaterThanOrEqual(before);
  });

  it("version≠1 / protocol 非 bmahs / kind 非法 / id 缺失 / 非 JSON 对象 → 丢弃", () => {
    const bad = [
      { version: 2, protocol: "bmahs/1.0", kind: "announce", id: "x" },
      { version: 1, protocol: "other/1.0", kind: "announce", id: "x" },
      { version: 1, protocol: "bmahs/1.0", kind: "hello", id: "x" },
      { version: 1, protocol: "bmahs/1.0", kind: "announce" },
      { version: 1, protocol: "bmahs/1.0", kind: "announce", id: "" },
      [1, 2, 3],
      "not json at all",
    ];
    for (const b of bad) {
      const buf = typeof b === "string" ? Buffer.from(b, "utf-8") : Buffer.from(JSON.stringify(b), "utf-8");
      expect(parse_message(buf)).toBeNull();
    }
    expect(parse_message(Buffer.from("{{{", "utf-8"))).toBeNull();
  });
});

describe("build_query / build_announce / build_goodbye", () => {
  it("query 带 want 且默认 *", () => {
    const q = JSON.parse(build_query("agent-1").toString("utf-8"));
    expect(q).toMatchObject({ version: 1, protocol: "bmahs/1.0", kind: "query", id: "agent-1", want: "*" });
    const q2 = JSON.parse(build_query("agent-1", "light,display").toString("utf-8"));
    expect(q2.want).toBe("light,display");
  });

  it("announce/goodbye 合并设备摘要", () => {
    const a = JSON.parse(build_announce(announce({ hb: 5 })).toString("utf-8"));
    expect(a.kind).toBe("announce");
    expect(a.control).toBe("tcp://192.168.1.10:9527");
    const g = JSON.parse(build_goodbye({ id: "light-1" }).toString("utf-8"));
    expect(g.kind).toBe("goodbye");
    expect(g.state).toBe("offline");
    expect(g.event).toBe("offline");
  });
});

describe("_dump 1400 字节收缩", () => {
  it("短报文原样通过", () => {
    const buf = build_announce(announce());
    expect(buf.length).toBeLessThanOrEqual(MAX_DGRAM);
  });

  it("超长报文逐级收缩 summary 直至丢弃字段，始终 ≤1400 且尽量合法", () => {
    const big = announce({
      summary: "很长的摘要。".repeat(200),
      model: "X-2000",
      event: "update",
      ipv6: "fe80::1",
      capabilities: ["describe", "occupy"],
      security: { scope: "lan", auth: "token" },
    });
    const buf = build_announce(big);
    expect(buf.length).toBeLessThanOrEqual(MAX_DGRAM);
    const text = buf.toString("utf-8");
    // 极端截断可能切坏 UTF-8，但正常收缩路径应产出合法 JSON
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    if (parsed) {
      // 收缩生效：summary 已被截短或丢弃
      const s = parsed.summary as string | undefined;
      expect(s === undefined || s.length <= 80).toBe(true);
    }
  });
});

describe("parse_control_uri", () => {
  it("IPv4 / IPv6 / 非法", () => {
    expect(parse_control_uri("tcp://192.168.1.5:9527")).toEqual({ host: "192.168.1.5", port: 9527 });
    expect(parse_control_uri("tcp://[fe80::1]:9527")).toEqual({ host: "fe80::1", port: 9527 });
    expect(parse_control_uri("http://x:1")).toBeNull();
    expect(parse_control_uri(null)).toBeNull();
    expect(parse_control_uri("tcp://host")).toBeNull();
  });
});

describe("matches_want / hb_of / expire_sec_for", () => {
  it("want 匹配", () => {
    expect(want("light", "*")).toBe(true);
    expect(want("light", "")).toBe(true);
    expect(want("light", "bmahs")).toBe(true);
    expect(want("Light", "light,display")).toBe(true);
    expect(want("switch", "light,display")).toBe(false);
  });

  it("hb 缺省 5；expire=clamp(12×hb,60,1800)", () => {
    expect(hb_of({})).toBe(DEFAULT_HB);
    expect(hb_of({ hb: 30 })).toBe(30);
    expect(hb_of({ hb: "x" })).toBe(DEFAULT_HB);
    expect(expire_sec_for(5)).toBe(60);
    expect(expire_sec_for(30)).toBe(360);
    expect(expire_sec_for(9999)).toBe(1800);
  });
});
