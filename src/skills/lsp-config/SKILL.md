---
name: lsp-config
description: Use when 编写、检查或排查 LSP 语言服务器配置 —— 项目本地 .pi/lsp.json 或全局 ~/.pi/agent/lsp.json：配置 typescript-language-server / pyright / ruff / gopls / clangd 等服务器的 bin、include、rootMarkers、workingDir、initializationOptions、tsserver.path、watch 与诊断超时；或排查服务器起不来（binary not found / provides no tsserver.js）、typescript alias 依赖下 tsserver 找不到、诊断一直为空、monorepo 子项目 root 不对等问题。
---

# 配置 LSP 服务器（.pi/lsp.json）

本扩展的 LSP 层由配置驱动：**没有内置默认服务器**，一切服务器都在 lsp.json 里定义。配置解析在 `src/lib/lsp/lsp.ts`（`lspConfigSchema` / `watchConfigSchema` / 合并与校验）与 `src/lib/lsp/server-config.ts`（`serverConfigSchema`），schema 即权威文档；改代码先看这两处。

## 两个配置文件与合并语义

- 全局：`~/.pi/agent/lsp.json`（所有项目的基底）
- 本地：`<项目根>/.pi/lsp.json`（本地覆盖；常被 gitignore，只在本机生效）

合并是**纯函数**（`mergeConfig(global, local)`），规则：

| 段                   | 合并方式                                                                                                                                                                                                                                        |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 顶层其余字段         | 本地覆盖全局（浅合并）                                                                                                                                                                                                                          |
| `servers`            | 按服务器 id **整条覆盖**：本地写某个 id 会替换全局同 id 的整条记录，**不是字段级合并**。只改一个字段（如补 `initializationOptions`）也必须把 `include`/`rootMarkers`/`workingDir`/`bin`/`args`/`languageIdByExtension` 全部带上，否则丢全局字段 |
| `watch`              | 字段级合并：全局为基底、本地逐字段覆盖；`ignore` 两侧**并集去重**（全局在前），本地写 watch 段不会清掉全局 ignore                                                                                                                               |
| 某段全局本地都未出现 | 保持缺失（调用方用 `...(watch && { watch })` 省略键，不要输出空对象）                                                                                                                                                                           |

配置经 typebox 校验：字段类型不符、非法时长格式、per-server `workingDir` 与 `rootMarkers` 同现等在读取时**直接抛错**；schema 外的未知字段（含历史遗留字段如 `cwd`）**不拒绝**，以 warning notify 逐个上报。`version` 当前为 1。

## 顶层字段速查

```
version / servers / enabled / disabled / watch / maxOpenDocuments /
diagnosticsDebounceMs / diagnosticsDocumentWaitTimeoutMs /
diagnosticsFullWaitTimeoutMs / diagnosticsRequestTimeoutMs / initializeTimeoutMs
```

- `enabled`：只启用列出的服务器 id（缺省 = 全部启用）；`disabled`：从启用集中排除
- 时长字段：毫秒数字，或带单位的字符串（`"300ms"` / `"5s"` / `"1m"` / `"2h"`，空单位按 ms）；默认值见 `clientDefaults`（client.ts）：debounce 150ms、document 等待 5s、full 等待 10s、pull 请求 3s、initialize 45s、`maxOpenDocuments` 32
- `watch`：`enabled` / `debounceMs`（缺省 300）/ `maxBatch`（缺省 500）/ `ignore`（glob，相对**每个被监听的项目根**的 POSIX 路径）。注意 `flushMs` 只在默认值里、**不可配**
- 监听范围不是整个 cwd，而是**当前活跃服务器 client 的项目根**：root 在 cwd 内就只监听 root（被其他 root 包含的 root 不重复监听，root 是 cwd 的祖先时退化为 cwd）；没有活跃 client 就不监听。因此容器 cwd（`~/projects` 下多个仓库）里只有活跃服务器所在的项目会被 watch；`ignore` 的匹配基准也随之是各自的项目根。资源耗尽（ENOSPC）时该 root 的监听器会停止并提示一次，调大 `fs.inotify.max_user_watches` 后跑 `/lsp-reload` 重试

## servers.<id> 字段

