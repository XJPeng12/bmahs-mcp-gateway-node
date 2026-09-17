/**
 * 测试专用假 BMAHS 设备：只实现控制层（TCP hello + 行协议）与 UI 流。
 *
 * 与 examples/demo_light.py 的区别：不绑定 UDP 组播（端口随机分配、可多实例），
 * 行为可从外部篡改（如伪造 holder），专供网关单元/集成测试使用。
 */

import * as net from "node:net";
import { randomBytes } from "node:crypto";

export const FAKE_JPEG = Buffer.concat([
  Buffer.from([0xff, 0xd8]),
  Buffer.from("fakejpegdata".repeat(4), "utf-8"),
  Buffer.from([0xff, 0xd9]),
]);

type Msg = Record<string, unknown>;

export class FakeBmahsDevice {
  device_id: string;
  name: string;
  token: string | null = null;
  holder: string | null = null;
  until = 0;
  calls: Array<[string | null, Msg]> = [];
  release_count = 0;
  ui_uri: string | null = null;
  uri = "";
  private servers: net.Server[] = [];

  constructor(device_id = "fake-dev-1", name = "假灯") {
    this.device_id = device_id;
    this.name = name;
  }

  async start(with_ui = false): Promise<this> {
    const main = net.createServer((s) => this.handle(s));
    await new Promise<void>((res) => main.listen(0, "127.0.0.1", res));
    this.servers.push(main);
    const port = (main.address() as net.AddressInfo).port;
    this.uri = `tcp://127.0.0.1:${port}`;
    if (with_ui) {
      const ui = net.createServer((s) => this.ui_handle(s));
      await new Promise<void>((res) => ui.listen(0, "127.0.0.1", res));
      this.servers.push(ui);
      const ui_port = (ui.address() as net.AddressInfo).port;
      this.ui_uri = `tcp://127.0.0.1:${ui_port}`;
    }
    return this;
  }

  async stop(): Promise<void> {
    for (const s of this.servers) {
      await new Promise<void>((res) => s.close(() => res()));
    }
    this.servers = [];
  }

  /** 控制类动作的直接篡改入口（测试用）：伪造状态 */
  force_manage(holder: string, token = randomBytes(8).toString("hex")): void {
    this.token = token;
    this.holder = holder;
  }

  hello(): Msg {
    const svc_ops: Msg[] = [
      { name: "on", description: "开灯", args: [], result: "灯亮", returns: [] },
      {
        name: "brightness",
        description: "调亮度",
        args: [
          {
            name: "level",
            type: "int",
            required: true,
            min: 0,
            max: 100,
            description: "亮度百分比",
          },
        ],
        result: "回亮度",
        returns: [],
      },
      {
        name: "scene",
        description: "切场景",
        args: [
          { name: "name", type: "string", required: false, description: "场景名" },
          { name: "index", type: "int", required: false, min: 0, description: "序号" },
        ],
        any_of: ["name", "index"],
        result: "回场景",
        returns: [],
      },
    ];
    if (this.ui_uri) {
      svc_ops.push(
        {
          name: "ui.start",
          description: "启动画面流",
          args: [
            { name: "codec", type: "string", required: false, enum: ["jpeg"], description: "编码" },
            { name: "max_width", type: "int", required: false, min: 64, max: 1280, description: "最大宽度" },
          ],
          result: "回 ui URI 与宽高",
          returns: [
            { name: "ui", type: "string", description: "UI 流地址" },
            { name: "width", type: "int", description: "宽" },
            { name: "height", type: "int", description: "高" },
          ],
        },
        { name: "ui.stop", description: "停止画面流", args: [], result: "已停止", returns: [] },
      );
    }
    const generic: Msg[] = ["describe", "info", "register", "occupy", "release", "who"].map((n) => ({
      name: n,
      description: n,
      args: [],
      result: "ok",
      returns: [],
    }));
    return {
      ok: true,
      action: "hello",
      protocol: "bmahs/1.2",
      id: this.device_id,
      type: "light",
      service: "light/1",
      name: this.name,
      summary: "测试用假设备",
      hint: "先 occupy",
      capabilities: [...svc_ops, ...generic].map((op) => op.name),
      operations: [...svc_ops, ...generic],
      security: {
        scope: "lan",
        auth: "token",
        allow: [],
        deny: ["exec"],
        confirm: [],
        notes: "测试边界",
      },
      state: this.token ? "managed" : "registered",
      busy: Boolean(this.token),
      // §6.2：受管时 hello 应当携带 holder/until
      ...(this.token ? { holder: this.holder, until: this.until } : {}),
    };
  }

  private send(sock: net.Socket, obj: Msg): void {
    sock.write(Buffer.from(JSON.stringify(obj), "utf-8"));
    sock.write("\n");
  }

