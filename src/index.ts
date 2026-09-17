/** BMAHS（比马斯）设备协议 ↔ MCP 网关（Node 版）公共入口。 */

export * from "./protocol.js";
export * from "./schemas.js";
export * from "./client.js";
export { Device, Discovery, local_v4_addrs } from "./discovery.js";
export { build_txt, txt_to_announce, BonjourBrowser, SERVICE_TYPE, TXTVERS } from "./bonjour.js";
export {
  Gateway,
  GatewayError,
  DeviceEnvelope,
  UnknownToolError,
  TOKEN_PLACEHOLDER,
  glob_to_regexp,
  type ToolDef,
  type ContentBlock,
} from "./gateway.js";
export { build_server, serve_stdio, serve_http, start_http_gateway, install_exit_hooks } from "./server.js";
export { VERSION } from "./version.js";
export { cli_main } from "./cli.js";
