# vision-agent Specification

## Purpose

主模型不支持视觉时自动注册 `describe_image` 工具：图片以 base64 data URL 直接放进请求体，由视觉模型逐张描述，不经 read 工具或中间 agent；主模型支持视觉时工具自动隐藏。

## Requirements

### Requirement: 工具按视觉能力注册

`describe_image` 工具的存在 MUST 由主模型视觉能力决定：主模型不支持视觉时注册，支持视觉时不注册。判定 MUST 在每个会话启动时以该会话的模型为条件进行一次，MUST 以「注册与否」实现，MUST NOT 通过调整 pi 的 active 工具列表改变本工具的可用性。未配置 `visionConfig`（或 provider / model 缺失）时 MUST 不注册，避免一个必然失败的僵尸工具。

#### Scenario: 主模型无视觉时注册

- **WHEN** 会话启动时的主模型不支持视觉
- **THEN** 注册 `describe_image` 工具

#### Scenario: 主模型有视觉时隐藏

- **WHEN** 会话启动时的主模型支持视觉
- **THEN** 不注册 `describe_image`（图片由 pi 原生透传）

#### Scenario: 未配置视觉模型不注册

- **WHEN** 未配置 `visionConfig`（或 provider 缺失）
- **THEN** 不注册工具，避免一个必然失败的僵尸工具

#### Scenario: 不通过 active 列表实现可见性

- **WHEN** 判定结果为不注册
- **THEN** 扩展不调整 pi 的 active 工具列表；工具仅因未被注册而不出现在模型可见的工具清单里

### Requirement: 图片识别

工具接收本地图片路径，识别并返回描述。

#### Scenario: 单张/多张识别

- **WHEN** 传入一个或多个本地图片路径
- **THEN** 图片以 base64 data URL 放进请求体，由视觉模型按顺序逐张描述

#### Scenario: 具体描述要求

- **WHEN** 提供 `prompt` 参数
- **THEN** 按该要求描述；缺省时自动生成通用描述指令

### Requirement: 配置复用

视觉模型配置复用 pi 的 provider 体系，不单独维护。

#### Scenario: 配置复用 pi provider

- **WHEN** 配置 `visionConfig` 的 `provider` / `model`
- **THEN** 认证、代理、网络全部复用 pi 自身配置（`baseUrl` / `apiKey` 从 `~/.pi/agent/models.json` 解析），缺省 provider 回退 `defaultProvider`

## Implementation

入口 `src/vision-agent.ts`：启动时按主模型视觉能力决定是否注册 `describe_image`（支持视觉则隐藏，由 pi 原生透传图片）；未配置 `visionConfig`（或 provider 缺失）时不注册。

- 工具接收本地图片路径（单个或数组），图片直接以 base64 data URL 放进请求体，由视觉模型按顺序逐张描述，不经过 read 工具或中间 agent。
- 内置默认 system prompt（图像识别助手），`prompt` 参数追加具体描述要求，缺省自动生成通用描述指令。
- provider 的 `baseUrl` / `apiKey` 从 `~/.pi/agent/models.json` 解析，认证 / 代理 / 网络复用 pi 自身配置。

涉及文件：`src/vision-agent.ts`。
