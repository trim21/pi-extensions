---
name: coding-style-cpp
description: Use when 编写、生成、修改、编辑、重构或评审任何 C++ 代码——涵盖实现功能、修 bug、写测试、性能优化、代码迁移、重命名、加减参数或函数、修改函数签名、定义 struct / class、处理函数间数据流、JSON 反序列化、nlohmann、code review / PR review。任何会产出或改动 C++ 代码的任务（write / edit / refactor / review C++ code）都要先加载本 skill，即使用户没有提到风格、规范或最佳实践。只读调查不加载：单纯 debug、定位代码、定位问题、读代码理解逻辑等不改代码的任务不需要加载。
---

# C++ 编码风格

**REQUIRED BACKGROUND：先加载 `coding-style`（shared）**——语言无关的原则与"为什么"在那里，章节序号与本文件对应；本文件只放 C++ 侧的具体写法。

> 状态：骨架，细则待补充。计划覆盖（与 shared 章节对应）：
>
> 1. 函数边界容器：struct / aggregate（不用裸 `nlohmann::json` / `void*` 穿函数边界）。
> 2. 边界校验与"构造即合法"：构造函数校验或工厂函数返回 expected / optional，枚举用 `enum class`。
> 3. JSON 反序列化分两层：原始 struct（nlohmann 宏忠实镜像外部形状）→ 内部 struct 转换；宏选型（`NON_INTRUSIVE` vs `WITH_DEFAULT`）的取舍见 `coding-style-ffi`。