  private handle(sock: net.Socket): void {
    let buf = Buffer.alloc(0);
    this.send(sock, this.hello());
    sock.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      let idx: number;
      while ((idx = buf.indexOf(0x0a)) >= 0) {
        const line = buf.subarray(0, idx);
        buf = buf.subarray(idx + 1);
        let req: Msg;
        try {
          req = JSON.parse(line.toString("utf-8"));
        } catch {
          sock.destroy();
          return;
        }
        this.send(sock, this.dispatch(req));
      }
    });
    sock.on("error", () => sock.destroy());
  }

  dispatch(req: Msg): Msg {
    const action = (req.action as string) ?? null;
    this.calls.push([action, req]);
    const agent = String(req.agent || "anonymous");

    if (action === "occupy") {
      if (this.token && this.holder !== agent) {
        return {
          ok: false, action: "occupy", code: "occupied",
          error: `正被 ${this.holder} 占用`, retryable: true,
          state: "managed", holder: this.holder, until: this.until,
        };
      }
      if (this.token && req.token !== this.token) {
        return {
          ok: false, action: "occupy", code: "unauthorized",
          error: "token 缺失或不匹配", retryable: false, holder: this.holder,
        };
      }
      const ttl = req.ttl;
      if (
        ttl !== null && ttl !== undefined &&
        (typeof ttl !== "number" || !Number.isInteger(ttl) || ttl < 10 || ttl > 9999)
      ) {
        return {
          ok: false, action: "occupy", code: "bad-arg",
          error: "ttl 需为 10–9999 的整数秒", retryable: false,
        };
      }
      this.token = this.token || randomBytes(8).toString("hex");
      this.holder = agent;
      const lease_security = ttl !== null && ttl !== undefined ? Number(ttl) : 9999;
      this.until = lease_security >= 9999 ? 0 : Math.floor(Date.now() / 1000) + lease_security;
      return {
        ok: true, action: "occupy", state: "managed", event: "manage",
        busy: true, holder: agent, until: this.until,
        lease_security, token: this.token,
      };
    }

    if (action === "release") {
      if (this.token === null) {
        return { ok: true, action: "release", state: "registered", event: "release" };
      }
      if (req.token !== this.token) {
        return {
          ok: false, action: "release", code: "unauthorized",
          error: "token 缺失或不匹配", retryable: false,
        };
      }
      this.token = null;
      this.holder = null;
      this.release_count += 1;
      return { ok: true, action: "release", state: "registered", event: "release" };
    }

    if (action && ["describe", "info", "who", "register"].includes(action)) {
      return { ok: true, action, id: this.device_id };
    }

    if (action && ["on", "brightness", "scene"].includes(action)) {
      if (this.token !== null) {
        if (req.token !== this.token) {
          return {
            ok: false, action, code: "unauthorized",
            error: "token 缺失或不匹配", retryable: false,
            state: "managed", holder: this.holder,
          };
        }
      } else if (req.token === null || req.token === undefined) {
        // 空闲设备的无 token 控制命令自动受管（协议 §4.6）
        this.token = randomBytes(8).toString("hex");
        this.holder = agent;
      } else {
        // 已注册但携带未知 token：不自动受管（避免无效 token 抢占占用位，
        // 同时让网关的「重新占用」恢复路径可行）
        return {
          ok: false, action, code: "unauthorized",
          error: "设备空闲但请求携带未知 token", retryable: false,
          state: "registered",
        };
      }
      if (action === "scene" && req.name === undefined && req.index === undefined) {
        return {
          ok: false, action: "scene", code: "bad-arg",
          error: "name 与 index 至少提供一个", retryable: false,
        };
      }
      return {
        ok: true, action, level: req.level,
        name: req.name, token: this.token,
      };
    }

    if (action === "ui.start") {
      if (this.token === null || req.token !== this.token) {
        return {
          ok: false, action: "ui.start", code: "unauthorized",
          error: "token 缺失或不匹配", retryable: false,
        };
      }
      if (!this.ui_uri) {
        return { ok: false, action: "ui.start", code: "busy", error: "无 UI 端口", retryable: false };
      }
      return {
        ok: true, action: "ui.start", ui: this.ui_uri,
        width: 64, height: 32, codec: "jpeg", fps: 5, state: "ui",
        token: this.token,
      };
    }

    if (action === "ui.stop") {
      if (this.token === null || req.token !== this.token) {
        return {
          ok: false, action: "ui.stop", code: "unauthorized",
          error: "token 缺失或不匹配", retryable: false,
        };
      }
      return { ok: true, action: "ui.stop", state: "ui" };
    }

    return {
      ok: false, action, code: "unknown-action",
      error: `动作 ${JSON.stringify(action)} 不在清单中`, retryable: false,
    };
  }

  private ui_handle(sock: net.Socket): void {
    let buf = Buffer.alloc(0);
    let stage = 0; // 0=读 token 长度, 1=读 token, 2=已出帧
    let token_len = 0;
    sock.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (stage === 0 && buf.length >= 1) {
        token_len = buf[0]!;
        buf = buf.subarray(1);
        stage = 1;
      }
      if (stage === 1 && buf.length >= token_len) {
        const token = buf.subarray(0, token_len).toString("utf-8");
        buf = buf.subarray(token_len);
        stage = 2;
        if (token !== (this.token || "")) {
          sock.write(Buffer.from([0x01]));
          sock.end();
          return;
        }
        const header = Buffer.alloc(10);
        header.writeUInt32BE(FAKE_JPEG.length, 0);
        header.writeUInt16BE(64, 4);
        header.writeUInt16BE(32, 6);
        header.writeUInt8(1, 8); // codec = JPEG
        header.writeUInt8(1, 9); // flags
        sock.write(Buffer.from([0x00]));
        sock.write(Buffer.concat([header, FAKE_JPEG]));
        sock.end();
      }
    });
    sock.on("error", () => sock.destroy());
  }
}
