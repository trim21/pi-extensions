# Spec Delta

## MODIFIED Requirements

### Requirement: 工具注册与可调用工具集合

扩展 MUST 注册名为 `codemode` 的工具，并 MUST 在注册时把脚本可调用的工具集合渲染进工具描述，为每个工具给出名字、说明、参数类型与返回类型。返回类型 MUST 由工具声明的输出结构推导：声明了 `structuredSchema` 的工具按该 schema 渲染，未声明的工具渲染为文本（`string`）。该集合 MUST 等于本仓库工具总线上实际注册的工具减去排除名单，排除名单为 `codemode` 自身、`spawn-agent`，以及两套文件工具集的读写工具（`Read` / `Edit` / `Write` 与 `read` / `edit` / `write`）；执行时 MUST 再与当前 active 工具列表求交（取不到 active 列表时不过滤）。脚本 MUST NOT 能调用排除名单里的任何工具名。

#### Scenario: 描述列出可调用工具

- **WHEN** 获取 `codemode` 的工具描述
- **THEN** 描述包含总线上除排除名单外每个工具的名字、说明与参数类型声明

#### Scenario: 描述给出每个工具的返回类型

- **WHEN** 某工具声明了输出结构，另一个工具没有
- **THEN** 描述里前者的返回类型按该结构渲染，后者的返回类型为文本（`string`）

#### Scenario: 集合外的工具不可调用

- **WHEN** 脚本调用一个不在总线上的工具名
- **THEN** 该调用在脚本内以错误失败，不产生任何宿主副作用

#### Scenario: 未启用的工具不可调用

- **WHEN** 脚本调用一个已注册但当前不 active 的工具（例如子代理工具白名单之外的工具）
- **THEN** 该调用失败，不执行该工具

#### Scenario: 脚本自身不可再调用 codemode

- **WHEN** 脚本尝试调用 `codemode`
- **THEN** 该调用失败，不会递归启动新的脚本

#### Scenario: 脚本不可调用 spawn-agent

- **WHEN** 脚本尝试调用 `spawn-agent`（即使该工具已注册且 active）
- **THEN** 该调用在脚本内以错误失败，不启动任何子代理，`codemode` 的工具描述里也不出现它的参数声明

#### Scenario: 脚本不可调用文件读写工具

- **WHEN** 脚本尝试调用 `Read` / `Edit` / `Write`（或小写的 `read` / `edit` / `write`），无论它们是否已注册且 active
- **THEN** 该调用在脚本内以错误失败，工具 MUST NOT 被执行，`codemode` 的工具描述里也不出现它们的参数声明；脚本要碰文件只能用 `fs.read` / `fs.write`

## ADDED Requirements

### Requirement: 脚本文件原语

脚本 MUST 提供 `fs` 对象，含 `read(path)` 与 `write(path, content)` 两个方法，由宿主用 `node:fs/promises` 直接实现。`fs` MUST NOT 是工具：它 MUST NOT 出现在工具列表、`ALL_TOOLS` 或工具描述的工具重载里，也 MUST NOT 参与 `disabledTools` 与当前 active 工具的求交。相对路径 MUST 相对本次调用的 cwd 解析。两个方法的失败 MUST 在脚本内以 `CallFailedError` reject（与嵌套调用同一条失败通道），message MUST 保留底层错误说明。

`fs.read` MUST 返回文件全文的 UTF-8 文本，MUST NOT 加行号、MUST NOT 截断、MUST NOT 按大小设限（读到的内容不进模型上下文，放不下时以错误失败即可）；内容不是合法 UTF-8 时 MUST 以错误失败，MUST NOT 静默替换。读取成功 MUST 记入已读记账。

`fs.write` MUST 只接受字符串内容、MUST 创建缺失的父目录。写入前 MUST 要求目标文件处于「已读且读后未变」状态（复用 `src/lib/file-reads.ts` 的记账，且与文件工具共用同一份 state：任一侧读过的文件另一侧都算已读），未读或读后内容被改 MUST 以错误失败；目标文件不存在时 MUST 允许直接写入。写入前的路径审批 MUST 复用 write-guard 的既有行为：工作区内与 `/tmp` 自动放行，工作区外弹审批并在预览里给出变更前后的 diff，headless 会话、Windows 与 `/bwrap-deny-request` 生效时 MUST 直接拒绝。写入成功后 MUST 把新内容记成已读，且脚本产生的已读 MUST 随 codemode 的工具结果持久化，使其在分支重放后仍然有效。

`fs` 的声明 MUST 渲染进 codemode 的工具描述，使模型在写脚本前能看到这两个方法。

#### Scenario: 读到原始内容

- **WHEN** 脚本 `await fs.read(path)` 读一个文本文件
- **THEN** 得到文件全文，没有行号前缀、没有被截断

#### Scenario: 相对路径按 cwd 解析

- **WHEN** 脚本用相对路径调用 `fs.read` / `fs.write`
- **THEN** 路径相对本次调用的 cwd 解析

#### Scenario: 大文件不截断

- **WHEN** 脚本 `fs.read` 一个体积远大于「模型能看的内容」的文件（例如几十 MiB）
- **THEN** 得到完整内容，不按大小裁剪；只有真的放不下（VM 堆不够）时才以错误失败

#### Scenario: 非 UTF-8 内容报错

- **WHEN** 脚本 `fs.read` 一个不是合法 UTF-8 的文件
- **THEN** 调用以错误失败

#### Scenario: 未读就写被拒

- **WHEN** 脚本对一个已存在但本次会话没有读过的文件调用 `fs.write`
- **THEN** 调用以错误失败，提示需要先读，文件 MUST NOT 被修改

#### Scenario: 读后文件被改动再写被拒

- **WHEN** 脚本 `fs.read` 之后文件被外部改动，脚本再对同一路径 `fs.write`
- **THEN** 调用以错误失败，提示文件已被修改、需要重读，文件 MUST NOT 被覆盖

#### Scenario: 新建文件无需先读

- **WHEN** 脚本 `fs.write` 一个不存在的路径
- **THEN** 文件被创建，缺失的父目录一并创建，不要求先读

#### Scenario: 写入沿用 write-guard 审批

- **WHEN** 脚本 `fs.write` 一个工作区外的路径
- **THEN** 与写类工具一致地弹出审批（预览包含变更前后的 diff），用户不批准时调用失败且文件不变

#### Scenario: 受策略与平台约束

- **WHEN** headless 会话、Windows 或 `/bwrap-deny-request` 生效时脚本 `fs.write` 一个工作区外的路径
- **THEN** 调用被直接拒绝，不弹审批、不写文件

#### Scenario: 脚本读与工具读互通

- **WHEN** 文件由 `Read` 工具读过（或由 `fs.read` 读过），随后任一侧对同一文件写入
- **THEN** 两侧共用同一份已读记账：`fs.write` 认工具的读，写类工具也认脚本的读，不需要重新读一遍

#### Scenario: 出现在工具描述里

- **WHEN** 读取 codemode 的工具描述
- **THEN** 描述里有 `fs.read` / `fs.write` 的声明，且 `ALL_TOOLS` 与工具重载列表里没有它们
