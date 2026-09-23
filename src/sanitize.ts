/**
 * 参数净化器（防线②，docs/工具调用参数死循环_网关侧防护方案.md §5）。
 *
 * 背景：本地小模型填工具参数时会写出「形状正确但内容畸形」的调用（device 传成
 * `{id: 名称}` 映射、整数传成字符串数字、动作名近似拼错…），报错后原样重试即
 * 锁死成循环。本模块在调用分发前做一次无歧义矫正，把「首错」变成「首成功」。
 *
 * 三条原则：
 * 1. 无歧义才静默矫正：解包/转换/近似匹配结果唯一才自动改，歧义一律报错并附候选；
 * 2. 矫正必须透明：静默矫正的清单（coerced）随成功响应回带，模型下一轮直接填对；
 * 3. 控制类动作只建议、不代执行：动作名近似匹配仅对只读动作自动改写。
 *
 * 所有报错都用富错误信封（rich_error）：`echo` 用 JSON 语法回显实际传参，
 * `retry_with` 给出可逐字照抄的正确形态——利用「模型照抄上下文最近先例」的
 * 机制，让最近的先例变成正确模板。
 */

import type { Gateway } from "./gateway.js";
import { TYPE_MAP, normalize_args, type Hello, type Op } from "./schemas.js";

export type CoercedNote = { arg: string; from: unknown; to: unknown; note: string };
export type SanitizeError = Record<string, unknown>;

const TRUE_STRINGS = new Set(["true", "1"]);
const FALSE_STRINGS = new Set(["false", "0"]);

/** 近似匹配阈值：0.75 抓得住 "lamp01"→"lamp-01" 这类漏字符/加连字符错误 */
const DEVICE_MATCH_CUTOFF = 0.75;
const ACTION_MATCH_CUTOFF = 0.6;

/** 组装富错误信封（§4.7 兼容：ok/action 语义不变，额外字段模型可读）。 */
export function rich_error(
  error: string,
  opts: {
    code?: string;
    echo?: unknown;
    retry_with?: unknown;
    candidates?: string[] | null;
    retryable?: boolean;
  } = {},
): SanitizeError {
  const env: SanitizeError = {
    ok: false,
    code: opts.code ?? "bad-arg",
    error,
    retryable: opts.retryable ?? false,
  };
  if (opts.echo !== undefined && opts.echo !== null) env.echo = opts.echo;
  if (opts.retry_with !== undefined && opts.retry_with !== null) env.retry_with = opts.retry_with;
  if (opts.candidates && opts.candidates.length > 0) env.candidates = opts.candidates;
  return env;
}

function lcs_len(a: string, b: string): number {
  let prev = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1]! + 1 : Math.max(prev[j]!, cur[j - 1]!);
    }
    prev = cur;
  }
  return prev[b.length]!;
}

/** 与 Python difflib ratio 同式的相似度：2*M/(|a|+|b|)，M = LCS 长度。 */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  return (2 * lcs_len(a, b)) / (a.length + b.length);
}

/** difflib.get_close_matches 的等价实现：相似度 cutoff 以上取前 n 个。 */
export function close_matches(word: string, candidates: string[], n = 2, cutoff = 0.75): string[] {
  return candidates
    .map((c) => ({ c, s: similarity(word, c) }))
    .filter((x) => x.s >= cutoff)
    .sort((x, y) => y.s - x.s)
    .slice(0, n)
    .map((x) => x.c);
}

/** 取一个真实设备 id 做示例（排序第一台）；无设备时回退占例 `lamp-01`。 */
export function example_device_ref(gw: Gateway): string {
  const devs = [...gw.discovery.all()].sort((a, b) => (a.id < b.id ? -1 : 1));
  return devs[0]?.id ?? "lamp-01";
}

/** 当前已知设备的「id（显示名）」清单，报错候选用。 */
export function known_device_list(gw: Gateway, limit = 8): string[] {
  const devs = [...gw.discovery.all()].sort((a, b) => (a.id < b.id ? -1 : 1));
  const items = devs.map((d) => `${d.id}（${d.name}）`);
  if (items.length > limit) return items.slice(0, limit).concat([`…（共 ${devs.length} 台）`]);
  return items;
}

