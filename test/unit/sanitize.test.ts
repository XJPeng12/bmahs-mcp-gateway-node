import { afterEach, describe, expect, it } from "vitest";
import {
  close_matches,
  coerce_args_object,
  coerce_device_ref,
  coerce_int,
  coerce_op_arguments,
  example_device_ref,
  near_match_action,
  near_match_device,
  similarity,
} from "../../src/sanitize.js";
import { Gateway, DeviceEnvelope } from "../../src/gateway.js";
import { FakeBmahsDevice } from "../fake-device.js";

const devices: FakeBmahsDevice[] = [];
const gateways: Gateway[] = [];

async function make_gw(id = "fake-dev-1"): Promise<{ gw: Gateway; dev: FakeBmahsDevice }> {
  const dev = new FakeBmahsDevice(id);
  await dev.start(false);
  devices.push(dev);
  const gw = new Gateway();
  gateways.push(gw);
  gw.discovery.add_static(dev.uri);
  return { gw, dev };
}

async function prime(gw: Gateway, dev: FakeBmahsDevice): Promise<void> {
  await gw.refresh_hello(gw.discovery.all()[0]!);
}

afterEach(async () => {
  for (const gw of gateways.splice(0)) await gw.aclose().catch(() => {});
  for (const d of devices.splice(0)) await d.stop();
});

function payload(blocks: { type: string; text?: string }[]): Record<string, unknown> {
  return JSON.parse(blocks[0]!.type === "text" ? blocks[0]!.text! : "{}");
}

describe("净化器：近似匹配", () => {
  it("similarity 与 difflib ratio 同式（LCS）", () => {
    expect(similarity("lamp01", "lamp-01")).toBeGreaterThan(0.75);
    expect(similarity("lampxx", "lamp-01")).toBeLessThan(0.75);
    expect(similarity("abc", "abc")).toBe(1);
  });

  it("close_matches 取 cutoff 以上前 n 个", () => {
    expect(close_matches("of", ["on", "off"], 2, 0.6)).toEqual(["off"]);
  });

  it("near_match_device 唯一命中映射到设备 id", async () => {
    const { gw, dev } = await make_gw();
    await prime(gw, dev);
    expect(near_match_device(gw, "fake-dev1")).toEqual(["fake-dev-1", []]);
    expect(near_match_device(gw, "完全不像")[0]).toBeNull();
  });

  it("near_match_action 唯一命中", () => {
    const hello = { operations: [{ name: "on" }, { name: "off" }, { name: "brightness" }] };
    expect(near_match_action(hello, "of")[0]).toBe("off");
    expect(near_match_action(hello, "完全不像的名字")[0]).toBeNull();
  });

  it("example_device_ref 取真实设备 id", async () => {
    const { gw, dev } = await make_gw();
    await prime(gw, dev);
    expect(example_device_ref(gw)).toBe("fake-dev-1");
  });
});

describe("净化器：device 引用与类型矫正", () => {
  it("单条目对象解包为 id 字符串（本案形态）并附标注", async () => {
    const { gw, dev } = await make_gw();
    await prime(gw, dev);
    const [ref, notes, err] = coerce_device_ref(gw, { "fake-dev-1": "假设备" });
    expect(err).toBeNull();
    expect(ref).toBe("fake-dev-1");
    expect(notes[0]!.to).toBe("fake-dev-1");
  });

  it("歧义对象返回富错误（echo + retry_with + candidates）", async () => {
    const { gw, dev } = await make_gw();
    const dev2 = new FakeBmahsDevice("fake-dev-2");
    await dev2.start(false);
    devices.push(dev2);
    gw.discovery.add_static(dev2.uri);
    await prime(gw, dev);
    const bad = { a: "假设备", b: "no-such" };
    const [ref, , err] = coerce_device_ref(gw, bad) as [null, unknown, Record<string, unknown>];
    expect(ref).toBeNull();
    expect(err!.echo).toEqual({ device: bad });
    expect(err!.candidates).toBeDefined();
    expect((err!.retry_with as Record<string, unknown>).device).toBe("fake-dev-1");
  });

  it("缺失 / 错误类型给 retry_with 示例", async () => {
    const { gw, dev } = await make_gw();
    await prime(gw, dev);
    for (const bad of [null, "", 42, true]) {
      const [ref, , err] = coerce_device_ref(gw, bad) as [null, unknown, Record<string, unknown>];
      expect(ref).toBeNull();
      expect((err!.retry_with as Record<string, unknown>).device).toBe("fake-dev-1");
    }
  });

  it("coerce_int：字符串数字 / 小数取整 / 布尔报错", () => {
    expect(coerce_int("120", "ttl")).toEqual([120, [expect.objectContaining({ to: 120 })], null]);
    expect(coerce_int(120.0, "ttl")[0]).toBe(120);
    expect(coerce_int(null, "ttl")).toEqual([null, [], null]);
    expect(coerce_int(true, "ttl")[2]!.retry_with).toEqual({ ttl: 120 });
    expect(coerce_int("两分钟", "ttl")[2]).toBeTruthy();
  });

  it("coerce_op_arguments：类型 + enum 矫正，未声明键不动", () => {
    const op = {
      name: "x",
      args: [
        { name: "level", type: "int" },
        { name: "mode", type: "string", enum: ["on", "off"] },
        { name: "label", type: "string" },
      ],
    };
    const [out, notes] = coerce_op_arguments(op, { level: "66", mode: "ON", label: 7, other: 1 });
    expect(out).toEqual({ level: 66, mode: "on", label: "7", other: 1 });
    expect(notes.map((n) => n.arg).sort()).toEqual(["label", "level", "mode"]);
  });

  it("coerce_args_object：单元素数组取对象，畸形给示例错误", () => {
    const op = { name: "x", args: [{ name: "level", type: "int", example: 50 }] };
    expect(coerce_args_object([{ level: 1 }], op)[0]).toEqual({ level: 1 });
    expect(coerce_args_object(null, op)).toEqual([null, [], null]);
    const [, , err] = coerce_args_object("x", op);
    expect(err!.retry_with).toEqual({ args: { level: 50 } });
  });
});

