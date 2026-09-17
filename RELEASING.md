# 发布指南（npm）

`bmahs-mcp-gateway-node` 发布到 npm 的完整流程。

## 0. 前置条件

- [npmjs.com](https://www.npmjs.com) 账号。
- **Access Token**：[npmjs.com/settings/tokens](https://www.npmjs.com/settings/XJPeng12/tokens) → Generate New Token：
  - Granular Token（细粒度）必须**勾选 "Bypass two-factor authentication (2FA)"**——账号开了发布 2FA，不勾选发布必报 `403 Two-factor authentication ... required`（经典 **Automation** 类型 token 也可以，天然免 OTP）；
  - **Packages and scopes**：权限 **Read and write**、范围 **All packages**（首次发新包必须，包尚不存在无法按包授权）；
  - **Allowed IP ranges 留空**（家庭/公司出口 IP 是动态的，填了会把自己挡在外面）。
- **token 安全**：只在发布命令里临时使用，不落盘、不入 git；用完或误泄露到同一页面删除重建即可，不影响已发布版本。

## 1. 发版步骤

### 1.1 改版本号（两处，保持一致）

- `package.json` 的 `"version"`（或者用 `npm version patch|minor` 自动改 + 打 git tag）
- `src/version.ts` 的 `VERSION`（`--version` 输出和 MCP serverInfo 用它）

### 1.2 提交并打 tag

```bash
git add -A && git commit -m "release: v0.x.y"
git tag v0.x.y && git push && git push --tags
```

### 1.3 发布

```bash
npm run build   # publish 时 prepublishOnly 也会自动跑，手动跑一遍更稳
npm publish --registry https://registry.npmjs.org/ --access public \
  --//registry.npmjs.org/:_authToken=<你的npm_开头的token>
```

> ⚠️ 两个必踩的坑：
> 1. **本机 npm 默认源是 npmmirror（淘宝镜像，只读）**，发布必须显式 `--registry https://registry.npmjs.org/`，且 auth token 旗标要带完整 key `--//registry.npmjs.org/:_authToken=`；
> 2. 发布命令必须**在包目录里执行**（读得到 `package.json`），跨目录操作时留意 shell 的工作目录残留。

### 1.4 验证

```bash
# registry 元数据
npm view bmahs-mcp-gateway-node version --registry https://registry.npmjs.org/

# 干净目录安装 + 冒烟
rm -rf /tmp/npm-check && mkdir -p /tmp/npm-check && cd /tmp/npm-check
npm init -y >/dev/null && npm install bmahs-mcp-gateway-node --registry https://registry.npmjs.org/
node node_modules/bmahs-mcp-gateway-node/dist/bin.js --version
node node_modules/bmahs-mcp-gateway-node/dist/bin.js discover --seconds 2
```

页面检查：https://www.npmjs.com/package/bmahs-mcp-gateway-node ——README 渲染、版本、weekly downloads 面板。

全局安装用户的命令名是 **`bmahs-mcp-node`**（刻意与 pip 版的 `bmahs-mcp` 错开，可共存）。

## 2. 本次发布踩过的坑（备忘）

| 坑 | 处理 |
| --- | --- |
| `403 Two-factor authentication or granular access token with bypass 2fa enabled is required` | 生成 token 时勾 **Bypass 2FA**（或用经典 Automation token） |
| 默认源是 npmmirror，publish 无反应/失败 | 始终显式 `--registry https://registry.npmjs.org/` |
| `Could not read package.json` | 工作目录不对（shell cd 残留），回包目录再发 |
| Windows 未绑定 UDP socket 设组播参数报 `EBADF` | 代码已处理（发送套接字先 bind 再配置），勿改回 |

## 3. 发新版速查（复制即用）

```bash
# ① 改 package.json 与 src/version.ts 的版本号
# ② 提交 + tag + push
git add -A && git commit -m "release: vX.Y.Z" && git tag vX.Y.Z && git push && git push --tags
# ③ 发布
npm run build
npm publish --registry https://registry.npmjs.org/ --access public \
  --//registry.npmjs.org/:_authToken=<新token>
# ④ 验证
npm view bmahs-mcp-gateway-node version --registry https://registry.npmjs.org/
```
