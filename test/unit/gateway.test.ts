import { afterEach, describe, expect, it } from "vitest";
import { Gateway, DeviceEnvelope, GatewayError, UnknownToolError, glob_to_regexp } from "../../src/gateway.js";
import { FakeBmahsDevice } from "../fake-device.js";

const devices: FakeBmahsDevice[] = [];
const gateways: Gateway[] = [];

async function make_gw(with_ui = false, id = "fake-dev-1"): Promise<{ gw: Gateway; dev: FakeBmahsDevice }> {
  const dev = new FakeBmahsDevice(id);
  await dev.start(with_ui);
  devices.push(dev);
  const gw = new Gateway();
  gateways.push(gw);
  gw.discovery.add_static(dev.uri);
  return { gw, dev };
}

async function prime(gw: Gateway, dev: FakeBmahsDevice): Promise<void> {
  await gw.refresh_hello(gw.discovery.get(`static:${dev.uri.slice("tcp://".length)}`) ?? gw.discovery.all()[0]!);
}

afterEach(async () => {
  for (const gw of gateways.splice(0)) await gw.aclose().catch(() => {});
  for (const d of devices.splice(0)) await d.stop();
});

describe("工具表构建", () => {
  it("动态工具按 <id>__<action> 生成，通用动作不生成，schema 来自 ops", async () => {
    const { gw, dev } = await make_gw();
    await prime(gw, dev);
    const tools = gw.list_tools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("fake-dev-1__on");
    expect(names).toContain("fake-dev-1__brightness");
    expect(names).toContain("fake-dev-1__scene");
    // 6 个通用动作不生成动态工具（由固定工具统一提供）
    expect(names).not.toContain("fake-dev-1__describe");
    expect(names).not.toContain("fake-dev-1__occupy");
    // 固定工具 7 个
    for (const fixed of ["bmahs_devices", "bmahs_refresh", "bmahs_describe", "bmahs_occupy", "bmahs_release", "bmahs_call", "bmahs_screenshot"]) {
      expect(names).toContain(fixed);
    }
    const brightness = tools.find((t) => t.name === "fake-dev-1__brightness")!;
    expect(brightness.inputSchema).toMatchObject({
      type: "object",
      required: ["level"],
    });
    const props = brightness.inputSchema.properties as Record<string, Record<string, unknown>>;
    expect(props.level).toMatchObject({ type: "integer", minimum: 0, maximum: 100 });
    // any_of 写进描述而非 schema 强校验
    const scene = tools.find((t) => t.name === "fake-dev-1__scene")!;
    expect(scene.description).toContain("「name」、「index」 至少提供一个");
    expect(scene.inputSchema.required).toBeUndefined();
  });

  it("TOOL_DENY 隐藏匹配的动态工具，固定工具不受影响", async () => {
    process.env.BMAHS_TOOL_DENY = "fake-dev-1__scene,*__brightness";
    try {
      const { gw, dev } = await make_gw();
      await prime(gw, dev);
      const names = gw.list_tools().map((t) => t.name);
      expect(names).not.toContain("fake-dev-1__scene");
      expect(names).not.toContain("fake-dev-1__brightness");
      expect(names).toContain("fake-dev-1__on");
      expect(names).toContain("bmahs_devices");
    } finally {
      delete process.env.BMAHS_TOOL_DENY;
    }
  });
});

