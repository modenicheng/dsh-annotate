# AGENTS.md — 仓库代理规则

本文件约束所有在此仓库工作的 AI 代理（任何 harness、任何会话）。这些是规则，不是建议。人类维护者可以做更多；代理不可以。

## 概述

dsh-annotate（产品名 dsh-marker）把日常浏览器里的页面标注变成 DeepSeek Harness（DSH）会话的一等上下文：用户在 Firefox / Zen / Chromium 里圈选文本、元素或区域，标注连同截图裁片、DOM 选择器与页面上下文进入运行中的 DSH 会话；模型也能用 `annotate_pick` 反过来请用户指认页面元素。

技术形态刻意保持"无聊"：纯 ESM JavaScript、无构建步骤、无 TypeScript；唯一运行时依赖是宿主插件的 `ws`；pnpm workspace 三包结构。本地 git hooks（协议同步、语法、Biome）与 CI（全量 `pnpm run check`，含 `node --test`）把关每次提交与推送。

## 开发规则与惯例

### 分支与合并（main 受保护）

- `main` 已启用分支保护：**不要直接向 `main` 推送**，也不要 force-push 或删除远端 `main`。
- 一切改动从 `main` 切出特性分支，经 PR 合并；CI 全绿后才可合入。
- 本地提交同样必须过 hooks（见下）；PR 描述写清动机与验证方式。

### Git hooks 是硬约束

- **绝不绕过 git hook**：不用 `git commit --no-verify` / `-n`、`--no-post-rewrite`，不禁用 `core.hooksPath`，不用 `HUSKY=0` 之类的逃生口。hook 打印的"可用 … 绕过一次"提示是给人类维护者的，不是给代理的。
- hook 变红 = 修改动，或修环境让 hook 能真正跑起来（例如申请 hook 子进程需要的更宽沙箱），绝不是跳过门槛。hook 因环境原因（沙箱 EPERM、缺工具链）无法运行时，停下来如实说明，不要绕过它提交。

### 发布与打包只走 CI

- **除非用户明确要求，不创建、不推送任何 tag。** tag 是发布触发器，不是提交或推送 `main` 的副作用；"提交 / 推送 / 准备发布"都不是打 tag 的授权。本仓库唯一的 tag 入口是 release-please。
- **代理永不 publish**：不 `npm publish`、不上传 Chrome Web Store / AMO / Edge，不 `gh release upload`，不把本地 zip 当发布产物。发布 = tag + `.github/workflows/release.yml` 从 tag 构建并发布的内容。
- **本地构建不是交付物**：`node scripts/build-extension.mjs` 及其在 `dist/` 下的一切只服务测试、检查与本地 QA，不得上传商店、附到 release、发给用户或与已发布校验和比对。
- 商店字节必须来自 tag 触发的 CI 构建，以 `checksums.txt` 校验；即便手动上传，也下载 CI 产物（或其产生的 draft GitHub Release）再传。CI 产物缺失或不对就修 CI——绝不本地重建上传"省时间"。
- 不要为拿一个本地测试 zip 而打 tag；本地构建做 QA 就说清是 QA 构建。

### Git 卫生与并行会话

- 任何 git 操作前先 `git status` 并读懂它。工作树里有不属于你的未提交改动（并行会话或用户正在编辑）时，永远不要 stash-drop、reset、checkout、clean 掉它们。
- 原子提交：一个提交一个逻辑改动（一个 feature / fix / 成组的文档条目）。按文件或 hunk 分批 stage，不要把无关工作打包进一个提交，也不要在载有他人半成品的工作树上 `git add -A`。
- 永不直接编辑 `.git/` 下的任何文件；只有 git 命令碰它。破坏性命令（`reset --hard`、`checkout -- <path>`、`clean -fd`、`stash drop`）执行前必须确认无未提交损失，或先做好备份（分支/stash），在同一条命令序列里完成。
- 多个代理会话共享这个工作树：提交前用 `git diff --cached` 核对暂存区确实只含你的改动。

### 代码规范

- 纯 ESM JavaScript，无构建步骤、无 TypeScript、无新框架。加任何依赖（运行时或开发）先问用户；现状：extension 零依赖，plugin 仅 `ws`。
- **协议单一事实源**：改 `packages/protocol/src/index.js`，然后 `pnpm run sync-protocol` 重新生成两份副本并随源一起提交。`packages/plugin/src/protocol.js` 与 `packages/extension/src/shared/protocol*.js` 是生成物，不要手改（`check-sync` 会拦）。wire 格式变更需同步升 `PROTOCOL_VERSION` 并更新协议测试。
- 格式化交给 Biome（devDependency）：提交前跑 `pnpm run check`（fmt:check + lint + 协议同步 + 语法 + 图标 + 全量测试）。
- 提交信息走 Conventional Commits，`commit-msg` hook 强制；类型与格式细则见 [CONTRIBUTING.md](CONTRIBUTING.md)。
- 行为改动配测试（`node --test "packages/*/test/*.test.js"`，注意引号让 Node 自己展开 glob）。注释解释 why 而非 what；不留调试输出、临时脚本或 `.tmp-*` 残留。

## 大致结构

- `packages/protocol/` — wire 格式与记录校验的单一事实源，零依赖。
- `packages/plugin/` — DSH 宿主 bundle：WebSocket 桥、JSONL 事件存储、`annotate_*` 工具、发现/locator、会话投递。
- `packages/extension/` — 浏览器扩展（MV3，Firefox/Zen 与 Chromium 双目标）：`src/background/`（socket、发现、路由、离线 outbox、截图）、`src/content/`（手势、锚点抽取与重锚、HUD UI）、`src/popup/`（连接设置与发现面板）、`src/shared/`（消息契约、平台 shim、生成协议副本）。
- `scripts/` — 同步 / 校验 / 构建 / 冒烟脚本（`sync-protocol`、`check-*`、`build-extension`、`build-icons`、`smoke-*`）。
- `docs/` — 设计与运维文档；`.github/` — CI 与发布流水线。

## 手册指引

改动前先读对应文档；文档与代码冲突时以代码为准，并顺手修正文档。

- **上手与架构**：[README.md](README.md)（§Development、§Architecture、§Security model）与 [CONTRIBUTING.md](CONTRIBUTING.md)（首次 checkout、hooks 安装、生成文件规则、PR 要求）。
- **设计取舍**：[docs/DECISIONS.md](docs/DECISIONS.md)；**路线图与验收标准**：[docs/PLAN.md](docs/PLAN.md)。
- **发布与分发**（release-please 唯一入口、商店流程）：[docs/DISTRIBUTION.md](docs/DISTRIBUTION.md)、[docs/STORE_LISTING.md](docs/STORE_LISTING.md)。
- **发现机制**（Desktop 移动端口、endpoint 记录、loopback locator）：[docs/DISCOVERY.md](docs/DISCOVERY.md)。
- **部署**（TLS、反向代理、非默认端口）：[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)。
- **交互与隐私**：[docs/INTERACTION.md](docs/INTERACTION.md)、[docs/privacy.md](docs/privacy.md)、[docs/privacy-edge.md](docs/privacy-edge.md)。
- 本地审计记录（不进 git，位于 `.acl-recovery/`）：`repo-audit-*.md`。
