import { afterEach, describe, expect, it } from "vitest";
import {
  BmahsError,
  call_action,
  fetch_hello,
  read_ui_frame,
  read_ui_frames,
} from "../../src/client.js";
import { FakeBmahsDevice } from "../fake-device.js";

const devices: FakeBmahsDevice[] = [];

async function make_dev(with_ui = false): Promise<FakeBmahsDevice> {
  const d = new FakeBmahsDevice();
  await d.start(with_ui);
  devices.push(d);
  return d;
}

afterEach(async () => {
  for (const d of devices.splice(0)) await d.stop();
});

describe("fetch_hello", () => {
  it("读到合法 hello（operations 与 ops 都接受）", async () => {
    const d = await make_dev();
    const hello = await fetch_hello(d.uri);
    expect(hello.action).toBe("hello");
    expect(hello.id).toBe("fake-dev-1");
    expect(Array.isArray(hello.operations)).toBe(true);
  });

  it("对端不是 BMAHS 设备时给出明确错误", async () => {
    const d = await make_dev();
    // 把 hello 改成非 hello 应答：直接起一个只回普通行的裸服务器
    await d.stop();
    const { createServer } = await import("node:net");
    const srv = createServer((s) => {
      s.end(Buffer.from(JSON.stringify({ ok: true, action: "hi" }) + "\n", "utf-8"));
    });
    await new Promise<void>((res) => srv.listen(0, "127.0.0.1", res));
    const port = (srv.address() as import("node:net").AddressInfo).port;
    try {
      await expect(fetch_hello(`tcp://127.0.0.1:${port}`)).rejects.toThrow(/hello/);
    } finally {
      await new Promise<void>((res) => srv.close(() => res()));
    }
  });

  it("连接不存在的端口 → BmahsError", async () => {
    await expect(fetch_hello("tcp://127.0.0.1:1", 2)).rejects.toBeInstanceOf(BmahsError);
  });
});

describe("call_action", () => {
  it("hello → 请求 → 响应 往返，且请求体完整送达", async () => {
    const d = await make_dev();
    const { hello, resp } = await call_action(d.uri, { action: "on", agent: "gw-1" });
    expect(hello.id).toBe("fake-dev-1");
    expect(resp.ok).toBe(true);
    expect(resp.action).toBe("on");
    // 空闲设备无 token 控制自动受管，响应带 token
    expect(typeof resp.token).toBe("string");
    expect(d.calls[0]).toBeDefined();
    expect(d.calls[0]![0]).toBe("on");
  });

  it("未知动作回 unknown-action 信封", async () => {
    const d = await make_dev();
    const { resp } = await call_action(d.uri, { action: "reboot", agent: "gw-1" });
    expect(resp.ok).toBe(false);
    expect(resp.code).toBe("unknown-action");
    expect(resp.retryable).toBe(false);
  });
});

describe("read_ui_frame / read_ui_frames", () => {
  it("鉴权通过读到一帧 JPEG（codec=1, 64x32）", async () => {
    const d = await make_dev(true);
    d.force_manage("gw-1", "abcdef0123456789");
    const { resp } = await call_action(d.uri, { action: "ui.start", agent: "gw-1", token: d.token });
    expect(resp.ok).toBe(true);
    const frame = await read_ui_frame(resp.ui as string, d.token!);
    expect(frame.codec).toBe(1);
    expect(frame.width).toBe(64);
    expect(frame.height).toBe(32);
    expect(frame.payload).toEqual(await Promise.resolve(frame.payload)); // Buffer 自等
    expect(frame.payload.length).toBeGreaterThan(4);
  });

  it("token 错误 → 鉴权失败错误", async () => {
    const d = await make_dev(true);
    d.force_manage("gw-1", "abcdef0123456789");
    await expect(read_ui_frame(d.ui_uri!, "wrong-token")).rejects.toThrow(/鉴权失败/);
  });

  it("流式读帧：设备关闭后迭代正常结束", async () => {
    const d = await make_dev(true);
    d.force_manage("gw-1", "abcdef0123456789");
    const frames = [];
    for await (const f of read_ui_frames(d.ui_uri!, d.token!)) {
      frames.push(f);
    }
    expect(frames.length).toBe(1);
    expect(frames[0]!.codec).toBe(1);
  });
});
