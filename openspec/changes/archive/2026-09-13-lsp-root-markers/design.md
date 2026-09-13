## Context

动机见 proposal.md。实现约束来自现有 LSP 层：

- root 是 client 的身份之一：缓存键 `root + serverID`（`lsp.ts` 的 `state.clients` / `state.spawning` / `state.servers` / broken 记录）、`containsPath(change.path, client.root)` 的事件过滤、`startClient` 的 spawn cwd 与 rootUri 都按它工作。多 root 天然被这套结构支持，不需要新概念。
- root 目前由 `adapter.ts` 的 `serverRoot(workingDir, cwd)` 一次性算出，与文件无关；`getClients` 里紧跟 `containsPath(file, root)` 过滤。
- 配置校验分两层：`resolveConfig`（纯函数，全局配置在扩展加载时校验、本地配置在 session_start 与工具调用时校验）与 `validateConfig`（enabled 白名单）。配置错误的现有模式是加载期抛错 + 会话级 notify。
- `bin.ts` 已有 `exists`（同步存在性检查）；标记搜索沿 cwd→文件的目录链逐级向下，不复用 `walkUp`。

## Goals / Non-Goals

**Goals:**

- 让同一服务器条目按文件所在项目自动定位 root，无需为每个子项目写一条配置。
- 取最外层（最靠近 cwd）的命中：cwd 本身是项目根时 root 恒为 cwd，行为与现状一致。
- 不配置 `rootMarkers` 时行为、性能与错误信息完全不变。
- 多 root 场景下 reload 不丢实例。

**Non-Goals:**

- glob 标记匹配（`*.csproj` / `*.sln` / `*.cabal` / `*.xcodeproj` 这类文件名带项目名的生态）。精确名覆盖 Python/TS/Go/Rust 等主流固定标记；将来加 glob 时字符串数组向后兼容（无通配符的字符串本身就是合法 glob）。
- 内置默认标记表：本仓库没有内置默认服务器，标记一律由用户配置。
- 按子包（nearest）定位：cwd 是项目根、但子目录是独立项目（每包独立 tsconfig/node_modules、Python 每包 venv/pyrightconfig）的场景不再可表达；需要时再按显式选项加回，不改变默认。
- 标记缺失时跳过文件（严格模式）——保留回退 cwd 的语义。
- 多 root 的全局实例上限与空闲实例回收。

## Decisions

### D1：`rootMarkers` 与 `workingDir` 互斥，同时配置报错

两字段都是"root 从哪来"的答案，同时出现即配置意图冲突；静默取一会让另一个字段看似生效实则被忽略。备选：workingDir 作为搜索边界与回退（可组合但语义更绕）、workingDir 优先并 warning（保留死配置）。

校验落在 `resolveConfig`（配置解析期、纯函数），与 enabled 白名单校验同层，复用三条既有上报路径：全局配置在扩展加载时抛错、本地配置在 session_start notify、工具调用兜底抛错。错误信息：`lsp.json: server "<id>": workingDir and rootMarkers are mutually exclusive`。判定按"字段是否出现"而非"是否非空"：`rootMarkers: []` 与 `workingDir` 同现同样报错，避免出现第二种"没有标记"的写法。

### D2：标记按精确文件名匹配，从 cwd 向下取最外层命中

每级目录对每个标记做 `exists(join(dir, marker))`（目录名如 `.git` 同样命中），不做 glob、不 readdir。搜索沿 `dirChain(cwd, dirname(file))`（cwd → 文件目录，含两端）从 cwd 端开始，**第一个命中的目录即 root**；target 在 cwd 之外时目录链退化为 `[cwd]`，保证不越过会话工作目录（`getClients` 本就有 `containsPath(file, cwd)` 前置）。路径上没有命中时回退 cwd，避免"标记缺失导致诊断静默消失"的排查负担。

