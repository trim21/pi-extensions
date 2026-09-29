# Spec Delta

## ADDED Requirements

### Requirement: 委托提示词

`spawn-agent` 向模型暴露的描述 MUST 给出委托判据、返回契约与并发语义，而不只是工具的能力说明，使模型能判断何时委托调研任务。

#### Scenario: 工具描述给出返回契约与并发语义

- **WHEN** 读取 `spawn-agent` 的工具描述
- **THEN** 描述说明子 agent 看不到当前对话、只返回其最终回答（中间工具调用不可见）
- **AND** 描述说明同一条消息中的多个 `spawn-agent` 调用会并发执行

#### Scenario: task 参数要求自包含

- **WHEN** 读取 `task` 参数的描述
- **THEN** 描述要求任务自包含，写明仓库路径、确切问题与期望返回内容（文件路径 + 行号）

#### Scenario: guideline 给出委托判据

- **WHEN** 读取注入的 guideline
- **THEN** 其中列出该委托的情形（位置未知或多文件才能回答的只读调研、答案只需摘要、多个互相独立的调研点并发发起）与不该委托的情形（即将自己编辑的单文件、需要逐字原文作为证据、任何写操作）
- **AND** 说明子 agent 的结论只作为定位线索，动手改动前须自行核对其指出的位置
- **AND** 随后才列出可用子 agent 类型及其描述

#### Scenario: 工具出现在工具清单中

- **WHEN** 拼装 system prompt 的 "Available tools" 清单
- **THEN** `spawn-agent` 因带有 prompt snippet 而出现在该清单里
