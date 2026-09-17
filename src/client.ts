/**
 * BMAHS 控制层 TCP 客户端（协议 §6）：hello 读取与一问一答行协议。
 *
 * 成帧：一条 TCP 记录 = 一行 UTF-8 JSON + `\n`。
 * 网关对每次调用使用短连接（连上先读 hello，再发一行动作，读一行响应即断开），
 * 既刷新了设备自述，又避免了设备/网关两侧的半开连接状态。
 */

import * as net from "node:net";
import { parse_control_uri, type BmahsMessage } from "./protocol.js";

type Socket = net.Socket;

export const READ_LIMIT = 1 << 20; // hello 携带完整 ops，放宽行长度上限
export const DEFAULT_TIMEOUT = 30.0;

/** 本地连接 / 成帧错误（未到达设备业务层）。 */
export class BmahsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BmahsError";
  }
}

/** 帧读取中途对端断开（携带已读字节数）。 */
class IncompleteRead extends Error {
  constructor(public partial: number) {
    super(`incomplete read (${partial} bytes)`);
  }
}

type Waiter =
  | { kind: "line"; resolve: (line: Buffer) => void; reject: (e: Error) => void }
  | { kind: "exact"; n: number; resolve: (buf: Buffer) => void; reject: (e: Error) => void };

/** 在 socket 上做带超时的「读一行」/「精确读 N 字节」。 */
class FrameReader {
  private buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private waiters: Waiter[] = [];

  constructor(socket: Socket) {
    socket.on("data", (chunk: Buffer) => {
      this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
      this.pump();
    });
    // close/error：让排队中的 waiter 立即失败（成帧不完整 / 断连）
    const dead = () => {
      const pending = this.waiters;
      this.waiters = [];
      for (const w of pending) {
        if (w.kind === "line") w.reject(new BmahsError("设备断开了连接（未返回数据）"));
        else w.reject(new IncompleteRead(this.buffer.length));
      }
      this.buffer = Buffer.alloc(0);
    };
    socket.on("close", dead);
    socket.on("error", () => {
      /* close 事件会跟着到；这里吞掉避免未处理异常 */
    });
  }

  private pump(): void {
    while (this.waiters.length > 0) {
      const w = this.waiters[0]!;
      if (w.kind === "line") {
        const idx = this.buffer.indexOf(0x0a);
        if (idx < 0) {
          if (this.buffer.length > READ_LIMIT) {
            this.waiters.shift();
            w.reject(new BmahsError("设备返回了超长行（超过 1 MiB 上限）"));
            continue;
          }
          break;
        }
        const line = this.buffer.subarray(0, idx);
        this.buffer = this.buffer.subarray(idx + 1);
        this.waiters.shift();
        w.resolve(line);
      } else {
        if (this.buffer.length < w.n) break;
        const out = this.buffer.subarray(0, w.n);
        this.buffer = this.buffer.subarray(w.n);
        this.waiters.shift();
        w.resolve(out);
      }
    }
  }

  /** 读一行（不含换行符）；超时/断连抛 BmahsError。 */
  read_line(timeout: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const wrapped: Waiter = {
        kind: "line",
        resolve: (b) => {
          clearTimeout(timer);
          resolve(b);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== wrapped);
        reject(new BmahsError(`设备响应超时（${timeout.toFixed(0)}s）`));
      }, timeout * 1000);
      this.waiters.push(wrapped);
      this.pump();
    });
  }

  /** 精确读 n 字节；对端提前断开抛 IncompleteRead（带 partial 字节数）。 */
  read_exact(n: number, timeout: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const wrapped: Waiter = {
        kind: "exact",
        n,
        resolve: (b) => {
          clearTimeout(timer);
          resolve(b);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== wrapped);
        reject(new BmahsError("读取 UI 帧超时"));
      }, timeout * 1000);
      this.waiters.push(wrapped);
      this.pump();
    });
  }
}

const readers = new WeakMap<Socket, FrameReader>();

function frame_reader(sock: Socket): FrameReader {
  let r = readers.get(sock);
  if (!r) {
    r = new FrameReader(sock);
    readers.set(sock, r);
  }
  return r;
}

function connect_socket_impl(uri: string, timeout: number, what: string): Promise<Socket> {
  const target = parse_control_uri(uri);
  if (!target) throw new BmahsError(`无法解析 ${what} URI：${JSON.stringify(uri)}（期望形如 tcp://IP:PORT）`);
  const { host, port } = target;
  return new Promise<Socket>((resolve, reject) => {
    const sock = net.connect({ host, port });
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new BmahsError(`连接 ${what} 流 ${host}:${port} 超时（${timeout.toFixed(0)}s）`));
    }, timeout * 1000);
    sock.once("connect", () => {
      clearTimeout(timer);
      resolve(sock);
    });
    sock.once("error", (e) => {
      clearTimeout(timer);
      reject(new BmahsError(`连接 ${what} 流 ${host}:${port} 失败：${e.message}`));
    });
  });
}

/** 静默关闭连接：短连接模型下断开是常态，关闭失败无需上抛。 */
async function close_socket(sock: Socket): Promise<void> {
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        resolve();
      }
    };
    sock.once("close", finish);
    sock.end();
    setTimeout(() => {
      sock.destroy();
      finish();
    }, 1000).unref();
  });
}

