# Spec Delta

## MODIFIED Requirements

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
