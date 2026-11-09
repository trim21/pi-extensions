# Go 编码风格

`coding-style` 的 Go reference：语言无关的原则与"为什么"见 `../SKILL.md`，章节序号与本文件对应；本文件只放 Go 侧的具体写法。

> 状态：骨架，细则待补充。计划覆盖（与 shared 章节对应）：
>
> 1. 函数边界容器：struct（构造函数 `NewXxx`、值 vs 指针接收者对数据流的影响、不用 `map[string]any` / `any` 穿函数边界）。
> 2. 边界校验与"构造即合法"：构造时返回 error、枚举用自定义类型 + 受限常量集合（`type Side string` + `SideBuy`/`SideSell`）。
> 3. JSON 反序列化分两层：`encoding/json` 的原始 struct（tag 忠实镜像外部形状）→ 内部 struct 转换，或第三方校验库选型。
> 4. 公共 API："accept interfaces, return structs"——参数收小接口，返回具体 struct。