| 字段                                     | 说明                                                                                                                                                                                                                                  |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `include`                                | 文件 glob（相对项目根或调用 cwd，任一命中即可）；缺省匹配所有文件                                                                                                                                                                     |
| `kind`                                   | `language`（缺省）或 `linter`。rename / inspect 等符号级功能**只面向 `language`**；linter 只参与诊断                                                                                                                                  |
| `rootMarkers`                            | 项目根标记文件名数组（精确匹配，目录名亦可，如 `pyproject.toml` / `go.mod` / `.git`）：从调用 cwd 沿文件路径向下查找，第一个含标记的目录即 LSP root（cwd 自身命中即 cwd），未命中回退 cwd。**与 `workingDir` 互斥**（同现报配置错误） |
| `workingDir`                             | 服务器工作目录（即 LSP root）：绝对路径或相对调用 cwd 的路径；缺省即调用 cwd。文件必须位于该目录内才会由本服务器处理；spawn 工作目录与 rootUri 均用它。**与 `rootMarkers` 互斥**                                                      |
| `bin`                                    | 可执行文件：绝对路径、相对调用 cwd 的路径、或仅名字（项目工作区优先，PATH 兜底）                                                                                                                                                      |
| `args`                                   | 启动参数数组                                                                                                                                                                                                                          |
| `env`                                    | 追加的环境变量：string 值支持 `{root}`/`{cwd}` 与 `${VAR}` 插值；`{ "sh": ["cmd","arg"] }` 启动时执行命令取 stdout（非零退出/空输出 → 启动失败并报错）                                                                                |
| `languageIdByExtension`                  | 扩展名（含点）→ languageId；缺省回退内置映射（见 `src/lib/lsp/language.ts`，覆盖主流语言）                                                                                                                                            |
| `startupTimeoutMs` / `diagnosticsWaitMs` | 覆盖该服务器的初始化握手 / 写文件后诊断等待（缺省用全局配置与 client 默认）                                                                                                                                                           |
| `initializationOptions`                  | 透传给 initialize 请求；字符串值支持 `${VAR}` / `${VAR:-default}`（读 process env，**不支持 `{root}`/`{cwd}` 模板**）                                                                                                                 |
| `settings`                               | `workspace/didChangeConfiguration` 与 `workspace/configuration` 请求的负载；缺省回退 `initializationOptions`                                                                                                                          |

## 子目录项目：rootMarkers

cwd 本身不是项目根、其下并列多个独立项目时（如 `~/projects/a`、`~/projects/b`），用 `rootMarkers` 让服务器按各自项目根启动，不必为每个项目写一条 server 配置：

```json
{
  "servers": {
    "pyright": {
      "include": ["**/*.py", "**/*.pyi"],
      "rootMarkers": ["pyproject.toml", "setup.py", "pyrightconfig.json"],
      "bin": "pyright-langserver",
      "args": ["--stdio"],
      "languageIdByExtension": { ".py": "python", ".pyi": "python" }
    }
  }
}
```

- 解析规则：从调用 cwd 沿文件路径向下找**第一个（最外层）**含任一标记的目录；cwd 是 `~/projects` 时，`~/projects/a/src/x.py` + `~/projects/a/pyproject.toml` → root 是 `~/projects/a`。cwd 自身含标记（仓库根有 `pyproject.toml`）时 root 恒为 cwd，`rootMarkers` 不起作用。
- 路径上没有命中时回退调用 cwd；搜索**不越过 cwd**（只看 cwd 及其后代）。
- 取最外层而不是离文件最近：tsserver 的 tsconfig 搜索从文件向上但**被 LSP root 截断**，root 比根 tsconfig 更深会让根配置完全加载不到；取最外层则更深的 tsconfig 仍由服务器自己向上找到。因此**不支持按子包定位**（每个 package 独立 root）——需要时用 `workingDir` 单条配置。
- 标记是**精确文件名**（目录名也可，如 `.git`），不支持 glob（C# `*.csproj` 这类暂不可用）。
- 同一服务器可为不同 root 各启动一个进程：`bin` 解析、`env` 的 `{root}`、项目工作区查找（`node_modules/.bin`、`.venv/bin`）都按各自 root 生效；footer status 与启动失败记录也按 root 分别显示。`/lsp-reload <id>` 会重启该服务器的所有 root 实例。
- 与 `workingDir` 互斥：需要固定单一 root 时用 `workingDir`，需要按子项目自动定位时用 `rootMarkers`，不要同时写。

## Example

`~/.pi/agent/lsp.json` 可直接作为从零搭建的参考：七种服务器全部显式声明（无内置默认服务器），pyright / typescript 用 `rootMarkers` 支持子目录项目，actions 用 `env.sh` 启动时现取 token。

```json
{
  "initializeTimeoutMs": "1m",
  "diagnosticsDocumentWaitTimeoutMs": "5s",
  "watch": {
    "ignore": ["**/.pdm-build"]
  },
  "servers": {
    "rust-analyzer": {
      "include": ["**/*.rs"],
      "bin": "rust-analyzer",
      "args": [],
      "languageIdByExtension": { ".rs": "rust" }
    },
    "go": {
      "include": ["**/*.go", "**/go.mod", "**/go.work"],
      "bin": "gopls",
      "args": ["serve"],
      "languageIdByExtension": { ".go": "go" }
    },
    "pyright": {
      "include": ["**/*.py", "**/*.pyi"],
      "rootMarkers": ["pyproject.toml", "pyrightconfig.json"],
      "bin": "pyright-langserver",
      "args": ["--stdio"],
      "languageIdByExtension": { ".py": "python", ".pyi": "python" }
    },
    "ruff": {
      "include": ["**/*.pyi?"],
      "bin": "ruff",
      "args": ["server"],
      "languageIdByExtension": { ".py": "python", ".pyi": "python" }
    },
    "typescript": {
      "include": ["**/*.{ts,tsx,js,jsx,mjs,cjs,mts,cts}"],
      "rootMarkers": ["package.json", "tsconfig.json"],
      "bin": "typescript-language-server",
      "args": ["--stdio"],
      "languageIdByExtension": {
        ".ts": "typescript",
        ".tsx": "typescriptreact",
        ".js": "javascript",
        ".jsx": "javascriptreact",
        ".mjs": "javascript",
        ".cjs": "javascript",
        ".mts": "typescript",
        ".cts": "typescript"
      }
    },
    "yaml": {
      "include": ["**/*.{yml,yaml}"],
      "bin": "yaml-language-server",
      "args": ["--stdio"],
      "languageIdByExtension": { ".yml": "yaml", ".yaml": "yaml" }
    },
    "actions": {
      "include": ["**/.github/workflows/*.ya?ml"],
      "bin": "actions-languageserver",
      "args": ["--stdio"],
      "env": {
        "GITHUB_TOKEN": { "sh": ["gh", "auth", "token"] }
      },
      "initializationOptions": {
        "sessionToken": "${GITHUB_TOKEN}"
      }
    }
  }
}
```

