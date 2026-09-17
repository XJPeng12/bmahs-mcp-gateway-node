/**
 * 网关日志设施：全部写 stderr（stdout 属于 MCP 协议通道，绝不能打印日志），
 * 级别由 BMAHS_LOG_LEVEL 控制（默认 INFO，非法值回退 INFO）。
 */

const LEVELS: Record<string, number> = {
  debug: 10,
  info: 20,
  warning: 30,
  warn: 30,
  error: 40,
  critical: 50,
};

function env_level(): number {
  const raw = (process.env.BMAHS_LOG_LEVEL ?? "info").toLowerCase();
  return LEVELS[raw] ?? LEVELS.info!;
}

const THRESHOLD = env_level();

export interface Logger {
  debug(msg: string, ...args: unknown[]): void;
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
}

export function get_logger(name: string): Logger {
  const emit = (lvl: string, msg: string, args: unknown[]): void => {
    if (LEVELS[lvl]! < THRESHOLD) return;
    const suffix = args.length > 0 ? " " + args.map((a) => String(a)).join(" ") : "";
    console.error(`[bmahs.${name}] ${msg}${suffix}`);
  };
  return {
    debug: (m, ...a) => emit("debug", m, a),
    info: (m, ...a) => emit("info", m, a),
    warn: (m, ...a) => emit("warning", m, a),
    error: (m, ...a) => emit("error", m, a),
  };
}

export const log_debug = (msg: string, ...args: unknown[]): void => get_logger("bonjour").debug(msg, ...args);