describe("防线①：describe 可选", () => {
  it("唯一设备自动选中并附 coerced；多台返回选择清单", async () => {
    const { gw, dev } = await make_gw();
    await prime(gw, dev);
    const one = payload(await gw.call_tool("bmahs_describe", {}, "local"));
    expect(one.ok).toBe(true);
    expect((one.coerced as { to: string }[])[0]!.to).toBe("fake-dev-1");

    const dev2 = new FakeBmahsDevice("fake-dev-2");
    await dev2.start(false);
    devices.push(dev2);
    gw.discovery.add_static(dev2.uri);
    await gw.refresh_hello(gw.discovery.all().find((d) => d.static_uri === dev2.uri)!);
    const many = payload(await gw.call_tool("bmahs_describe", {}, "local"));
    expect(many.ok).toBe(true);
    expect(many.count).toBe(2);
    expect(String(many.note)).toContain("未指定 device");

    // 显式传对象形态仍可矫正
    const explicit = payload(
      await gw.call_tool("bmahs_describe", { device: { "fake-dev-1": "假设备" } }, "local"),
    );
    expect(explicit.ok).toBe(true);
  });
});

describe("防线②③：call_tool 全路径", () => {
  it("对象 device 端到端成功 + coerced 标注", async () => {
    const { gw, dev } = await make_gw();
    await prime(gw, dev);
    const p = payload(await gw.call_tool("bmahs_describe", { device: { "fake-dev-1": "假设备" } }, "local"));
    expect(p.ok).toBe(true);
    expect((p.coerced as { arg: string }[])[0]!.arg).toBe("device");
  });

  it("动态工具字符串数字矫正", async () => {
    const { gw, dev } = await make_gw();
    await prime(gw, dev);
    const p = payload(await gw.call_tool("fake-dev-1__brightness", { level: "66" }, "local"));
    expect(p.ok).toBe(true);
    expect(p.level).toBe(66);
  });

  it("同参连续失败：第 2 次升级提示、第 3 次停止令、措辞逐级变化", async () => {
    const { gw, dev } = await make_gw();
    await prime(gw, dev);
    const bad = { device: "fake-dev-1", action: "no-such-action-xyz" };
    const rounds: Record<string, unknown>[] = [];
    for (let i = 0; i < 3; i++) {
      try {
        await gw.call_tool("bmahs_call", bad, "local");
        expect.unreachable("应抛 DeviceEnvelope");
      } catch (e) {
        rounds.push((e as DeviceEnvelope).envelope);
      }
    }
    expect(rounds[0]!.repeat_count).toBeUndefined();
    expect(rounds[0]!.retry_with).toBeDefined();
    expect(rounds[1]!.repeat_count).toBe(2);
    expect(rounds[1]!.hint).toBeDefined();
    expect(rounds[2]!.repeat_count).toBe(3);
    expect(rounds[2]!.directive).toBe("stop");
    expect(rounds[1]!.error).not.toBe(rounds[2]!.error);
  });

  it("成功调用重置连续失败计数", async () => {
    const { gw, dev } = await make_gw();
    await prime(gw, dev);
    const bad = { device: "fake-dev-1", action: "no-such-action-xyz" };
    for (let i = 0; i < 2; i++) {
      await gw.call_tool("bmahs_call", bad, "local").catch(() => {});
    }
    await gw.call_tool("bmahs_devices", {}, "local"); // 成功 → 重置
    try {
      await gw.call_tool("bmahs_call", bad, "local");
    } catch (e) {
      expect((e as DeviceEnvelope).envelope.repeat_count).toBeUndefined();
    }
  });

  it("控制动作近似只建议不代执行；只读动作自动改写", async () => {
    const { gw, dev } = await make_gw();
    await prime(gw, dev);
    // 控制动作 "onn" → 建议 on（DeviceEnvelope，不执行）
    try {
      await gw.call_tool("bmahs_call", { device: "fake-dev-1", action: "onn" }, "local");
      expect.unreachable();
    } catch (e) {
      const env = (e as DeviceEnvelope).envelope;
      expect(env.retry_with).toEqual({ device: "fake-dev-1", action: "on" });
    }
    // 只读动作（who 旧版清单位于 GENERIC；此处用 info）自动改写并执行
    const p = payload(await gw.call_tool("bmahs_call", { device: "fake-dev-1", action: "infoo" }, "local"));
    expect(p.ok).toBe(true);
    expect((p.coerced as { arg: string; to: string }[]).some((c) => c.arg === "action" && c.to === "info")).toBe(true);
  });
});

describe("BMAHS_DEVICE_TOOLS 零参数 describe 别名", () => {
  it("生成 <id>__describe 且零参数可调用", async () => {
    process.env.BMAHS_DEVICE_TOOLS = "1";
    try {
      const { gw, dev } = await make_gw();
      await prime(gw, dev);
      gw.rebuild_tools();
      const names = gw.list_tools().map((t) => t.name);
      expect(names).toContain("fake-dev-1__describe");
      const p = payload(await gw.call_tool("fake-dev-1__describe", {}, "local"));
      expect(p.ok).toBe(true);
    } finally {
      delete process.env.BMAHS_DEVICE_TOOLS;
    }
  });
});