/** difflib 近似匹配设备 id/显示名。返回 `[唯一命中的设备 id 或 null, 其余候选 id]`。 */
export function near_match_device(gw: Gateway, ref: string): [string | null, string[]] {
  const pool = new Map<string, string>();
  for (const d of gw.discovery.all()) {
    pool.set(d.id, d.id);
    if (!pool.has(d.name)) pool.set(d.name, d.id);
  }
  const close = close_matches(ref, [...pool.keys()], 2, DEVICE_MATCH_CUTOFF);
  const ids = [...new Set(close.map((c) => pool.get(c)!))].sort();
  return ids.length === 1 ? [ids[0]!, []] : [null, ids];
}

/** 在设备操作清单里近似匹配动作名。返回 `[唯一命中或 null, 全部动作名]`。 */
export function near_match_action(hello: Hello, action: string): [string | null, string[]] {
  const ops = (hello.operations ?? hello.ops ?? []) as unknown[];
  const names = ops
    .filter((op): op is Op => typeof op === "object" && op !== null && Boolean((op as Op).name))
    .map((op) => String(op.name));
  const close = close_matches(action, names, 2, ACTION_MATCH_CUTOFF);
  return close.length === 1 ? [close[0]!, names] : [null, names];
}

/** 净化设备引用参数。返回 `[矫正后的引用或 null, coerced 标注, 富错误或 null]`。 */
export function coerce_device_ref(
  gw: Gateway,
  value: unknown,
  arg = "device",
): [string | null, CoercedNote[], SanitizeError | null] {
  const notes: CoercedNote[] = [];
  const example = example_device_ref(gw);
  if (value === null || value === undefined || (typeof value === "string" && value.trim() === "")) {
    return [
      null,
      notes,
      rich_error(
        `缺少 ${arg} 参数：请传设备 id 字符串本身，如 ${JSON.stringify(example)}` +
          "（可先用 bmahs_devices 查询设备列表）。",
        { echo: { [arg]: value ?? null }, retry_with: { [arg]: example } },
      ),
    ];
  }
  // 1) 字符串：能解析直接用；解析不了做近似推荐（唯一命中才自动矫正）
  if (typeof value === "string") {
    const ref = value.trim();
    if (gw.resolve_quiet(ref) !== null) return [ref, notes, null];
    const [hit] = near_match_device(gw, ref);
    if (hit !== null) {
      notes.push({
        arg,
        from: ref,
        to: hit,
        note: `已把 ${arg} 从 ${JSON.stringify(ref)} 近似矫正为 ${JSON.stringify(hit)}`,
      });
      return [hit, notes, null];
    }
    // 近似也无唯一命中：交回 resolve_device 报错（其错误附已知设备清单与 retry_with）
    return [ref, notes, null];
  }
  // 2) 对象：本案的 {"lamp-01": "宝莲灯"} 形态——取能唯一解析出设备的键/值
  if (typeof value === "object" && !Array.isArray(value)) {
    const entries = Object.entries(value as Record<string, unknown>);
    const hits = new Set<string>();
    for (const [k, v] of entries) {
      for (const cand of [k, v]) {
        if (typeof cand === "string") {
          const dev = gw.resolve_quiet(cand.trim());
          if (dev) hits.add(dev.id);
        }
      }
    }
    if (hits.size === 1) {
      const dev_id = [...hits][0]!;
      notes.push({
        arg,
        from: value,
        to: dev_id,
        note:
          `${arg} 传了对象，已自动取其中的设备 id ${JSON.stringify(dev_id)}；` +
          "下次请直接传字符串，不要传 {id: 名称} 映射",
      });
      return [dev_id, notes, null];
    }
    if (entries.length === 1 && typeof entries[0]![0] === "string") {
      return [entries[0]![0].trim(), notes, null];
    }
    return [
      null,
      notes,
      rich_error(
        `${arg} 参数收到了对象且无法唯一解析出设备（收到 ${JSON.stringify(value)}）。` +
          `${arg} 必须是设备 id 字符串本身，如 ${JSON.stringify(example)}。`,
        { echo: { [arg]: value }, retry_with: { [arg]: example }, candidates: known_device_list(gw) },
      ),
    ];
  }
  // 3) 数组：取第一个能解析出设备的字符串元素；单元素字符串数组取首元素
  if (Array.isArray(value)) {
    for (const el of value) {
      if (typeof el === "string") {
        const dev = gw.resolve_quiet(el.trim());
        if (dev) {
          notes.push({
            arg,
            from: value,
            to: dev.id,
            note: `${arg} 传了数组，已取其中可解析的元素 ${JSON.stringify(dev.id)}；下次请直接传字符串`,
          });
          return [dev.id, notes, null];
        }
      }
    }
    if (value.length === 1 && typeof value[0] === "string") {
      notes.push({
        arg,
        from: value,
        to: value[0]!.trim(),
        note: `${arg} 传了单元素数组，已取首元素；下次请直接传字符串`,
      });
      return [value[0]!.trim(), notes, null];
    }
    return [
      null,
      notes,
      rich_error(
        `${arg} 参数收到了数组且无法解析出设备。${arg} 必须是设备 id 字符串本身，如 ${JSON.stringify(example)}。`,
        { echo: { [arg]: value }, retry_with: { [arg]: example }, candidates: known_device_list(gw) },
      ),
    ];
  }
  // 4) 数字/布尔等其他类型：直接报错
  return [
    null,
    notes,
    rich_error(
      `${arg} 参数类型错误：需要设备 id 字符串，收到 ${typeof value}。示例：${JSON.stringify({ [arg]: example })}。`,
      { echo: { [arg]: value }, retry_with: { [arg]: example } },
    ),
  ];
}

