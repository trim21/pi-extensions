# Spec Delta

## MODIFIED Requirements

### Requirement: 启用配置

配置 MUST 读取 `~/.pi/agent/settings.json` 的 `personalExtensions` section，包含：

- `fileIo`：兜底的文件 IO 工具集，取值 `"claude-code"` 或 `"opencode"`，缺省 `"claude-code"`。
- `fileIoByModel`：可选数组，条目为 `{ models: string[], fileIo: "claude-code" | "opencode" }`，按顺序取第一条模型命中的条目覆盖 `fileIo`。
- `disabledTools` / `enabledTools` / `codemodeOnlyTools`：可选数组，条目 MUST 是工具名模式字符串，或 `{ tools: string[], models?: string[] }`。工具名与模型名都用通配模式匹配；工具名按名称整体匹配；模型名 MUST 同时尝试匹配当前模型的 `model id` 与 `provider/model` 两种写法。
- `shell`：可选对象，目前只有 `env` 字段；`shell.env` MUST 是「环境变量名 → 字符串值」的映射，作为 bash 工具执行命令时的额外环境变量，生效方式见 `bwrap` capability 的「命令执行环境」要求。

工具生效规则 = 命中 `disabledTools` 且未命中 `enabledTools`；带 `models` 的条目只在当前模型命中时才参与判定。工具同时命中 `codemodeOnlyTools`、未被禁用、且声明了 `structuredSchema` 时，MUST 按 codemode-only 注册；命中 `codemodeOnlyTools` 但没有 `structuredSchema` 时 MUST 照常直接注册并产生警告。配置缺失时 MUST 使用默认值继续工作；出现非法条目，或某个工具名模式匹配不到任何工具（含被规则禁用的工具）时，MUST 产生可诊断的警告，且 MUST NOT 影响其余配置项生效。

#### Scenario: 未配置时使用默认值

- **WHEN** settings.json 没有 `personalExtensions` section
- **THEN** 注册 claude-code 那套文件 IO 工具集，不额外禁用任何工具，也不启用任何 codemode-only 工具，bash 命令不注入任何额外环境变量

#### Scenario: 通配匹配

- **WHEN** `disabledTools` 含 `"talk-*"`
- **THEN** 所有以 `talk-` 开头的工具都被命中，其他工具不受影响

#### Scenario: codemode-only 按模型匹配

- **WHEN** `codemodeOnlyTools` 含 `{ "tools": ["read-github-*"], "models": ["gpt-*"] }`
- **THEN** 仅在匹配 `gpt-*` 的会话里这些工具被注册为 codemode-only，其他模型下不受影响

#### Scenario: 按模型选择工具集

- **WHEN** `fileIo` 为 `claude-code` 且 `fileIoByModel` 含 `{ "models": ["glm-*"], "fileIo": "opencode" }`
- **THEN** 匹配 `glm-*` 的模型注册 opencode 那套工具（`bash` / `read` / `write` / `edit` …），其他模型注册 claude-code 那套（`Bash` / `Read` / `Write` / `Edit` …）

#### Scenario: 按模型启用

- **WHEN** `disabledTools` 含 `{ "tools": ["web_*"], "models": ["*"] }`，且 `enabledTools` 含 `{ "tools": ["web_search"], "models": ["glm-*"] }`
- **THEN** 只有在匹配 `glm-*` 的模型下 `web_search` 可用，其他模型下 `web_search` 不可用

#### Scenario: 非法取值给出警告

- **WHEN** `fileIo` 不是 `claude-code` / `opencode`，或某条目既不是字符串也不是 `{ tools, models }`
- **THEN** 该条被忽略，其余配置照常生效；`fileIo` 的警告带取值，数组条目的警告指明字段路径与下标

#### Scenario: shell.env 的非法取值给出警告

- **WHEN** `shell` 不是对象、`shell.env` 不是对象，或 `shell.env` 中某个值不是字符串
- **THEN** 该条被忽略，其余配置项照常生效，警告指明 `personalExtensions.shell.env` 的字段路径（含出问题的键名），不抛错也不影响会话启动

#### Scenario: 未知工具名给出警告

- **WHEN** 某个工具名模式匹配不到任何工具（含被规则禁用、因而没有注册的工具）
- **THEN** 该模式被忽略，其余规则照常生效，并给出指明该模式的警告
