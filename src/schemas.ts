/**
 * 把 BMAHS `hello.ops` 转成 MCP 工具 schema（协议 §4.5 / §4.8）。
 *
 * 协议要求智能体运行时：
 * - 工具说明来自 `desc`，参数定义只来自 `args`，返回说明只来自 `result` / `returns`；
 * - `name` / `summary` / `hint` / `security.notes` 等自然语言必须交给模型，不得剥掉；
 * - 兼容 bmahs/1 的旧字符串数组 `args`：按 type=string、required=false 理解。
 */

import { createHash } from "node:crypto";

/** BMAHS 参数类型 -> JSON Schema 类型（§4.5）；int/float 是 bool 型别名的归一化 */
export const TYPE_MAP: Record<string, string> = {
  string: "string",
  int: "integer",
  integer: "integer",
  number: "number",
  float: "number",
  bool: "boolean",
  boolean: "boolean",
  object: "object",
  array: "array",
};

export type OpArgs = Record<string, unknown>;
export type Op = Record<string, unknown>;
export type Hello = Record<string, unknown>;

/** 把某动作的 args 归一为统一的 dict 列表（新协议原样保留，旧版字符串数组补默认定义）。 */
export function normalize_args(op: Op): OpArgs[] {
  const args = op.args ?? [];
  if (!Array.isArray(args)) return [];
  const out: OpArgs[] = [];
  for (const a of args) {
    if (typeof a === "string" && a) {
      // 兼容旧版（bmahs/1）字符串数组 args：按 type=string、required=false 理解
      out.push({
        name: a,
        type: "string",
        required: false,
        description: "（旧版设备未提供参数说明；可发 describe 获取完整清单）",
      });
    } else if (typeof a === "object" && a !== null && (a as OpArgs).name) {
      out.push(a as OpArgs);
    }
  }
  return out;
}

function is_num(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

/** 把一个参数定义转成 JSON Schema 的 property 片段（type/description/min/max/enum…）。
 *
 * description/unit/enum/default/example 拼成一句自然语言说明，帮助模型理解参数含义。
 */
export function arg_property(a: OpArgs): Record<string, unknown> {
  const jtype = TYPE_MAP[String(a.type ?? "string").toLowerCase()] ?? "string";
  const parts: string[] = [];
  // §4.5 字段名为 description；兼容旧版 bmahs/1.2 设备的 desc
  const desc = a.description || a.desc;
  if (desc) parts.push(String(desc));
  if (a.unit) parts.push(`单位：${a.unit}。`);
  const enumv = a.enum;
  // enum 必须是数组才进 schema；字符串等畸形值不会误入
  if (Array.isArray(enumv) && enumv.length > 0) {
    parts.push("可选值：" + enumv.map((x) => String(x)).join("、") + "。");
  }
  if (a.default !== null && a.default !== undefined) parts.push(`缺省值：${a.default}。`);
  if (a.example !== null && a.example !== undefined) parts.push(`示例：${a.example}。`);
  const prop: Record<string, unknown> = { type: jtype };
  if (parts.length > 0) prop.description = parts.join(" ");
  if (is_num(a.min)) prop.minimum = a.min;
  if (is_num(a.max)) prop.maximum = a.max;
  if (Array.isArray(enumv) && enumv.length > 0) prop.enum = enumv;
  return prop;
}

/** 把动作的 args 列表转成 MCP 工具的完整 inputSchema（含 required 数组）。 */
export function input_schema(op: Op): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  const required: string[] = [];
  for (const a of normalize_args(op)) {
    props[String(a.name)] = arg_property(a);
    if (a.required === true) required.push(String(a.name));
  }
  const schema: Record<string, unknown> = {
    type: "object",
    properties: props,
    additionalProperties: false,
  };
  if (required.length > 0) schema.required = required;
  return schema;
}

/** 组装工具说明：设备自述 + 动作说明 + 结果读法 + 约束 + 安全边界。
 *
 * §4.5：`any_of` 写入工具说明（不在 JSON Schema 里强校验），供模型发请求前自查。
 */
export function tool_description(hello: Hello, op: Op): string {
  const name = hello.name || hello.id || "?";
  const summary = hello.summary || "";
  const lines = [`[BMAHS 设备「${name}」] ${summary}`.replace(/\s+$/, "")];
  const desc = op.description || op.desc || op.name || "";
  lines.push(String(desc));
  if (op.result) lines.push(`成功时：${op.result}`);
  const any_of = (op.any_of as string[] | undefined) ?? [];
  if (Array.isArray(any_of) && any_of.length > 0) {
    lines.push("参数约束：" + any_of.map((a) => `「${a}」`).join("、") + " 至少提供一个。");
  }
  const sec = (hello.security as Hello | undefined) ?? {};
  if (sec.notes) lines.push(`安全边界：${sec.notes}`);
  if (hello.hint) lines.push(`设备提示：${hello.hint}`);
  return lines.filter((x) => x).join("\n");
}

/** 工具名 `<设备id>__<动作>`，限定 `[A-Za-z0-9_-]{1,64}`；超长时哈希截断防碰撞。 */
export function mcp_tool_name(device_id: string, action: string): string {
  const raw = `${device_id}__${action}`;
  let name = raw.replace(/[^A-Za-z0-9_-]/g, "_");
  if (name.length > 64) {
    const digest = createHash("md5").update(raw, "utf-8").digest("hex").slice(0, 6);
    name = name.slice(0, 57) + "-" + digest;
  }
  return name;
}

/** 在设备 hello 的操作清单（新 operations / 旧 ops）里按名字找动作定义。 */
export function find_op(hello: Hello, action: string): Op | null {
  const ops = hello.operations ?? hello.ops ?? [];
  if (!Array.isArray(ops)) return null;
  for (const op of ops) {
    if (typeof op === "object" && op !== null && (op as Op).name === action) {
      return op as Op;
    }
  }
  return null;
}