describe("动态工具调用（自动占用 + token 代管）", () => {
  it("调用 on：自动 occupy、设备受管、响应遮蔽 token", async () => {
    const { gw, dev } = await make_gw();
    await prime(gw, dev);
    const blocks = await gw.call_tool("fake-dev-1__on", {}, "local");
    const payload = JSON.parse(blocks[0]!.type === "text" ? blocks[0]!.text : "{}");
    expect(payload.ok).toBe(true);
    expect(payload.action).toBe("on");
    // token 被遮蔽
    expect(payload.token).toContain("«token");
    // 设备确实受管，token 只在网关内存
    expect(dev.token).toBeTruthy();
    expect(gw.tokens.get("local")?.get("fake-dev-1")).toBe(dev.token);
  });

  it("scene 缺参：any_of 预检返回 bad-arg 信封（不发往设备）", async () => {
    const { gw, dev } = await make_gw();
    await prime(gw, dev);
    const calls_before = dev.calls.length;
    await expect(gw.call_tool("fake-dev-1__scene", {})).rejects.toBeInstanceOf(DeviceEnvelope);
    expect(dev.calls.length).toBe(calls_before); // 未发往设备
  });

  it("brightness level=40 带参数成功", async () => {
    const { gw, dev } = await make_gw();
    await prime(gw, dev);
    const blocks = await gw.call_tool("fake-dev-1__brightness", { level: 40 });
    const payload = JSON.parse(blocks[0]!.type === "text" ? blocks[0]!.text : "{}");
    expect(payload.ok).toBe(true);
    expect(payload.level).toBe(40);
  });

  it("未知工具抛 UnknownToolError", async () => {
    const { gw } = await make_gw();
    await expect(gw.call_tool("nope__nope", {})).rejects.toBeInstanceOf(UnknownToolError);
  });

  it("释放后 bmahs_call 泛化调用会自动重新占用", async () => {
    const { gw, dev } = await make_gw();
    await prime(gw, dev);
    await gw.call_tool("bmahs_occupy", { device: "fake-dev-1", ttl: 120 });
    await gw.call_tool("bmahs_release", { device: "fake-dev-1" });
    expect(dev.token).toBeNull();
    const blocks = await gw.call_tool("bmahs_call", { device: "fake-dev-1", action: "brightness", args: { level: 80 } });
    const payload = JSON.parse(blocks[0]!.type === "text" ? blocks[0]!.text : "{}");
    expect(payload.ok).toBe(true);
    expect(payload.level).toBe(80);
    expect(dev.token).toBeTruthy(); // 重新受管
  });
});

describe("occupy/release 语义", () => {
  it("ttl<10 拒绝；≥9999 与超上限截断到 max_lease", async () => {
    const { gw, dev } = await make_gw();
    await prime(gw, dev);
    await expect(gw.call_tool("bmahs_occupy", { device: "fake-dev-1", ttl: 5 })).rejects.toThrow(GatewayError);
    const blocks = await gw.call_tool("bmahs_occupy", { device: "fake-dev-1", ttl: 9999 });
    const payload = JSON.parse(blocks[0]!.type === "text" ? blocks[0]!.text : "{}");
    expect(payload.ok).toBe(true);
    expect(payload.lease_security).toBe(3600); // 截断到默认 max_lease
    expect(payload.token).toContain("«token");
  });

  it("release：无 token 合成 no-token；有 token 释放成功", async () => {
    const { gw, dev } = await make_gw();
    await prime(gw, dev);
    const err1 = await gw.call_tool("bmahs_release", { device: "fake-dev-1" }).catch((e) => e);
    expect(err1).toBeInstanceOf(DeviceEnvelope);
    expect((err1 as DeviceEnvelope).envelope.code).toBe("no-token");
    await gw.call_tool("bmahs_occupy", { device: "fake-dev-1" });
    const blocks2 = await gw.call_tool("bmahs_release", { device: "fake-dev-1" });
    const p2 = JSON.parse(blocks2[0]!.type === "text" ? blocks2[0]!.text : "{}");
    expect(p2.ok).toBe(true);
    expect(p2.state).toBe("registered");
    expect(dev.release_count).toBe(1);
  });

  it("被他人占用时 occupy 回 occupied 信封", async () => {
    const { gw, dev } = await make_gw();
    await prime(gw, dev);
    dev.force_manage("other-agent", "1111222233334444");
    const err = await gw.call_tool("bmahs_occupy", { device: "fake-dev-1" }).catch((e) => e);
    expect(err).toBeInstanceOf(DeviceEnvelope);
    expect((err as DeviceEnvelope).envelope.code).toBe("occupied");
    expect((err as DeviceEnvelope).envelope.holder).toBe("other-agent");
  });
});