取最外层而非离文件最近，关键理由是服务器侧的项目配置发现方向：typescript-language-server 在 `didOpen` 时把 `projectRootPath` 设为 LSP root，tsserver 的 tsconfig 搜索（`forEachConfigFileLocation`）从文件目录向上但**被 projectRootPath 截断**——root 比 tsconfig 更深时根 tsconfig 根本不会加载，落到 inferred project（`paths`、project references 失效）。取最外层则深于 root 的 tsconfig 仍由 tsserver 自己向上找到；反过来（root 更深、配置在根）无法补救。次要收益：cwd 是项目根时行为与现状完全一致，rootMarkers 只在容器目录场景生效；同一仓库的服务器实例也更少。

备选（未采用）：nearest（离文件最近的标记目录）——为每包独立项目提供 per-package root，但对上述根配置场景是负优化；workspace 根标记（`pnpm-workspace.yaml` / lockfile）——依赖用户按包管理器维护标记列表，且非 workspace 布局无法表达。

### D3：root 解析改为 `serverRoot(adapter, file, cwd)`

`adapter.ts` 的 `serverRoot` 改为：

```ts
export function serverRoot(
  adapter: Pick<LspServerAdapter, "workingDir" | "rootMarkers">,
  file: string,
  cwd: string,
): string;
```

- `rootMarkers` 非空 → 按 D2 查找，返回命中目录或 cwd；
- 否则 `workingDir === undefined ? cwd : resolve(cwd, workingDir)`。

`LspServerAdapter` 增 `readonly rootMarkers?: readonly string[]`，`ConfigAdapter` 暴露 `config.rootMarkers ?? []`。`getClients` 保留 `if (!containsPath(file, root)) continue;`：对 `workingDir` 语义不变（目录外文件跳过），对标记路径恒真。schema 元素加 `Type.String({ minLength: 1 })`，空串标记会匹配任意目录，必须拒绝。

### D4：reload 按 (serverID, root) 对恢复

`respawnRunning` 现签名按 serverID 重算 root（`serverRoot(adapter.workingDir, cwd)`），多实例场景只能恢复一个，且重算需要文件上下文而 reload 没有。改为在清理前从 `state.clients` 捕获 `{ serverID, root }` 集合（按 `root\0serverID` 去重），重载后逐个 `startClient(adapter, root, cwd, config)`；`reload(serverID)` 与 `reloadAll()` 共用。root 不重新解析——标记文件在重载间的变化由下一次文件触碰自然生效。

## Risks / Trade-offs

- [同一服务器实例数随子项目数增长（进程 / 内存 / 文档 LRU 配额按实例各算一份）] → 只在 cwd 是容器目录、其下并列多个项目时发生（cwd 自身是项目根时恒为单实例）；skill 文档写明每 root 一个实例，必要时后续加全局上限。
- [无法按子包定位 root（每包独立 tsconfig/node_modules 的场景）] → 已在 Non-Goals 记录；需要时再加显式选项，不改变最外层默认。
- [会话中途新建 / 删除标记文件导致 root 归属变化] → root 每次触碰文件时重新解析：新 root spawn 新实例，旧实例保留到 LRU 淘汰或 `/lsp-reload`，不做主动回收（行为可预测、无额外状态）。
- [`include` 与多 root 的交互] → 保持 `matchesInclude` 现有语义（相对 root 或 cwd 任一命中），用户可用相对 cwd 的 pattern 限定子项目，不改过滤逻辑。
- [互斥校验会让存量"两字段都写"的配置直接报错] → 该组合此前不存在（`rootMarkers` 是本次新增），无存量配置；报错信息带 server id 与修复方向。

## Migration Plan

无数据迁移、无破坏性变更：新字段可选，未配置时行为与现状一致。回滚只需从配置中删除 `rootMarkers`。用户本机 `~/.pi/agent/lsp.json` 补 `rootMarkers` 是可选后续（不在仓库改动内），加完用 `/lsp-reload` 生效。
