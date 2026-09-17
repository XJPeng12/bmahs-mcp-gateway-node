/**
 * 跨语言联调：Python 参考设备 examples/demo_light.py ↔ Node 网关。
 *
 * 验证 Node 实现只凭标准协议面即可与真实参考设备互通（发现→占用→控制→释放）。
 * 需要 E:\zcode\bmahs\.venv 的 Python 环境；缺失时跳过并提示。
 *
 * 运行：npm run smoke:py
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fetch_hello } from "../src/client.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo_root = path.resolve(here, "..", "..");
const PY = path.join(repo_root, ".venv", "Scripts", "python.exe");
const DEMO = path.join(repo_root, "examples", "demo_light.py");
const PORT = parseInt(process.env.DEMO_PORT ?? "19531", 10);

const checks: string[] = [];
function ok(label: string): void {
  checks.push(label);
  console.log(`  ✔ ${label}`);
}

interface ToolResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}
function json_of(result: ToolResult): Record<string, unknown> {
  const text = result.content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

async function main(): Promise<number> {
  if (!existsSync(PY) || !existsSync(DEMO)) {
    console.log(`跳过：未找到 Python 环境（${PY}）或 demo_light（${DEMO}）。`);
    return 0;
  }
  console.log(`[1] 启动 Python 参考设备 demo-light-py（端口 ${PORT}）…`);
  const dev = spawn(PY, [DEMO, "--id", "demo-light-py", "--name", "跨语言测试灯", "--port", String(PORT), "--no-bonjour"], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  // 排空设备 stderr 防管道阻塞
  dev.stderr?.on("data", () => {});
  await new Promise((r) => setTimeout(r, 1500));

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/bin.js", "serve"],
    env: {
      ...process.env,
      BMAHS_STATIC_DEVICES: `tcp://127.0.0.1:${PORT}`,
      BMAHS_BONJOUR_BROWSE: "0",
    } as Record<string, string>,
  });
  const client = new Client({ name: "smoke-py", version: "0.1.0" });

  try {
    await client.connect(transport);
    const refresh = (await client.callTool({ name: "bmahs_refresh", arguments: {} })) as ToolResult;
    const devices = (json_of(refresh).devices as Record<string, unknown>[]) ?? [];
    if (devices.some((d) => d.id === "demo-light-py")) ok("bmahs_refresh 发现 Python demo_light");
    else throw new Error(`未发现 demo-light-py：${JSON.stringify(devices.map((d) => d.id))}`);

    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    if (["demo-light-py__on", "demo-light-py__off", "demo-light-py__brightness", "demo-light-py__color", "demo-light-py__scene", "demo-light-py__status"].every((n) =>
      names.includes(n),
    )) {
      ok(`动态工具映射完整（demo_light 7 个业务动作，工具表共 ${tools.length} 个）`);
    } else throw new Error(`工具缺失：${names.filter((n) => n.startsWith("demo-light-py__")).join(",")}`);

    const on = (await client.callTool({ name: "demo-light-py__on", arguments: {} })) as ToolResult;
    if (!on.isError && json_of(on).ok === true) ok("动态工具 on（自动 occupy Python 设备）");
    else throw new Error(`on 失败：${JSON.stringify(json_of(on))}`);

    const bright = (await client.callTool({ name: "demo-light-py__brightness", arguments: { level: 66 } })) as ToolResult;
    if (!bright.isError && json_of(bright).level === 66) ok("brightness level=66");
    else throw new Error(`brightness 失败：${JSON.stringify(json_of(bright))}`);

    const scene = (await client.callTool({ name: "demo-light-py__scene", arguments: { name: "night" } })) as ToolResult;
    if (!scene.isError && json_of(scene).ok === true) ok("scene name=night");
    else throw new Error(`scene 失败：${JSON.stringify(json_of(scene))}`);

    const devices_res = (await client.callTool({ name: "bmahs_devices", arguments: {} })) as ToolResult;
    const item = ((json_of(devices_res).devices as Record<string, unknown>[]) ?? []).find(
      (d) => d.id === "demo-light-py",
    );
    if (item && item.state === "managed" && String(item.holder ?? "").startsWith("bmahs-mcp-")) {
      ok("bmahs_devices：Python 设备显示 managed 且持有者为 Node 网关");
    } else throw new Error(`devices 异常：${JSON.stringify(item)}`);

    const release = (await client.callTool({ name: "bmahs_release", arguments: { device: "demo-light-py" } })) as ToolResult;
    if (!release.isError && json_of(release).state === "registered") ok("bmahs_release 释放成功");
    else throw new Error(`release 失败：${JSON.stringify(json_of(release))}`);

    await client.close();
    await new Promise((r) => setTimeout(r, 1200));
    const hello_after = await fetch_hello(`tcp://127.0.0.1:${PORT}`, 5);
    if (hello_after.state === "registered") ok("网关退出后设备自动回到 registered");
    else throw new Error(`退出后状态=${hello_after.state}`);

    console.log(`\n跨语言联调 ${checks.length} 项检查全部通过（Python 设备 ↔ Node 网关互通）。`);
    return 0;
  } finally {
    try {
      await client.close();
    } catch {
      /* 已关闭 */
    }
    dev.kill();
  }
}

main()
  .then((code) => (process.exitCode = code))
  .catch((e: Error) => {
    console.error(`\n✘ smoke:py 失败：${e.message}`);
    process.exitCode = 1;
  });