/** 把数字字符串 / 整数值小数矫正为 number；返回 `[值, notes, error]`。null 原样通过。 */
export function coerce_int(
  value: unknown,
  arg: string,
  example = 120,
): [number | null, CoercedNote[], SanitizeError | null] {
  if (value === null || value === undefined) return [null, [], null];
  if (typeof value === "boolean") {
    return [
      null,
      [],
      rich_error(`${arg} 必须是整数，收到布尔值。示例：${JSON.stringify({ [arg]: example })}。`, {
        echo: { [arg]: value },
        retry_with: { [arg]: example },
      }),
    ];
  }
  if (typeof value === "number" && Number.isInteger(value)) return [value, [], null];
  if (typeof value === "number" && Number.isFinite(value)) {
    const iv = Math.trunc(value);
    return [iv, [{ arg, from: value, to: iv, note: `${arg} 收到小数，已取整为 ${iv}` }], null];
  }
  if (typeof value === "string") {
    const iv = Number.parseInt(value.trim(), 10);
    if (!Number.isFinite(iv)) {
      return [
        null,
        [],
        rich_error(
          `${arg} 必须是整数，收到字符串 ${JSON.stringify(value)}。示例：${JSON.stringify({ [arg]: example })}。`,
          { echo: { [arg]: value }, retry_with: { [arg]: example } },
        ),
      ];
    }
    return [iv, [{ arg, from: value, to: iv, note: `${arg} 收到字符串数字，已转为整数 ${iv}` }], null];
  }
  return [
    null,
    [],
    rich_error(`${arg} 必须是整数，收到 ${typeof value}。示例：${JSON.stringify({ [arg]: example })}。`, {
      echo: { [arg]: value },
      retry_with: { [arg]: example },
    }),
  ];
}

/** 按参数声明挑一个示例值：example > default > enum[0] > 类型占位。 */
function type_example(a: Record<string, unknown>): unknown {
  for (const key of ["example", "default"] as const) {
    const v = a[key];
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
  }
  const enumv = a.enum;
  if (Array.isArray(enumv) && enumv.length > 0) {
    const v = enumv[0];
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
  }
  const t = TYPE_MAP[String(a.type ?? "string").toLowerCase()] ?? "string";
  return { integer: 1, number: 1.0, boolean: true, string: "…", object: {}, array: [] }[t]!;
}

