# Some of my personal pi extensions

你可以参考本仓库的实现，但不要直接使用：这是我个人自用的扩展集，我会随意做 breaking change，不承诺向后兼容。

[pi](https://github.com/earendil-works/pi) coding-agent 自定义扩展集合。

## 扩展概览

| 扩展                                      | 描述                                                                                          |
| ----------------------------------------- | --------------------------------------------------------------------------------------------- |
| [opencode 工具集](#opencode-工具集)       | 小写 `read`/`edit`/`write`/`grep`/`glob`/`bash`/`todowrite`/`question`                        |
| [Claude Code 工具集](#claude-code-工具集) | 大写 `Read`/`Edit`/`Write`/`Grep`/`Glob`/`Bash`/`TodoWrite`/`AskUserQuestion`                 |
| [bwrap](#bwrap)                           | 基于 bubblewrap 的 OS 级沙箱（内置两套工具集）：文件系统隔离 + 多档网络策略                   |
| [写保护（内置）](#写保护内置)             | 写工具内置：限制文件写入在 workspace 内，外部写入需审批                                       |
| [LSP（内置）](#lsp内置)                   | 文件工具内置 LSP 诊断 + `lsp-rename`/`lsp-inspect`/`lsp-find-definition`/`lsp-find-reference` |
| [aft](#aft)                               | AFT 只读代码感知：`aft_outline`/`aft_zoom`/`aft_callgraph`/`aft_search`                       |
| [gh-readonly](#gh-readonly)               | GitHub 只读工具集（issue / PR / CI / release），基于 `gh` CLI                                 |
| [spawn-agent](#spawn-agent)               | 把任务委派给独立上下文窗口的子代理                                                            |
| [system-prompt](#system-prompt)           | 完全替换 pi 默认 system prompt                                                                |
| [vision-agent](#vision-agent)             | 视觉代理：主模型不支持视觉时提供 `describe_image`，调用视觉模型识别图片                       |
| [session-name](#session-name)             | 首个 user prompt 自动生成会话名，失败仅告警不命名                                             |
| [talk](#talk)                             | session 间消息传递，SQLite 邮箱 + 双向 ask 时间戳仲裁                                         |
| [web](#web)                               | `web_search`（Search1API 搜索）与 `web_fetch`（正文提取 / 原样落盘）                          |
| [openai-cost](#openai-cost)               | OpenAI Chat Completions，费用取自响应 `usage.cost`                                            |

> **两套工具风格，按预期只启用其中一套**：本包同时提供 opencode 风格
> （小写 `read`/`edit`/`write`/`grep`/`glob`/`bash`/`todowrite`/`question`）与 Claude Code
> 风格（大写 `Read`/`Edit`/`Write`/`Grep`/`Glob`/`Bash`/`TodoWrite`/
> `AskUserQuestion`）两套工具集，二者共享 bwrap 沙箱、写保护与 LSP 实现。两套同时
> 启用会带来预期外的冗余：同名命令重复注册（如 `/bwrap` 出现 `/bwrap:1`
> 后缀）、系统提示重复注入。请只启用其中一套：在 `~/.pi/agent/settings.json`
> 的 `defaultTools` 中只列出一套，或启动时用 `--exclude-tools` 排除另一套。

---

## bwrap

基于 [bubblewrap](https://github.com/containers/bubblewrap) 的 OS 级沙箱，为所有 bash 命令提供文件系统和网络隔离。

**前置条件：** 安装 bubblewrap（`apt install bubblewrap` / `pacman -S bubblewrap` / `dnf install bubblewrap`）。`network: limited` 模式额外需要 [mihomo](https://github.com/MetaCubeX/mihomo) 与 [slirp4netns](https://github.com/rootless-containers/slirp4netns)。Windows 没有 bubblewrap：`fs` 与 `network` 均 `allow-all` 时直接执行，其余组合下每条命令都走审批。

### 模式（两轴正交）

fs（文件系统）与 network（网络）各自独立取值，可任意组合：

| 轴        | 取值              | 含义                                                                    |
| --------- | ----------------- | ----------------------------------------------------------------------- |
| `fs`      | `readonly`        | 文件系统只读（`fs.extraWritablePaths` 仍是显式开口）                    |
| `fs`      | `workspace-write` | workspace + `/tmp` 可写，其余只读（`.pi` / `.agent` / `.git` 始终只读） |
| `fs`      | `allow-all`       | 完全可写（沙箱内整根可写，不做 `.pi` / `.agent` / `.git` 保护绑定）     |
| `network` | `block`           | 断网                                                                    |
| `network` | `limited`         | 仅白名单可达：deny-by-default 过滤，`network.allowlist` 之外全部拒绝    |
| `network` | `allow-all`       | 网络不受限                                                              |

默认 `fs: workspace-write` + `network: block`。两者都 `allow-all` 时完全不经 bwrap、直接执行；其余组合都在 bwrap 里执行：`block` 用 `--unshare-net` 断网，`limited` 叠一层 mihomo TUN（fakeip DNS）+ slirp4netns egress NAT，只有 allowlist 里的域名 / IP / CIDR 可达，未命中流量在连接层被拒（allowlist 为空 = 全部拒绝）。进程模型、生命周期与设计约束见 `src/bwrap/README.md`。

### 提权机制

bash 工具（opencode 风格 `bash`、Claude Code 风格 `Bash`）注册了 `dangerouslyDisableSandbox` 参数。模型需要全权限时置为 true 并说明原因（如需要网络、写入 workspace 外部路径）。

建议模型不确定时先尝试沙箱模式，若因沙箱限制失败，再以完整权限重试。

审批对话框的选项：**Allow once** 放行本次；**Run this in sandbox** 拒绝提权、命令降级为沙箱内执行（不持久化）；**Deny** / **Deny with reason** 拒绝；**Edit approval rules** 进入子菜单，按 pattern 勾选持久化 allow/deny 规则。

另一条提权路径是编辑类工具（`Edit` / `Write` / `lsp-rename` / `web_fetch`）写工作区外路径，同样经审批框放行。

对话中执行 `/bwrap-deny-request` 后，上述两类提权请求都不再弹审批框，直接按用户无理由拒绝处理（bash 报 `User denied unsandboxed execution.`，编辑类工具报 `user deny <tool>: blocked`）；`/bwrap-allow-request` 恢复审批。该开关只影响提权路径，沙箱内可执行的命令与工作区内写入不受影响，新会话开始时复位。

### 保护目录

`.pi`、`.agent` 即使在 `fs: workspace-write` 下也始终只读；`.git` 同样只读：工作区根是 git 仓库时保护根 `.git`，根不是 git 仓库时才递归扫描嵌套仓库（monorepo 子仓库，跳过 `node_modules`、`.venv` 等包目录）。`fs: allow-all` 不做这些保护绑定。

可写与保护路径均使用 bwrap 的 `--*-bind-try` 变体：路径不存在时自动忽略该项，而不是让整条命令失败。

### 运行时命令

- `/bwrap` — 显示当前两轴模式和路径配置
- `/bwrap-fs-readonly` / `/bwrap-fs-workspace-write` / `/bwrap-fs-allow-all` — 切换 fs 模式
- `/bwrap-network-block` / `/bwrap-network-limited` / `/bwrap-network-allow-all` — 切换 network 模式
- `/bwrap-reload` — 重载 bwrap 配置并重启网络栈
- `/bwrap-deny-request` — 拒绝模型的非沙盒请求，不再弹审批框
- `/bwrap-allow-request` — 恢复非沙盒请求的审批

### 配置

配置文件（项目优先于全局）：

- `~/.pi/agent/sandbox.json`（全局）
- `.pi/sandbox.json`（项目）

```jsonc
{
  // 文件系统策略："readonly" | "workspace-write" | "allow-all"
  "fs": {
    "mode": "workspace-write",
    // 可写路径列表，~ 展开为 $HOME，覆盖默认值
    "writablePaths": [".", "/tmp", "~/my-projects"],
    // 额外可写路径，与默认值合并（ro-bind）
    "extraWritablePaths": ["~/.config"],
    // 沙箱内隐藏的路径：以 / 结尾的视为目录（挂空 tmpfs），否则按文件处理（--ro-bind-try /dev/null）
    "denyPaths": [],
  },
  // 网络策略："block" | "limited" | "allow-all"
  "network": {
    "mode": "block",
    // limited 模式允许直连的域名 / IP / CIDR，可带 :port；空 = 全部拒绝
    "allowlist": ["github.com", "*.githubassets.com"],
    // mihomo / slirp4netns 可执行文件路径（可选，缺省走 PATH）
    "mihomoPath": "/usr/local/bin/mihomo",
    "slirp4netnsPath": "/usr/bin/slirp4netns",
  },
  // 自定义 bwrap 路径（可选）
  "bwrapPath": "/usr/local/bin/bwrap",
  // 额外 bwrap 参数
  "extraArgs": ["--die-with-parent"],
  // 全权限执行的自动审批规则：命中规则的命令不弹确认框
  // allow 直接放行，deny 直接拒绝；命令用 tree-sitter 解析，
  // 按 BashArity 生成模式（git checkout main → "git checkout *"）
  "approvalRules": [
    { "action": "allow", "pattern": "git status *" },
    { "action": "deny", "pattern": "git push *" },
  ],
}
```

`dangerouslyDisableSandbox: true` 的审批流程：先按 `approvalRules` 匹配（含嵌套 `$(...)` 内的命令，规则后写优先），命中 allow/deny 直接放行/拒绝，未命中才弹确认框。含文件输出重定向（`>` / `>>` / `&>` 等）的命令即使命令规则全匹配也不会自动放行，避免 `echo *` 把 `echo '' > file` 带过；管道（`echo | tail`）和 fd 复制（`2>&1`）不受影响。

### 使用

bwrap 已集成进 bash 工具实现（opencode 风格 `bash` 位于 `src/opencode/bash.ts`，Claude Code 风格 `Bash` 位于 `src/claude-code/shell.ts`），随对应扩展一起加载，无需单独安装。bash 工具内置默认超时 120 秒，且只支持同步执行（不支持后台 / detach 运行）。

---

## 写保护（内置）

写保护直接内置在各写工具（opencode 风格 `write`/`edit`、Claude Code 风格 `Write`/`Edit`）内部，通过 `src/lib/write-guard.ts` 的 `guardWriteAccess` 实现。读取工具（`read`、`ls`、`find`、`grep`）不受限制。

- workspace 内或 `/tmp` 下的路径自动放行
- 外部路径需通过确认对话框由用户审批（**Approve once** / **Block** / **Block with reason**），对话框内以 ```diff 代码块展示将要发生的变更预览（与 opencode-edit 共享匹配引擎，能定位时显示带行号的真实 patch，否则退化为参数 diff）
- headless（无 UI）会话直接拒绝外部写入；Windows 上不提供审批路径，工作区外写入一律拒绝
- `/bwrap-deny-request` 生效期间外部写入按无理由拒绝处理（`user deny <tool>: blocked`）
- 无需配置，随各写工具自动生效

---

## LSP（内置）

文件工具（`read`/`edit`/`write` 与 `Read`/`Edit`/`Write`）内置 LSP 诊断（写文件后等待并报告 ERROR 级诊断），并注册 `lsp-rename` / `lsp-inspect` / `lsp-find-definition` / `lsp-find-reference` 四个工具（两套工具集共用同一实现；`lsp-rename` 只面向 `kind: "language"` 的服务器，`linter` 类只参与诊断）。LSP protocol 是统一的，因此服务器不需要为每个语言写 adapter：用一份 JSON 配置声明如何启动即可。

配置文件（项目优先于全局）：顶层字段（`enabled`/`disabled`、超时等）本地覆盖全局；`servers` 按服务器 id 合并——同名 id 本地整体覆盖、新增 id，全局其余服务器保留。

- `~/.pi/agent/lsp.json`（全局）
- `.pi/lsp.json`（项目）

```jsonc
{
  "version": 1,
  "servers": {
    "gopls": {
      "include": ["**/*.go"],
      // 服务器类型："language"（真语言服务器，缺省）或 "linter"（只实现 LSP 协议的 lint）
      "kind": "language",
      "rootMarkers": ["go.mod"],
      // 或者用固定 workingDir（与 rootMarkers 互斥，同时配置报错）
      "bin": "gopls",
      "args": [],
      "cwd": "{root}", // 支持 {root} / {cwd} 模板
      "env": { "VIRTUAL_ENV": "{root}/.venv", "GITHUB_TOKEN": { "sh": ["gh", "auth", "token"] } }, // 追加到子进程环境变量；string 值支持 {root} / {cwd} 模板与 ${VAR} 引用，{sh} 启动时执行命令取 stdout（失败则服务器启动失败）
      "languageIdByExtension": { ".go": "go" },
      "startupTimeoutMs": 45000,
      "diagnosticsWaitMs": 1500,
      "initializationOptions": { "pythonPath": "${VIRTUAL_ENV:-/opt/venv}/bin/python" }, // → initialize 请求；字符串值支持 ${VAR} / ${VAR:-default} 插值
      "settings": {}, // → didChangeConfiguration / workspace/configuration 请求
    },
  },
  "maxOpenDocuments": 32, // 驻留文档上限（LRU 容量），缺省 32
  "watch": {
    "enabled": true, // 工作区文件监听，缺省 true
    "debounceMs": "300ms", // 事件去抖，缺省 300ms；也支持 "5s" / "1m"
    "maxBatch": 500, // 单批事件上限，缺省 500，超出截断并提示一次
    "ignore": [], // 追加忽略 glob（相对工作区根）
  },
}
```

字段说明：

- `include`：文件 glob，相对项目根或调用 cwd，任一命中即启用；支持 `!` 否定排除，如 `["**/*.go", "!**/*_test.go"]`
- `rootMarkers`：项目根标记（精确文件名，目录名亦可）：从调用 cwd 沿文件路径向下逐级查找，第一个含任一标记的目录即 root（取最外层命中；cwd 自身命中即 cwd），未命中回退 cwd；与 `workingDir` 互斥
- `workingDir`：服务器工作目录（即 LSP root）：绝对路径或相对调用 cwd 的路径，缺省即 cwd；文件必须位于该目录内才会由本服务器处理，spawn 工作目录与 rootUri 均用它；与 `rootMarkers` 互斥
- `bin`：可执行文件——绝对路径、相对调用 cwd 的路径，或名字（先在项目内 `node_modules/.bin`、`.venv/bin`、`venv/bin` 找，再走 PATH）
- `languageIdByExtension`：扩展名 → LSP languageId（didOpen 用）；缺省回退内置映射表
- `startupTimeoutMs` / `diagnosticsWaitMs`：per-server 超时，覆盖全局配置与默认值
- `env`：追加到 LSP 子进程的环境变量（在 `process.env` 之上合并）。string 值支持 `{root}` / `{cwd}` 模板与 `${VAR}` 环境变量引用；`{ "sh": [...] }` 在服务器启动时执行命令（argv 直接执行、不经 shell，需要 shell 特性时自行包 `["bash", "-c", "..."]`），stdout trim 后作为值，命令失败（非零退出或输出为空）时该服务器启动失败并报错
- `initializationOptions` 与 `settings` 按 LSP 语义分离：前者进 initialize 请求，后者进 didChangeConfiguration / workspace/configuration 请求；`initializationOptions` 的字符串值（含嵌套对象/数组）在启动时做 `${VAR}` 插值，`${VAR:-default}` 在变量未定义或为空时用 default，未定义且无 default 替换为空字符串；插值时可引用 `env` 里配置的变量
- `initializationOptionsCommand`：启动时执行命令计算 `initializationOptions`（argv 直接执行、不经 shell，需要 shell 特性时自行包 `["bash", "-c", "..."]`；参数项支持 `{root}` / `{cwd}` 模板与 `${VAR}` 插值；cwd 为该服务器的项目根，环境含上面 `env` 解析出的变量）。stdout 必须是 JSON 对象，与静态 `initializationOptions` 深合并（命令输出优先，嵌套对象逐层递归）；非零退出、输出为空或不是 JSON 对象时该服务器启动失败并报错

`env` 的 `{sh}` 命令与 `initializationOptions` 插值可以组合使用，例如用 `gh auth token` 给服务器的 initialize 请求提供 session token：

```jsonc
{
  "servers": {
    "github-lsp": {
      "bin": "github-lsp",
      "args": ["--stdio"],
      "env": {
        // 启动时执行 gh auth token，stdout（trim 后）成为环境变量 GITHUB_TOKEN
        "GITHUB_TOKEN": { "sh": ["gh", "auth", "token"] },
      },
      "initializationOptions": {
        // 插值引用上面命令的输出，随 initialize 请求发给服务器
        "sessionToken": "${GITHUB_TOKEN}",
      },
    },
  },
}
```

命令失败（`gh` 未登录 / 不在 PATH）时该服务器启动失败并报错。

启动时才能算出的值（例如项目把 `typescript` alias 成 `@typescript/typescript6` 时，要去 pnpm store 里找真实的 `tsserver.js`）用 `initializationOptionsCommand`，避免把绝对路径写死在配置里：

```jsonc
{
  "servers": {
    "typescript": {
      "bin": "typescript-language-server",
      "args": ["--stdio"],
      "initializationOptions": { "tsserver": { "logVerbosity": "verbose" } },
      // 脚本 stdout 的 JSON 对象与上面的静态值深合并（命令优先）
      "initializationOptionsCommand": ["node", "{root}/.pi/lsp/ts-options.mjs"],
    },
  },
}
```

没有内置默认服务器：`servers` 的 key 就是服务器 id，全部来自你的配置，未定义 `servers` 时不启动任何语言服务器。executable 的发现逻辑（如 tsserver 路径、venv 里的 python）不内置，需要时用 `bin` / `args` / `settings` 自行表达。

启用控制只有顶层两处：`enabled`（白名单）与 `disabled`（排除），按服务器 id 生效。`enabled` 里的 id 必须是已配置服务器，否则视为配置错误；`disabled` 里未注册的 id 直接忽略。全局超时字段（`initializeTimeoutMs` 等）同样配在顶层。

顶层 `watch` 段控制工作区文件监听：事件源是 [@parcel/watcher](https://github.com/parcel-bundler/watcher)（递归监听会话 cwd），非本 agent 写入的改动——如 `git checkout`、外部格式化——也会以 `workspace/didChangeWatchedFiles` 批量通知服务器。内置忽略 `node_modules`、`.git`、`dist`、`build`、`.venv`、`venv`、`target`、`coverage`，`ignore` 可追加。`maxOpenDocuments` 是保持 open 的文档上限（LRU）：超过时最久未使用的文档会被 `didClose`，服务器回落到读磁盘。`watch.enabled: false` 可整体关闭监听，回到仅工具触发同步的现状。

运行时命令：`/lsp-start` 重新启用 LSP（下次工具调用时启动服务器）、`/lsp-stop` 停掉全部服务器并禁用 LSP、`/lsp-reload` 重读配置并重启全部服务器。配置在 session 启动时预读缓存，仅 cwd 变化或 `/lsp-reload` 时重读。

服务器记录里不认识的键会被忽略并逐个告警（`<file> (server "id"): unknown field "x" ignored`）：历史配置中残留的 `"clangd": { "enabled": false }` 已无任何效果，要禁用某个已配置的服务器请改用顶层 `disabled`。

---

## opencode 工具集

opencode 风格工具集，随 `src/opencode/index.ts` 一次加载：`read` / `edit` / `write` / `grep` / `glob` / `bash` / `todowrite` / `question`，以及共享 LSP 工具。`grep` 替换 pi 内置 `grep`，`glob` 与 pi 内置 `find` 并存。各单工具文件（`src/opencode/grep.ts` 等）也可独立加载。

### edit

`edit` 使用 [opencode](https://github.com/anomalyco/opencode) 的 schema 和模糊匹配引擎。核心 replacer 和 `replace()` 函数复制自 opencode，匹配引擎位于 `src/opencode/edit-engine.ts`，与写保护审批弹窗（`src/lib/write-guard.ts`）的 diff 预览共享。唯一的有意差异是去掉了原版的转义规范化（EscapeNormalizedReplacer）：它会把源码里合法的 `\n`、`\t` 等转义序列当成模型多转义的产物做启发式反转义，可能改坏内容。

支持的匹配策略：

- 精确匹配（SimpleReplacer）
- 行尾空白容差（LineTrimmedReplacer）
- 块首尾锚定（BlockAnchorReplacer）
- 空白规范化（WhitespaceNormalizedReplacer）
- 缩进灵活匹配（IndentationFlexibleReplacer）
- 首尾空白修剪（TrimmedBoundaryReplacer）
- 上下文感知匹配（ContextAwareReplacer）
- 多次出现替换（MultiOccurrenceReplacer）

所有匹配策略按顺序尝试，第一个匹配成功即返回。同时自动处理 BOM、CRLF/LF 行尾转换和文件写入队列。`filePath` 接受绝对路径或相对工作目录的路径。

edit 要求目标文件已被 `read` 读过且内容未变（内容指纹比对，与 Claude Code 风格 Edit 同一套语义）：没读过报 `File has not been read yet. Read it first before writing to it.`，读后文件被外部改动报 `File has been modified since read...`，两种情况都要重新 `read`。

`write` 不要求先读——没读过的文件可以直接写；但如果该文件已被读过、之后又被外部改动（或删除），`write` 会与 `edit` 一样要求重新 `read`，不让读取记录过期的内容被盲覆盖。`read`/`edit`/`write`/`lsp-rename` 都会刷新记账并随工具结果持久化，session 恢复 / fork / rewind 后依然有效；写完也会刷新，紧随其后的 `edit` 不必重新读。

### grep

opencode 风格的 `grep` 工具，替换 pi 内置 `grep`。参数与输出格式对齐 opencode 的 [`grep`](https://github.com/anomalyco/opencode) 工具：`pattern` / `path` / `include`，输出以 `Found N matches` 开头，按文件分组（`<绝对路径>:` + `  Line N: <文本>`）。隐藏文件参与搜索、`.git` 排除、结果上限 100 条（触顶时提示 `(more matches available)` 并附截断说明）。

执行层在 `src/opencode/ripgrep.ts`：`rg` 子进程流式读取 stdout，读满 100 条即终止进程，宽泛 pattern 不会把整个结果集读进内存；退出码语义与上游一致（1 = 无匹配，2 = 部分文件读失败仍返回已有结果，正则语法错误单独报错）。

与上游的三处有意差异：行文本去掉 rg JSON 带出的行尾换行（否则每条匹配后面会多一个空行）；`path` 指向文件时只搜该文件（上游按目录搜索）；`path` 不存在时报错（含同目录相近名字提示），而不是静默返回 `No files found`。

### glob

opencode 风格的 `glob` 工具（与 pi 内置 `find` 并存）。参数 `pattern` / `path`，内部是 `rg --files` 语义：尊重 `.gitignore`、不列隐藏文件、不按修改时间排序、排除 `.git`，输出绝对路径，上限 100 条（截断时附 `(Results are truncated: ...)`）。与 Claude Code 风格 `Glob` 的差异（`--no-ignore` / `--hidden` / `--sort=modified`）是各自跟随上游的结果。

`path` 不存在或指向文件时报错（含同目录相近名字提示）。

### todowrite

opencode 风格的任务列表工具，参数与语义和 opencode 的 [`todowrite`](https://github.com/anomalyco/opencode) 工具一致，用 `details.pendant.markdown` 渲染（pendant 约定）。

- **完整列表替换语义**：模型每次调用都传完整的 todo 列表，工具整体替换当前列表；没有单条增删改动作
- **参数**：`todos: Array<{ content, status, priority }>`
  - `status`：`pending` | `in_progress` | `completed` | `cancelled`
  - `priority`：`high` | `medium` | `low`
- **持久化**：列表存进工具结果 `details.todos`，跟随会话分支自动恢复
- **渲染**：每次调用用完整 markdown 列表输出对应的任务

### question

opencode 风格的提问工具，参数与语义和 opencode 的 [`question`](https://github.com/anomalyco/opencode) 工具一致。阻塞式执行：工具调用挂起，等用户作答后才把答案返回给模型。

- **参数**：`questions: Array<{ question, header, options, multiple? }>`
  - `options` 每项为 `{ label, description }`
  - `multiple` 缺省为单选，`true` 时循环用 `ui.select` 逐个勾选直到「✓ Done」
- **自定义答案**：每个问题自动追加 `Type your own answer.` 选项，选中后走 `ui.input` 自由输入
- **返回值**：每个问题一个 label 数组（`Answer = string[]`），跳过的为空数组
- **输出**：与 opencode 一致 —— `User has answered your questions: "q"="a", "q2"="Unanswered"...`

交互全部走 pi 内置的 `ctx.ui.select` / `ctx.ui.input`，不写自定义 TUI 渲染；`option.description` 不显示在对话框里，仅保留在 `details` 中。

### 使用

```bash
pi -e ./src/opencode/index.ts
```

---

## Claude Code 工具集

Claude Code 风格工具集，随 `src/claude-code/index.ts` 一次加载：`Read` / `Edit` / `Write` / `Grep` / `Glob` / `Bash` / `TodoWrite` / `AskUserQuestion`，以及共享 LSP 工具（`lsp-rename` / `lsp-inspect` / `lsp-find-definition` / `lsp-find-reference`）。各单工具文件（`src/claude-code/grep.ts` 等）也可独立加载。精确行为（输出格式、分页语义、匹配规则）见 `.agents/skills/claude-code-tools/SKILL.md`。

- **`Read` / `Edit` / `Write`**：与 opencode 风格共享 read-before-write 记账与文案（`File has not been read yet...` / `File has been modified since read...`），差异是三者都要求先 `Read`（`Edit` 用空 `old_string` 创建新文件、`Write` 创建新文件例外）。`Read` 支持 offset / limit 分页与 PDF `pages`
- **`Grep` / `Glob`**：ripgrep 实现，行为跟随 Claude Code（`Glob` 带 `--no-ignore` / `--hidden` / `--sort=modified`，与 opencode 风格 `glob` 的差异是各自跟随上游）
- **`Bash`**：与 opencode 风格 `bash` 共享 bwrap 运行时与 `dangerouslyDisableSandbox` 提权，默认超时 120 秒，只支持同步执行
- **`TodoWrite`**：任务列表工具（`merge` 语义），与 opencode 风格 `todowrite` 的完整替换语义不同，不要混用
- **`AskUserQuestion`**：阻塞式向用户提问

### 使用

```bash
pi -e ./src/claude-code/index.ts
```

---

## aft

[AFT](https://github.com/cortexkit/aft) 只读代码感知工具：`aft_outline`（文件/目录结构大纲）、`aft_zoom`（命名符号完整源码）、`aft_callgraph`（调用关系导航）、`aft_search`（语义 + 精确搜索）。全部只读，不触碰本包 read/write/edit/bash 工具及其安全机制。

- **二进制解析**：session 启动时解析 `aft` 二进制（npm 平台包 `@cortexkit/aft-<platform>`、`cargo install agent-file-tools` 或 PATH，含 GitHub release 自动下载兜底）；找不到则告警且不注册任何工具
- **`aft_search` 条件注册**：仅当用户级 `aft.jsonc` 开启 `semantic_search` 且配好外部 embedding 后端（`semantic.backend` 为 `openai_compatible` / `ollama` 且有 `base_url`）时注册；aft 默认的本地 ONNX fastembed 后端不使用，只开开关不配后端会告警说明缺什么
- **生命周期**：常驻 aft 子进程与日志（`tmp/{sessionId}/aft-plugin.log`）随 session 创建与释放

### 使用

```bash
pi -e ./src/aft/index.ts
```

---

## gh-readonly

GitHub 只读工具集，基于系统 [`gh`](https://cli.github.com/) CLI（关键词搜索与 checks 查询走 octokit REST）。`gh` 不在 PATH 时整组不注册并在 session_start 报错；Windows 禁用。

- **Issue / PR**：`read-github-issue`、`list-github-issues`、`read-github-issue-comments`、`read-github-pr`、`list-github-prs`、`read-github-pr-diff`、`read-github-pr-status`、`read-github-pr-comments`
- **CI**：`read-github-ci-logs`、`list-github-workflow-runs`、`get-github-workflow-jobs`、`wait-github-pr-checks`、`wait-github-commit-checks`、`watch-github-run`
- **仓库 / 发布**：`read-github-repo`、`list-github-releases`、`read-github-release`、`download-github-release-assets`

`list-github-issues` / `list-github-prs` 带 `keywords` 时走 GitHub search API（state 缺省只搜 open，`state: "all"` 不加 state qualifier 覆盖 open + closed），输出 TSV，默认列 `number,state,title,labels,updatedAt`，可用 `fields` 白名单指定列。`wait-github-pr-checks` / `wait-github-commit-checks` 30 秒轮询、600 秒截止：任一 fail 即返回，全部 pass / skipped 才算通过，超时返回快照不抛错。

出网代理：`~/.pi/agent/proxy.json`（`{ "proxy": "http://127.0.0.1:7890", "noProxy": "localhost" }`），缺省字段回退 `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` / `NO_PROXY` 环境变量。

### 使用

```bash
pi -e ./src/gh-readonly.ts
```

---

## spawn-agent

`spawn-agent` 工具把任务委派给子代理：子代理是独立 session、独立上下文窗口，但在同一个 pi 进程内运行。调用阻塞到子代理 turn 结束，最终输出作为工具结果返回（上限 50KB）；进度经 `onUpdate` 实时滚动（`tool:` / `text:` 行 + 思考字数状态行）。

子代理定义在 `~/.pi/agent/agents/*.md`（YAML frontmatter + system prompt 正文）：

```yaml
---
name: scout
description: Fast codebase recon
tools:
  - read
  - grep
  - find
  - ls
provider: openai # 可选，覆盖全局默认
model: claude-haiku-4-5 # 可选，覆盖全局默认
thinkingLevel: high # 可选，off/minimal/low/medium/high/xhigh
sandbox: # 可选，bash 工具的固定沙箱配置（sandbox.json 同构）
  fs:
    mode: readonly
    extraWritablePaths:
      - /tmp
---
System prompt for the agent goes here.
```

- **默认只读**：frontmatter 不声明 `tools` 时只有 `read`/`grep`/`find`/`ls`，没有 bash/write/edit
- **`sandbox`**：完整沙箱配置直接作为该子代理 bash 的沙箱（不读用户 sandbox.json），非沙盒请求直接拒绝，`/bwrap-*` 命令不注册；不声明则用子代理默认沙箱 `fs: readonly` + `network: block`（同样不继承用户 sandbox.json，需要写工作区或联网须显式声明）
- **校验跳过**：frontmatter 校验失败（缺 name/description、字段类型错）的文件直接跳过
- **全局默认**：`~/.pi/agent/spawn-agent.json`（provider / model / thinkingLevel），frontmatter 优先于它，二者都优先于 settings.json 的默认值
- **可见子代理列表**通过工具的 promptGuidelines 注入 system prompt；改 `agents/*.md` 或 `spawn-agent.json` 后 `/reload` 生效
- Windows 禁用

### 使用

```bash
pi -e ./src/spawn-agent.ts
```

---

## system-prompt

完全替换 pi 默认 system prompt 的扩展（`before_agent_start` 钩子接管，SYSTEM.md / `--system-prompt` 内容会被完全覆盖）。

- **静态主体**来自同目录 `prompt.md`（手写行为准则，衍生自 Claude Code 的 system prompt，剥离了 tool 相关说明）
- **动态部分**（工具列表、工具 guideline、AGENTS.md 上下文、skills、日期、cwd、`--append-system-prompt` 内容）用 `event.systemPromptOptions` 程序化拼装，渲染格式与 pi 默认 `buildSystemPrompt` 保持一致
- `prompt.md` 中的 `{{tools}}` `{{guidelines}}` `{{project_context}}` `{{skills}}` `{{append}}` `{{date}}` `{{cwd}}` 占位符决定每个动态块的位置；占位符被删掉时对应块追加到末尾

### 使用

```bash
pi -e ./src/system-prompt/index.ts
```

---

## vision-agent

视觉代理扩展。主模型不支持视觉（如 DeepSeek）时自动启用 `describe_image` 工具；主模型支持视觉时自动隐藏，图片由 pi 原生透传。

`describe_image` 工具只接收本地图片路径（`path`，单个或数组，一次可识别多张），图片直接以 base64 data URL 放进请求体，由视觉模型按顺序逐张描述，中间不经过任何 read 工具或 agent。内置默认 system prompt（图像识别助手），并支持 `prompt` 参数追加具体描述要求（如「图中验证码是什么」「逐字翻译图中的文字」），缺省时自动生成通用描述指令。功能与 [pi-vlm-proxy](https://github.com/lawrencewzen/pi-vlm-proxy) 一致，但配置不单独维护。

### 配置

不需要独立配置文件，直接复用 pi 已有的配置：

```jsonc
// ~/.pi/agent/settings.json —— 指定视觉模型
{
  "defaultProvider": "axonhub",
  "visionConfig": {
    "provider": "axonhub", // 可选，缺省回退到 defaultProvider
    "model": "mimo-v2.5",
  },
}
```

`provider` 的 `baseUrl` / `apiKey` 从 `~/.pi/agent/models.json`（pi 自定义 provider 配置）解析，认证、代理、网络全部复用 pi 自身配置。

**未配置 `visionConfig`（或 provider 缺失）时扩展不注册 `describe_image` 工具**，agent 看不到也调不到，避免一个必然失败的僵尸工具；配置好后 `/reload` 即可生效。

### 使用

```bash
pi -e ./src/vision-agent.ts
```

**注意：** 本扩展与 pi-vlm-proxy 都注册同名 `describe_image` 工具，启用前请先从 `~/.pi/agent/settings.json` 的 `packages` 中移除 `pi-vlm-proxy`，避免工具注册冲突。

---

## session-name

根据会话的第一个 user prompt 自动生成显示名，在 `/resume` 和 `pi -r` 里更易区分会话。

- **模型命名**：配置了 `sessionName.model` 时经 pi 的模型注册表调用命名模型（复用 `~/.pi/agent/models.json` 的 provider 配置与 AI SDK，不手写 HTTP 请求）把 prompt 概括成短名，输出截断到 `maxLength`。
- **失败即告警**：未配置 `sessionName`、模型不可解析或调用失败时都不设置名字，仅以 warning 通知，方便排查。
- **不覆盖已有名字**：`--name`、`/name` 设置过名字的会话不会被改；恢复的已命名会话同样跳过。
- **恢复无名会话**：resume/fork 恢复且无名字的会话，从历史第一条 user 消息生成名字。
- **非阻塞**：命名在后台进行，不拖慢首轮回复；中途切换会话也不会把名字写到错误的 session。

### 配置

```jsonc
// ~/.pi/agent/settings.json
{
  "sessionName": {
    "provider": "axonhub", // 可选，缺省回退 defaultProvider
    "model": "deepseek-v4-flash", // 命名模型；不配置则不做自动命名
    "maxLength": 30, // 可选，名字最大长度，默认 30
  },
}
```

### 使用

```bash
pi -e ./src/session-name.ts
```

---

## talk

session 间消息传递：不同 pi session（同一台机器）通过一个共享的 SQLite 邮箱互相发送消息、提问并等待回复。

### 架构（三层）

```
storage.ts   —— 存储层：TalkStorage 接口 + SqliteTalkStorage 实现（node:sqlite，零 npm 依赖）
core.ts      —— talk 核心：TalkCore 协调器 + mailbox / registry / group / policy / format 子模块，
               只依赖存储层，通过回调 yield 投递/通知
index.ts     —— pi adapter：把 core 接到 pi 的 sendMessage / 生命周期事件 / 工具注册
```

存储层抽象成接口是为了后续可换成 HTTP / remote 后端，talk 核心无需改动。

### 工具（LLM 可见）

| 工具               | 作用                                                                                                                                                                                                      |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `talk-list-agents` | 列出会话，返回 JSON 数组（`status` / `work_dir` / `id` / `name`，自己带 `self: true`）；只列出同组成员（未入组时只有自己），`status` 区分 live（`idle` / `working` / `waiting-talk-message`）与 `offline` |
| `talk-ask`         | 向某个 session 提问并阻塞等待回应（默认 30 分钟超时）；对方发来任何 `talk-send` 消息都会解除等待                                                                                                          |
| `talk-send`        | 发送纯文本消息到单个 session（`to` 只接受明确的 session id，不支持广播）                                                                                                                                  |

对端消息自动投递（无需主动拉取）：投递方式由 `talk.deliver` 配置，`steer` 在模型工作过程中打断/唤醒，`queue` 排队到 session 下一轮自然 turn 时注入。

**定位只认 session id**：`talk-send` / `talk-ask` 的 `to` 只接受 `talk-list-agents` 返回的 `id`（pi 的 session uuid）精确匹配，不做 name/路径/前缀匹配。

**标记废弃 session**：`/talk-dead` 给 session 打 `offline` 标志并把 `lastSeenAt` 置 0（列表显示为 offline，下次 sweep 无 mail 即回收）：无参标记当前 session，`/talk-dead <sessionId>` 标记指定 session，`/talk-dead --all` 标记所有其他可见 session（同组成员）。

### 关键设计

- **presence 不靠心跳**：presence 由 `offline` 标志 + 进程 pid 存活判定；pid 存活时还校验进程启动时间（`/proc/<pid>/stat`），排除 pid 回卷复用造成的误判。未标记 offline 且进程存活即 live，否则 offline；没有心跳，进程挂死（wedged）与健康空闲不可区分。`status` 在 live 时显示 `working` / `waiting-talk-message`（`talk-ask` 阻塞等待回应中）/ `idle`。
- **定期清理**：进程仍存活的记录永不回收；进程已死且最后活跃超过 24h 且无未投递 mail 的记录会被定期 sweep（30 分钟一次）回收；有 mail 的保留 30 天。resume 后 session 会自动重新注册，无 mail 即无损失。
- **投递成功才消费**：信件只在成功交给 `sendMessage` 后才从 inbox 删除，投递失败留在 inbox 下次重试——不会因 `sendMessage` 吞异常而静默丢信。
- **双向 ask 仲裁**：`talk-ask` 发起前先检查收件箱（有对方消息就先读/先回）；阻塞等待期间若收到对方的 ask，按两个 ask 的 `ts` 字段仲裁——先 ask 者主导继续等，后 ask 者让位并先回复对方。`ts` 是信件内固定字段，双方读到同一对值，结论天然对称；同毫秒碰撞用 `session dir + session id` 字符串比较兜底。
- **typebox runtime 验证**：所有从存储读出的值经 TypeBox schema 校验，损坏/伪造数据被拒绝，不做 `as T` 强转。
- **安全**：纯文本 ≤32KB；10s 去重 / 30s 限速 8 条 / 50 积压上限（防环）；每条投递标注来源（来自另一个 pi session，非用户）。
- **group 可见性**：可见性完全由 group 决定——组内 session 只能看到同组成员，不在任何 group 的 session 只能看到自己。用 `/talk-group-*` 命令建组/入组，见下方「group 可见性」。

### 配置

sqlite 文件路径按优先级取第一个可用值：

1. 环境变量 `PI_TALK_DB`
2. global `~/.pi/agent/settings.json` 里的 `talk.db_path`
3. 默认 `~/.pi/agent/talk.db`

`db_path` 支持 `~` 展开（`~/…` → 用户主目录），相对路径相对 `~/.pi/agent` 解析；绝对路径原样使用。

```jsonc
// ~/.pi/agent/settings.json
{
  "talk": { "db_path": "~/data/talk.db", "deliver": "queue" },
}
```

`talk.deliver` 控制对端消息的投递方式：

- `"steer"`：消息到达时打断当前工作（工具调用间隙注入），空闲 session 被唤醒；
- `"queue"`：消息排队，在 session 下一轮自然 turn（如用户发消息）时注入，不主动唤醒。

默认 `"queue"`。

### group 可见性

可见性完全由 group 决定，不再有路径/workspace 配置：

- 在某个 group 里的 session **只能看到同组成员**；不在任何 group 的 session **只能看到自己**。
- group 是带 uuid 的私有房间：任何 session 都可以凭 uuid 加入任意 group，也可以自由离开，没有 owner。
- 一个 session 只能属于一个 group：加入新 group 自动离开旧 group。
- group 成员关系存在共享的 talk DB 里，每次 list/发送实时读取，加入/离开立即对所有 session 生效（无需重启）。

通过 `/talk-group-*` 命令操作（TUI）：

```
/talk-group-join              # 无参：自动创建一个新 group（uuid 作为组名）并加入
/talk-group-join <name>       # 加入名为 name 的 group；不存在则创建（名字允许字母/数字/-/_）
/talk-group-join-last         # 加入最近创建的 group（方便新开 session 快速归队）；支持 --name <alias> 设置显示名
/talk-group-leave             # 离开当前 group（组空了自动删除）
/talk-group-list              # 列出所有 group 及其成员，最新创建的在前
/talk-group-del <name>        # 删除指定 group（成员随之变为未入组）
/talk-group-clear             # 删除所有 group
```

典型用法：在 A session 里 `/talk-group-join`（或 `/talk-group-join mytask`）建组，把组名复制到 B、C session 里 `/talk-group-join <组名>`，此后 A/B/C 互相可见且只见彼此。

TUI 命令：`/talk` 列出可见 session（与 `talk-list-agents` 同一视图）、`/talk-dead` 标记废弃 session、`/talk-group-*` 管理 group。

| 变量              | 默认                              | 含义                            |
| ----------------- | --------------------------------- | ------------------------------- |
| `PI_TALK_DB`      | settings 或 `~/.pi/agent/talk.db` | SQLite 邮箱数据库路径           |
| `PI_TALK_INBOUND` | `accept`                          | `refuse` 时丢弃所有 peer 消息   |
| `talk.deliver`    | `queue`                           | 消息投递方式：`steer` / `queue` |

### 使用

```bash
pi -e ./src/talk/index.ts
```

---

## web

### web_search

Search1API 网页搜索。key 读 `~/.pi/web-search.json` 的 `search1apiApiKey` 或 `SEARCH1API_KEY` 环境变量。参数 `query` / `numResults`（1-50，缺省 5）/ `recencyFilter` / `domainFilter` / `searchService` / `includeContent`（crawl_results，内联前几个结果的正文，可省去后续 `web_fetch`）。搜索响应不做 AI 预消化，直接返回整理后的结构化结果（title / url / snippet），零额外模型调用。

### web_fetch

抓取 URL 并提取正文为 markdown（readability 主内容算法 + turndown），或按 `output_path` 原样落盘（附件、镜像、release 资产等，上限 200MB）。

- **SSRF 防护**：DNS 预解析 + 拒绝私有/保留地址 + 每跳重定向重新校验
- **代理**：出网走 `src/lib/proxy.ts` 代理层（`~/.pi/agent/proxy.json`，回退 `HTTPS_PROXY` 等环境变量）
- **写保护**：`output_path` 落盘经 `guardWriteAccess`，工作区外写入需审批
- 重定向上限 5，超时 30 秒

### 使用

```bash
pi -e ./src/web/search.ts
pi -e ./src/web/fetch.ts
```

---

## openai-cost

OpenAI Chat Completions 兼容 provider。流式协议复用 pi 内置 `openai-completions`，费用不按模型单价估算，而是读取响应 `usage.cost`（number 或 `{ total }`，也认 Moonshot 的 `choice.usage`）写入 `message.usage.cost.total`。未上报 `usage.cost` 时保留默认 `calculateCost`。

配置文件：`~/.pi/agent/openai-cost.json`。文件缺失或校验失败时扩展不注册 provider。

```jsonc
{
  "id": "openai-cost", // 可选，默认 openai-cost
  "name": "OpenAI Cost", // 可选
  "baseUrl": "https://api.example.com/v1",
  "apiKeyEnv": "OPENAI_COST_API_KEY", // 可选；也支持 /login
  "models": [
    {
      "id": "my-model",
      "name": "My Model", // 可选，默认用 id
      "reasoning": false,
      "input": ["text"],
      "contextWindow": 128000,
      "maxTokens": 8192,
    },
  ],
}
```

省略 `models` 时启动后会请求 `GET {baseUrl}/models`，默认 `reasoning: false`、`input: ["text"]`、contextWindow 128000、maxTokens 8192。需要视觉 / reasoning / 准确窗口时把模型写进配置。API key 优先 stored credential，否则读 `apiKeyEnv`。

### 使用

openai-cost **不在 `package.json` 的默认注册列表**（`pi.extensions`）里，装包后不会自动加载，需要手动指定入口：

```bash
pi -e ./src/openai-cost/index.ts
```

---

## 安装

### 通过 npm/git 包

```jsonc
// ~/.pi/agent/settings.json
{
  "packages": ["github:trim21/pi-extensions"], // 或 npm 包 "@trim21/personal-pi-extensions"
}
```

### 命令行加载单个扩展

```bash
pi -e ./src/opencode/index.ts
```

---

## 开发

```bash
pnpm install        # 安装依赖
pnpm run check      # tsc --noEmit + prettier --check
pnpm run lint       # eslint
pnpm run test       # vitest
pnpm run format     # prettier --write
```

### 新增扩展

1. 在 `src/` 下创建扩展文件
2. 在 `package.json` 的 `pi.extensions` 数组中注册（skills 注册在 `pi.skills`）
