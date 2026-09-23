/**
 * 端到端联调：假 BMAHS 设备 + MCP 客户端 → bmahs-mcp-node 网关（stdio）。
 *
 * 复刻 Python 版 tests/smoke_test.py 的 17 项行为契约：发现、hello 缓存、
 * 动态工具映射、自动占用、token 不外泄、any_of 预检、错误信封透传、
 * occupy/release、泛化调用、退出自动释放。
 *
 * 运行：npm run smoke
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { FakeBmahsDevice } from "./fake-device.js";
import { fetch_hello } from "../src/client.js";

const checks: string[] = [];

function ok(label: string): void {
  checks.push(label);
  console.log(`  ✔ ${label}`);
}

interface ToolResult {
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  isError?: boolean;
}

function text_of(result: ToolResult): string {
  return result.content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");
}

function json_of(result: ToolResult): Record<string, unknown> {
  try {
    return JSON.parse(text_of(result));
  } catch {
    return {};
  }
}

async function main(): Promise<number> {
  const dev = new FakeBmahsDevice("demo-light-001", "测试客厅灯");
  await dev.start();
  console.log(`[1] 启动假设备 demo-light-001（${dev.uri}）…`);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/bin.js", "serve"],
    env: {
      ...process.env,
      BMAHS_STATIC_DEVICES: dev.uri,
      BMAHS_BONJOUR_BROWSE: "0",
      BMAHS_AUTO_OCCUPY_TTL: "120",
    } as Record<string, string>,
  });
  const client = new Client({ name: "smoke-client", version: "0.1.0" });
  const all_texts: string[] = [];
  const capture = async <T>(p: Promise<T>): Promise<T> => {
    const r = await p;
    if (r && typeof r === "object" && "content" in (r as object)) {
      all_texts.push(text_of(r as unknown as ToolResult));
    }
    return r;
  };

  try {
    await client.connect(transport);
    const init = client.getServerVersion();
    console.log(`[2] MCP 已连接：server=${init?.name ?? "?"}`);

    // 1. bmahs_refresh 发现虚拟设备
    const refresh = (await capture(client.callTool({ name: "bmahs_refresh", arguments: {} }))) as ToolResult;
    const refreshed = json_of(refresh);
    if (!refresh.isError && refreshed.devices && (refreshed.devices as unknown[]).some((d) => (d as Record<string, unknown>).id === "demo-light-001")) {
      ok("bmahs_refresh 发现假设备");
    } else throw new Error(`refresh 失败：${text_of(refresh)}`);

    // 2. list_tools 动态映射
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    const dyn = names.filter((n) => n.startsWith("demo-light-001__"));
    if (
      names.includes("bmahs_devices") &&
      ["demo-light-001__on", "demo-light-001__brightness", "demo-light-001__scene"].every((n) =>
        names.includes(n),
      ) &&
      tools.length === 7 + dyn.length
    ) {
      ok(`list_tools 动态映射（共 ${tools.length} 个工具，其中设备工具 ${dyn.length} 个）`);
    } else throw new Error(`工具表异常：${names.join(",")}`);

    // 3. 工具 schema 来自 ops
    const brightness = tools.find((t) => t.name === "demo-light-001__brightness")!;
    const schema = brightness.inputSchema as Record<string, unknown>;
    const props = schema.properties as Record<string, Record<string, unknown>>;
    if (
      props.level?.maximum === 100 &&
      Array.isArray(schema.required) &&
      (schema.required as string[]).includes("level") &&
      String(props.level.description).includes("亮度")
    ) {
      ok("工具 schema 来自 ops（desc/min/max/required）");
    } else throw new Error(`schema 异常：${JSON.stringify(schema)}`);

    // 4. 动态工具 on（网关自动 occupy）
    const on = (await capture(client.callTool({ name: "demo-light-001__on", arguments: {} }))) as ToolResult;
    const on_payload = json_of(on);
    if (!on.isError && on_payload.ok === true && on_payload.token && String(on_payload.token).includes("«token")) {
      ok("动态工具 on（网关自动 occupy，token 已遮蔽）");
    } else throw new Error(`on 失败：${text_of(on)}`);
    const device_token = String(dev.token ?? ""); // 供第 17 项泄漏检查（release 后 dev.token 会被清空）

    // 5. brightness level=40
    const bright = (await capture(
      client.callTool({ name: "demo-light-001__brightness", arguments: { level: 40 } }),
    )) as ToolResult;
    if (!bright.isError && json_of(bright).level === 40) ok("brightness level=40");
    else throw new Error(`brightness 失败：${text_of(bright)}`);

    // 6. scene 缺参：any_of 预检
    const scene_err = (await capture(
      client.callTool({ name: "demo-light-001__scene", arguments: {} }),
    )) as ToolResult;
    if (scene_err.isError && json_of(scene_err).code === "bad-arg") ok("scene 缺参：any_of 预检返回 bad-arg 信封");
    else throw new Error(`scene 预检异常：${text_of(scene_err)}`);

    // 7. scene name=cinema
    const scene = (await capture(
      client.callTool({ name: "demo-light-001__scene", arguments: { name: "cinema" } }),
    )) as ToolResult;
    if (!scene.isError && json_of(scene).ok === true) ok("scene name=cinema");
    else throw new Error(`scene 失败：${text_of(scene)}`);

    // 8. bmahs_devices：受管且持有者为网关
    const devices_res = (await capture(client.callTool({ name: "bmahs_devices", arguments: {} }))) as ToolResult;
    const listing = json_of(devices_res);
    const item = (listing.devices as Record<string, unknown>[])[0]!;
    if (item.state === "managed" && item.occupied_by_gateway === true && String(item.holder).startsWith("bmahs-mcp-")) {
      ok("bmahs_devices：显示 managed 且持有者为网关");
    } else throw new Error(`devices 异常：${text_of(devices_res)}`);

    // 9. bmahs_describe 按显示名解析
    const desc = (await capture(
      client.callTool({ name: "bmahs_describe", arguments: { device: "测试客厅灯" } }),
    )) as ToolResult;
    const desc_payload = json_of(desc);
    if (!desc.isError && desc_payload.id === "demo-light-001") ok("bmahs_describe 按显示名解析设备");
    else throw new Error(`describe 失败：${text_of(desc)}`);

    // 10. bmahs_occupy ttl=120（同一占用方刷新租约）
    const occupy = (await capture(
      client.callTool({ name: "bmahs_occupy", arguments: { device: "demo-light-001", ttl: 120 } }),
    )) as ToolResult;
    if (!occupy.isError && json_of(occupy).lease_security === 120) ok("bmahs_occupy ttl=120（刷新租约）");
    else throw new Error(`occupy 失败：${text_of(occupy)}`);

    // 11. ttl 越界被拒
    const bad_ttl = (await capture(
      client.callTool({ name: "bmahs_occupy", arguments: { device: "demo-light-001", ttl: 5 } }),
    )) as ToolResult;
    if (bad_ttl.isError) ok("ttl 越界（5 < 10）被拒绝");
    else throw new Error("ttl=5 竟被接受");

    // 12. bmahs_release
    const release = (await capture(
      client.callTool({ name: "bmahs_release", arguments: { device: "demo-light-001" } }),
    )) as ToolResult;
    if (!release.isError && json_of(release).state === "registered") ok("bmahs_release 释放成功");
    else throw new Error(`release 失败：${text_of(release)}`);

    // 13. bmahs_call 泛化调用（释放后自动重新占用）
    const call = (await capture(
      client.callTool({ name: "bmahs_call", arguments: { device: "demo-light-001", action: "brightness", args: { level: 80 } } }),
    )) as ToolResult;
    if (!call.isError && json_of(call).level === 80) ok("bmahs_call 泛化调用（释放后自动重新占用）");
    else throw new Error(`call 失败：${text_of(call)}`);

    // 14. 清单外动作（防线②：网关拦截并给出 echo + retry_with + 候选清单，不到设备）
    const unknown = (await capture(
      client.callTool({ name: "bmahs_call", arguments: { device: "demo-light-001", action: "reboot" } }),
    )) as ToolResult;
    const unk = json_of(unknown);
    if (unknown.isError && unk.code === "bad-arg" && unk.echo && unk.retry_with && unk.candidates)
      ok("清单外动作 → 网关 bad-arg 信封（echo + retry_with + 候选清单）");
    else throw new Error(`清单外动作异常：${text_of(unknown)}`);

    // 15. 最终 bmahs_release
    const final_release = (await capture(
      client.callTool({ name: "bmahs_release", arguments: { device: "demo-light-001" } }),
    )) as ToolResult;
    if (!final_release.isError && json_of(final_release).state === "registered") ok("最终 bmahs_release");
    else throw new Error(`final release 失败：${text_of(final_release)}`);

    // 16. 网关进程退出后自动 release
    await client.close();
    await new Promise((r) => setTimeout(r, 1200));
    const hello_after = await fetch_hello(dev.uri, 5);
    if (hello_after.state === "registered") ok("网关进程退出后自动 release（设备回到 registered）");
    else throw new Error(`退出后设备状态=${hello_after.state}`);

    // 17. token 未出现在任何会话输出中
    const token_re = new RegExp(`\\b${device_token}\\b`);
    const leaked = all_texts.filter((t) => token_re.test(t));
    if (leaked.length === 0 && device_token) ok("token 未出现在任何会话输出中（已遮蔽）");
    else throw new Error(`token 泄漏：${leaked[0]?.slice(0, 200)}`);

    console.log(`\n全部 ${checks.length} 项检查通过。`);
    return 0;
  } finally {
    try {
      await client.close();
    } catch {
      /* 已关闭 */
    }
    await dev.stop();
  }
}

main()
  .then((code) => (process.exitCode = code))
  .catch((e: Error) => {
    console.error(`\n✘ smoke 失败：${e.message}`);
    process.exitCode = 1;
  });