/** bmahs_call 的 args 参数：必须是对象；单元素 `[obj]` 取元素。op 用于报错时给真实参数示例。 */
export function coerce_args_object(
  value: unknown,
  op: Op | null,
): [Record<string, unknown> | null, CoercedNote[], SanitizeError | null] {
  if (value === null || value === undefined) return [null, [], null];
  if (typeof value === "object" && !Array.isArray(value)) {
    return [value as Record<string, unknown>, [], null];
  }
  if (Array.isArray(value) && value.length === 1 && typeof value[0] === "object" && value[0] !== null && !Array.isArray(value[0])) {
    return [
      value[0] as Record<string, unknown>,
      [{ arg: "args", from: value, to: value[0], note: "args 传了单元素数组，已取其中的对象；下次直接传对象" }],
      null,
    ];
  }
  const example: Record<string, unknown> = {};
  if (op) {
    for (const a of normalize_args(op).slice(0, 3)) example[String(a.name)] = type_example(a);
  }
  return [
    null,
    [],
    rich_error(
      `args 必须是对象（键为该动作的参数名），收到 ${Array.isArray(value) ? "array" : typeof value}。` +
        `示例：${JSON.stringify({ args: example })}。`,
      { echo: { args: value }, retry_with: Object.keys(example).length > 0 ? { args: example } : undefined },
    ),
  ];
}

/** 按动作 args 声明矫正参数值类型 / enum；返回 `[新参数, notes]`。
 *
 * 只做无歧义矫正（字符串数字→数值、布尔字面量→布尔、string 槽收数字→字符串、
 * enum 忽略大小写唯一匹配），矫正不了原样保留交设备判断；未声明的键原样保留。
 */
export function coerce_op_arguments(
  op: Op,
  args: Record<string, unknown>,
): [Record<string, unknown>, CoercedNote[]] {
  const specs = new Map<string, Record<string, unknown>>();
  for (const a of normalize_args(op)) specs.set(String(a.name), a);
  const out: Record<string, unknown> = { ...args };
  const notes: CoercedNote[] = [];
  for (const key of Object.keys(out)) {
    const spec = specs.get(key);
    if (!spec) continue;
    const jtype = TYPE_MAP[String(spec.type ?? "string").toLowerCase()] ?? "string";
    const val = out[key];
    let next = val;
    let changed = false;
    if ((jtype === "integer" || jtype === "number") && typeof val === "string") {
      const n = jtype === "integer" ? Number.parseInt(val.trim(), 10) : Number.parseFloat(val.trim());
      if (Number.isFinite(n)) {
        next = n;
        changed = true;
      }
    } else if (jtype === "boolean" && typeof val === "string") {
      const low = val.trim().toLowerCase();
      if (TRUE_STRINGS.has(low)) {
        next = true;
        changed = true;
      } else if (FALSE_STRINGS.has(low)) {
        next = false;
        changed = true;
      }
    } else if (jtype === "string" && (typeof val === "number" || typeof val === "boolean")) {
      next = String(val);
      changed = true;
    }
    const enumv = spec.enum;
    if (Array.isArray(enumv) && enumv.length > 0 && !enumv.includes(next)) {
      const matches = enumv.filter(
        (e) => String(e).trim().toLowerCase() === String(next).trim().toLowerCase(),
      );
      if (matches.length === 1) {
        next = matches[0];
        changed = true;
      }
    }
    if (changed && next !== val) {
      out[key] = next;
      notes.push({
        arg: key,
        from: val,
        to: next,
        note: `参数 ${key} 已按声明类型/可选值从 ${JSON.stringify(val ?? null)} 矫正为 ${JSON.stringify(next ?? null)}`,
      });
    }
  }
  return [out, notes];
}