## typescript-language-server：TS 从哪来（易踩坑）

typescript-language-server **不内置 TypeScript**（零依赖）。启动时按下面顺序找一个可用的 tsserver，**全找不到就在 initialize 阶段报错退出**：

1. `initializationOptions.tsserver.path`（UserSetting，优先级最高）
2. workspace 探测：`<项目根>/node_modules/typescript/lib/tsserver.js`
3. 自身 `require.resolve('typescript')`（即它安装位置能解析到的 typescript）

`tsserver.path` 必须指向 **`typescript/lib/tsserver.js` 或 `typescript/lib/` 目录的绝对路径**（或 PATH 可执行名）；因为初始化字符串不支持 `{root}` 模板，无法用相对 workspace 的表达式。

**alias 依赖坑**：当项目把 typescript 写成 `npm:@typescript/typescript6`（alias stub）时，`node_modules/typescript/lib/` 下只有转发 stub（`typescript.js`/`tsserverlibrary.js`/`tsc.js`），**没有 `tsserver.js`** → workspace 探测失效；实体 tsserver 在 pnpm 虚拟 store：`node_modules/.pnpm/typescript@<真实版本>/node_modules/typescript/lib/tsserver.js`（目录名无 peer 后缀、相对稳定；**升级 typescript 版本后要同步更新路径**）。依赖为标准 `typescript` 包时 `node_modules/typescript` 直接是完整包，workspace 探测即命中、无需配 path。

配 `initializationOptions.tsserver.path` 时，因为 servers 按 id 整条覆盖，本地 `.pi/lsp.json` 要写完整条目，示例：

```json
{
  "servers": {
    "typescript": {
      "include": ["**/*.{ts,tsx,js,jsx,mjs,cjs,mts,cts}"],
      "bin": "typescript-language-server",
      "args": ["--stdio"],
      "languageIdByExtension": {
        ".ts": "typescript",
        ".tsx": "typescriptreact",
        ".js": "javascript",
        ".jsx": "javascriptreact"
      },
      "initializationOptions": {
        "tsserver": {
          "path": "/path/to/node_modules/.pnpm/typescript@6.0.3/node_modules/typescript/lib/tsserver.js"
        }
      }
    }
  }
}
```

## 服务器启动失败的行为（改了配置后怎么验证）

- 启动失败（binary 缺失 / initialize 拒绝）会**主动 notify 报错**（server id、root、原因、提示 `/lsp-reload <id>`），不需要等请求方触发
- 失败进入 60s 冷却：冷却内该服务器被跳过，**冷却过后下次触碰自动重试**——修复配置后不用重启 agent，等冷却过即可，或立即 `/lsp-reload <id>` 重启指定服务器（同时清除失败记录）
- 命令：`/lsp-reload <id>`（重启单个）、`/lsp-reload`（无参：重读配置并重启全部）、`/lsp-stop`（停全部并禁用）、`/lsp-start`（重新启用）

## 生效时机

- 配置在 `session_start` 预读并**按 cwd 缓存**：cwd 变化或 `/lsp-reload`（单个或无参）时重读。改配置后用 `/lsp-reload` 让全部或单个服务器换新配置（已启动的进程随之重启）
- `session_start` 时若 enabled 服务器数为 0 则不创建 service，之后从无到有地启用需要重启 agent

## 常见排查

| 现象                                                                          | 原因与修法                                                                                                                               |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| notify `failed to start …: binary not found`                                  | `bin` 不在 PATH（测试场景二进制缺失时整组跳过）                                                                                          |
| `… provides no tsserver.js. No other valid TypeScript installation was found` | workspace 的 `node_modules/typescript` 是 alias stub：配 `initializationOptions.tsserver.path` 指 `.pnpm` 实体，或换标准 typescript 依赖 |
| 诊断一直为空且无任何报错                                                      | 服务器没匹配到文件（`include`/扩展名）、在 broken 冷却中、或文件在调用 cwd 之外（LSP 只在工作目录内启用）                                |
| 读取配置直接抛错                                                              | typebox 严格校验拒绝：字段类型不符 / 非法时长格式（未知字段只是 warning，不拒绝）                                                        |