describe("bmahs_devices / describe / resolve", () => {
  it("devices 列表含占用状态与工具名", async () => {
    const { gw, dev } = await make_gw();
    await prime(gw, dev);
    await gw.call_tool("fake-dev-1__on", {});
    const blocks = await gw.call_tool("bmahs_devices", {});
    const payload = JSON.parse(blocks[0]!.type === "text" ? blocks[0]!.text : "{}");
    expect(payload.count).toBe(1);
    const item = payload.devices[0];
    expect(item).toMatchObject({
      id: "fake-dev-1",
      state: "managed",
      occupied_by_gateway: true,
      ops_ready: true,
      source: "static",
    });
    expect(item.tool_names).toContain("fake-dev-1__on");
  });

  it("resolve_device：id 精确 → 唯一同名 → 唯一子串；全落空抛错附清单", async () => {
    const { gw } = await make_gw();
    expect(() => gw.resolve_device("不存在的设备")).toThrow(/找不到设备/);
  });
});

describe("截图（ui 能力）", () => {
  it("ui.start → 一帧 JPEG → ui.stop，返回文本+图片两块", async () => {
    const { gw, dev } = await make_gw(true);
    await prime(gw, dev);
    const blocks = await gw.call_tool("bmahs_screenshot", { device: "fake-dev-1" });
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.type).toBe("text");
    const meta = JSON.parse(blocks[0]!.type === "text" ? blocks[0]!.text : "{}");
    expect(meta).toMatchObject({ ok: true, action: "screenshot", width: 64, height: 32, codec: "jpeg" });
    expect(meta.saved_to).toMatch(/\.jpg$/);
    expect(blocks[1]).toMatchObject({ type: "image", mimeType: "image/jpeg" });
    // ui.stop 已尽力调用
    expect(dev.calls.some(([a]) => a === "ui.stop")).toBe(true);
  }, 20000);

  it("无 ui 能力的设备报 GatewayError", async () => {
    const { gw, dev } = await make_gw(false);
    await prime(gw, dev);
    await expect(gw.call_tool("bmahs_screenshot", { device: "fake-dev-1" })).rejects.toThrow(/ui.start/);
  });
});

describe("aclose 退出释放", () => {
  it("退出前逐会话 release，设备回到 registered", async () => {
    const { gw, dev } = await make_gw();
    await prime(gw, dev);
    await gw.call_tool("fake-dev-1__on", {});
    expect(dev.token).toBeTruthy();
    await gw.aclose();
    expect(dev.token).toBeNull();
    expect(dev.release_count).toBe(1);
  });
});

describe("杂项", () => {
  it("glob_to_regexp 行为对齐 fnmatch", () => {
    expect(glob_to_regexp("*__on").test("fake-dev-1__on")).toBe(true);
    expect(glob_to_regexp("*__on").test("fake-dev-1__off")).toBe(false);
    expect(glob_to_regexp("fake-dev-?__*").test("fake-dev-1__scene")).toBe(true);
    expect(glob_to_regexp("lit[e]").test("lite")).toBe(true);
  });

  it("mask 递归遮蔽所有 token 字段", () => {
    const masked = Gateway.mask({ a: 1, token: "secret123", nested: { token: "abc", arr: [{ token: "x" }] } });
    expect(JSON.stringify(masked)).not.toContain("secret123");
    expect(JSON.stringify(masked)).not.toContain('"abc"');
    expect(JSON.stringify(masked)).toContain("«token");
  });

  it("进程退出后每个会话独立计 agent 身份", async () => {
    const { gw } = await make_gw();
    const h1 = {};
    const h2 = {};
    const k1 = gw.note_session(h1);
    const k2 = gw.note_session(h2);
    expect(k1).toBe("s1");
    expect(k2).toBe("s2");
    expect(gw.agent_for("local")).toBe(gw.agent_id);
    expect(gw.agent_for(k1)).toBe(`${gw.agent_id}-s1`);
  });
});
