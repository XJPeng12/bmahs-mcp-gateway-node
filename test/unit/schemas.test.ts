import { describe, expect, it } from "vitest";
import {
  arg_property,
  find_op,
  input_schema,
  mcp_tool_name,
  normalize_args,
  tool_description,
} from "../../src/schemas.js";

const hello = {
  id: "light-001",
  name: "客厅灯",
  summary: "支持调光调色的智能灯",
  hint: "靠近窗户那盏",
  security: { scope: "lan", auth: "token", notes: "控制前须 occupy" },
};

const brightness_op = {
  name: "brightness",
  description: "把灯的亮度调到指定百分比",
  args: [
    {
      name: "level",
      type: "int",
      required: true,
      description: "亮度百分比",
      min: 0,
      max: 100,
      unit: "%",
      example: 40,
    },
  ],
  result: "回 level 与当前 state",
};

describe("normalize_args", () => {
  it("旧版字符串数组补默认定义", () => {
    const ops = normalize_args({ args: ["level", { name: "n", type: "int", required: true }] });
    expect(ops[0]).toMatchObject({ name: "level", type: "string", required: false });
    expect(ops[1]).toMatchObject({ name: "n", type: "int", required: true });
    expect(normalize_args({ args: "not-a-list" })).toEqual([]);
  });
});

describe("arg_property / input_schema", () => {
  it("type 映射 + min/max/enum/unit/example 拼接", () => {
    const p = arg_property(brightness_op.args![0] as never);
    expect(p.type).toBe("integer");
    expect(p.minimum).toBe(0);
    expect(p.maximum).toBe(100);
    expect(String(p.description)).toContain("亮度百分比");
    expect(String(p.description)).toContain("单位：%");
    expect(String(p.description)).toContain("示例：40");

    const p2 = arg_property({ name: "mode", type: "string", enum: ["none", "rainbow"] });
    expect(p2.enum).toEqual(["none", "rainbow"]);
    expect(String(p2.description)).toContain("可选值：none、rainbow");
  });

  it("inputSchema：required 与 additionalProperties=false", () => {
    const s = input_schema(brightness_op);
    expect(s.type).toBe("object");
    expect(s.additionalProperties).toBe(false);
    expect(s.required).toEqual(["level"]);
    const s2 = input_schema({ name: "on", args: [] });
    expect(s2.required).toBeUndefined();
    expect(Object.keys(s2.properties as object)).toHaveLength(0);
  });
});

describe("tool_description", () => {
  it("自述+desc+result+any_of+security+hint 全部拼入", () => {
    const op = {
      name: "scene",
      description: "切换场景",
      args: [],
      any_of: ["name", "index"],
      result: "回 scene 名",
    };
    const d = tool_description(hello, op);
    expect(d).toContain("[BMAHS 设备「客厅灯」] 支持调光调色的智能灯");
    expect(d).toContain("切换场景");
    expect(d).toContain("成功时：回 scene 名");
    expect(d).toContain("「name」、「index」 至少提供一个");
    expect(d).toContain("安全边界：控制前须 occupy");
    expect(d).toContain("设备提示：靠近窗户那盏");
  });

  it("旧 desc 字段兼容", () => {
    const d = tool_description(hello, { name: "on", desc: "开灯", args: [] });
    expect(d).toContain("开灯");
  });
});

describe("mcp_tool_name", () => {
  it("基本命名与非法字符替换", () => {
    expect(mcp_tool_name("light-001", "on")).toBe("light-001__on");
    // 中文 id/动作逐字替换为 _
    expect(mcp_tool_name("灯", "开")).toBe("____"); // 灯__开 → 4 字符全替换
    expect(mcp_tool_name("客厅灯", "开灯")).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("超长截断 + md5 后缀", () => {
    const long_id = "x".repeat(80);
    const name = mcp_tool_name(long_id, "on");
    expect(name.length).toBeLessThanOrEqual(64);
    expect(name).toMatch(/-[0-9a-f]{6}$/);
    expect(mcp_tool_name(long_id, "on")).toBe(mcp_tool_name(long_id, "on"));
  });
});

describe("find_op", () => {
  it("新 operations / 旧 ops 都能找到", () => {
    const h = { operations: [brightness_op] };
    expect(find_op(h, "brightness")).toBe(brightness_op);
    expect(find_op({ ops: [brightness_op] }, "brightness")).toBe(brightness_op);
    expect(find_op(h, "nope")).toBeNull();
  });
});
