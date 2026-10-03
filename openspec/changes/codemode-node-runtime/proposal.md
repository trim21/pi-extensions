# Proposal

## Why

脚本现在跑在 QuickJS wasm VM 里：能力面是我们一件件加进去的（先是 `call`，再是 `fs.read` / `fs.write`），每加一项都要过 JSON 桥、配一套包装与记账，而且 VM 里没有真正的 Node——没有 `node:fs` 这类内置模块、没有真实的栈与错误对象、受 wasm 堆限制、JS 语义与 V8 有差异。换成「bwrap 里起一个真 Node 子进程 + 用独立 fd 转发工具调用」之后，脚本就是普通 Node 程序：文件操作用 `node:fs` 就够，我们不再需要自己造一套文件 API；能力边界改由 bwrap 承担，而 bwrap 这一层本仓库已经为 Bash 工具做好了。

## What Changes

- **运行时换成 Node 子进程**：每次 `codemode` 调用起一个 `bwrap … node <脚本>`，跑完即弃（本机实测冷启动中位数 22 ms），脚本在真 V8 里执行。
- **沙箱复用 Bash 的 bwrap 配置**：同一份 `bwrap.json`（fs 模式、可写路径、只读保护、network 模式），所以脚本能读写什么、能不能出网与沙箱里的 Bash 完全一致，没有第二套策略。
- **没有 bwrap 时不静默降级**：先按请求策略取用户授权，再以普通子进程执行；headless 会话、Windows 或 `/bwrap-deny-request` 生效时直接拒绝并在结果里说明原因。
- **协议换通道**：宿主与子进程共用一条全双工专用 fd（spawn 建的 socketpair，magic + 长度分帧）；stdin/stdout/stderr 全归脚本，任何库直接打印都不会污染协议。
- **脚本接口**：`call` / `CallFailedError` / `ALL_TOOLS` / `text` / `image` / `exit` / `console` / `store` 保持不变；脚本可以直接使用 Node 内置模块（`node:fs`、`node:path` ……）。**BREAKING**：删掉 `fs.read` / `fs.write` 这两个原语、以及配套的脚本侧已读记账与「与文件工具共用记账」的互锁——文件读写改用 `node:fs`。
- **执行有墙钟上限**：缺省 120 秒，脚本可用首行 `// @options: {"timeout_ms": …}` 放宽；到点杀掉整个进程组并以超时失败结束（消息里给出当前上限与放宽方式）。它取代原来那套基于 `process.getActiveResourcesInfo()` 的卡死检测。
- **可调用集合排除会等人的工具**：除既有的文件读写工具与 `spawn-agent` 外，`Bash` / `web_fetch` / `lsp-rename` / `AskUserQuestion` / `talk-ask` 也不再对脚本可见——执行有上限，脚本里不该出现把时间交给人或外部等待的调用。脚本碰文件用 `node:fs`，要跑命令或抓网页则作为独立工具调用。
- **脚本以 Node 程序执行**：入口是 `bootstrap.ts` 转译出的 `bootstrap.js`（随仓库提交，pre-commit 重新生成），脚本本体经协议帧传入，宿主不再需要临时文件；删掉 worker 线程、QuickJS wasm、`worker.js` 构建产物、QuickJS prelude 与 `fs.ts` 原语。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `codemode`: 「脚本执行隔离」改为「bwrap 里的 Node 子进程」（含无 bwrap 时的授权路径）；「脚本接口」去掉 `fs.read` / `fs.write`、明确脚本可用的 Node 运行时，并去掉「永不 settle 的 promise 立刻失败」这条判据；移除「脚本文件原语」 requirement。

## Impact

- 代码：`src/codemode/`（新增 `bootstrap.ts` + 协议实现 + 子进程客户端，删除 `worker.ts` / `worker.js` / `wasm.ts` / `fs.ts` / `prelude.ts`，重写 `sandbox.ts` / `protocol.ts` / `tool.ts` / `declarations.ts`）、`src/bwrap/exec.ts`（命令组装从「bash 字符串」泛化为 argv，供 node 复用）、`src/bwrap/sandbox.ts`（新增 `spawnSandboxed` 供子进程型工具复用同一套组装与网络栈生命周期）、`src/bwrap/runtime.ts`（新增 `sandboxView`）、`src/index.ts`（注册改为同步，改注入 sandbox runtime 与请求策略）、`src/claude-code/files.ts` 与 `src/opencode/files.ts`（撤掉为共享记账暴露的 `readonly reads`）、`package.json`（删 `build:codemode-worker`，加 `build:codemode-bootstrap`）。
- 测试：`test/codemode.test.ts`（沙箱语义重写）、`test/codemode-tool.test.ts`（描述与调用语义）、删除 `test/codemode-fs.test.ts` 与 worker 产物断言；新增 `test/codemode-protocol.test.ts`（分帧与校验）、`test/codemode-sandbox-mode.test.ts`（无 bwrap 时的授权路径）、bwrap argv 组装用例。
- 文档：README 与 AGENTS.md 的 codemode 段落。
- 兼容性：脚本侧 API 破坏性变化（`fs.read` / `fs.write` 消失），但脚本不落盘、不进仓库，只有会话内的临时脚本受影响。
- 已知行为变化：「脚本停在一个永远不会 settle 的 promise 上立刻失败」不再是立刻判定（真 Node 有 timer，宿主无法从外部判断），改为到执行上限时被杀掉；会话仍然不会被挂住。
