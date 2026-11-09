# C++ 编码风格

`coding-style` 的 C++ reference：语言无关的原则与"为什么"见 `../SKILL.md`，章节序号与本文件对应；本文件只放 C++ 侧的具体写法。

> 状态：骨架，细则待补充。计划覆盖（与 shared 章节对应）：
>
> 1. 函数边界容器：struct / aggregate（不用裸 `nlohmann::json` / `void*` 穿函数边界）。
> 2. 边界校验与"构造即合法"：构造函数校验或工厂函数返回 expected / optional，枚举用 `enum class`。
> 3. JSON 反序列化分两层：原始 struct（nlohmann 宏忠实镜像外部形状）→ 内部 struct 转换；宏选型（`NON_INTRUSIVE` vs `WITH_DEFAULT`）的取舍见 `references/ffi.md`。