/** 按行协议读一行并解析为 JSON 对象；超时 / 断连 / 非 JSON / 非对象均抛 BmahsError。 */
async function read_json_line(sock: Socket, timeout: number): Promise<BmahsMessage> {
  const line = await frame_reader(sock).read_line(timeout);
  let obj: unknown;
  try {
    obj = JSON.parse(line.toString("utf-8"));
  } catch {
    throw new BmahsError(
      `设备返回了非 JSON 行：${JSON.stringify(line.subarray(0, 160).toString("utf-8"))}`,
    );
  }
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
    throw new BmahsError("设备返回了非 JSON 对象");
  }
  return obj as BmahsMessage;
}

/** 连上 control 并读取首行 hello（§6.2）。
 *
 * 校验 `operations`（兼容期同时接受旧版 bmahs/1.2 设备的 `ops` 键）。
 */
export async function fetch_hello(uri: string, timeout = 8.0): Promise<BmahsMessage> {
  const sock = await connect_socket_impl(uri, timeout, "设备");
  try {
    const hello = await read_json_line(sock, timeout);
    if (hello.action !== "hello" || (!Array.isArray(hello.operations) && !Array.isArray(hello.ops))) {
      throw new BmahsError("连接后未收到合法的 hello（对端可能不是 BMAHS 设备）");
    }
    return hello;
  } finally {
    await close_socket(sock);
  }
}

/** 短连接一问一答：hello → 请求行 → 响应行。返回 `{ hello, resp }`。 */
export async function call_action(
  uri: string,
  payload: BmahsMessage,
  timeout = DEFAULT_TIMEOUT,
): Promise<{ hello: BmahsMessage; resp: BmahsMessage }> {
  const sock = await connect_socket_impl(uri, timeout, "设备");
  try {
    const hello = await read_json_line(sock, Math.min(timeout, 10.0));
    sock.write(Buffer.from(JSON.stringify(payload), "utf-8"));
    sock.write("\n");
    const resp = await read_json_line(sock, timeout);
    return { hello, resp };
  } finally {
    await close_socket(sock);
  }
}

export interface UiFrame {
  codec: number;
  width: number;
  height: number;
  payload: Buffer;
}

/** 读一帧：10 字节头 `!IHHBB`（payload_len, width, height, codec, flags）+ payload。
 *
 * 返回 null 表示设备端正常关闭流（帧已读完）。
 */
async function read_ui_frame_inner(reader: FrameReader, timeout: number): Promise<UiFrame | null> {
  let header: Buffer;
  try {
    header = await reader.read_exact(10, timeout);
  } catch (e) {
    if (e instanceof IncompleteRead) return null;
    throw e;
  }
  const payload_len = header.readUInt32BE(0);
  const width = header.readUInt16BE(4);
  const height = header.readUInt16BE(6);
  const codec = header.readUInt8(8);
  if (payload_len <= 0 || payload_len > 32 * 1024 * 1024) {
    throw new BmahsError(`UI 帧长度异常：${payload_len}`);
  }
  try {
    const payload = await reader.read_exact(payload_len, timeout);
    return { codec, width, height, payload };
  } catch (e) {
    if (e instanceof IncompleteRead) return null;
    throw e;
  }
}

async function open_ui_stream(uri: string, token: string, timeout: number): Promise<{ sock: Socket; reader: FrameReader }> {
  const target = parse_control_uri(uri);
  if (!target) throw new BmahsError(`无法解析 ui URI：${JSON.stringify(uri)}`);
  const sock = await connect_socket_impl(uri, timeout, "UI");
  const token_bytes = Buffer.from(token, "utf-8");
  sock.write(Buffer.concat([Buffer.from([token_bytes.length]), token_bytes]));
  const reader = frame_reader(sock);
  const status = await reader.read_exact(1, timeout);
  if (status[0] !== 0) {
    await close_socket(sock);
    throw new BmahsError(`UI 流鉴权失败（status=${status[0]}），设备拒绝出帧`);
  }
  return { sock, reader };
}

/** 连接 ui.start 返回的 UI 流并读取一帧（协议 §4.9.4 二进制帧）。
 *
 * 返回 `{ codec, width, height, payload }`；codec 1 = JPEG。
 */
export async function read_ui_frame(uri: string, token: string, timeout = 15.0): Promise<UiFrame> {
  const { sock, reader } = await open_ui_stream(uri, token, timeout);
  try {
    const frame = await read_ui_frame_inner(reader, timeout);
    if (!frame) throw new BmahsError("UI 流提前断开（已读 0 字节）");
    return frame;
  } catch (e) {
    if (e instanceof IncompleteRead) throw new BmahsError(`UI 流提前断开（已读 ${e.partial} 字节）`);
    throw e;
  } finally {
    await close_socket(sock);
  }
}

/** 持续读 UI 流（协议 §4.9.4）：鉴权后逐帧 yield `{ codec, width, height, payload }`。
 *
 * 设备正常关闭流（帧读完）时正常结束；超时抛 {@link BmahsError}。
 */
export async function* read_ui_frames(uri: string, token: string, timeout = 30.0): AsyncGenerator<UiFrame> {
  const { sock, reader } = await open_ui_stream(uri, token, timeout);
  try {
    for (;;) {
      const frame = await read_ui_frame_inner(reader, timeout);
      if (!frame) return; // 设备端正常关闭流
      yield frame;
    }
  } finally {
    await close_socket(sock);
  }
}
