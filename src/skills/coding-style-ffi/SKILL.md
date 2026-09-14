---
name: coding-style-ffi
description: Use when 处理任何跨语言 FFI 或跨语言数据传递——pybind11、nanobind 绑定（binding）、Python↔C++ 镜像结构、`SYNC` 契约注释、nlohmann JSON 跨边界序列化、`.pyi` stub 维护、跨语言类型映射。任何要在两种语言之间传递数据或写绑定的任务都要先加载本 skill，即使用户没有提到风格、规范或最佳实践。只读调查不加载：单纯 debug、定位或理解跨语言代码、而不写或改绑定/镜像结构代码的任务不需要加载。
---

# Python ↔ C++ FFI：镜像结构与跨边界数据传递

**REQUIRED BACKGROUND：先加载 `coding-style`（shared）**——语言无关的原则与"为什么"在那里；本文件只放跨语言侧的具体写法。

当同一份配置/事件结构要同时存在于 Python 和 C++，并通过 JSON 跨边界传递时，两侧必须是字段 1:1 的镜像，不能各自演化。用 `SYNC:` 注释把另一侧的定义位置写死；改字段必须一次提交改两侧。

### Python 侧写法

```python
from dataclasses import dataclass, field, asdict

# SYNC: frm_cta/sim_models.hpp::SimRunnerConfig
@dataclass(frozen=True, kw_only=True)
class SimRunnerConfig:
    """镜像 C++ `frm_cta::SimRunnerConfig`。
    Fields must stay 1:1 with the C++ struct; any change requires a matching update on both sides.
    """
    signal_path: str
    sim_stats_path: str
    sim_details_path: str
    aum: float = 3e8
    exec_cfg_dict: dict[str, SingleExecConfig] = field(default_factory=dict)
```

要点：

- `SYNC:` 行写完整路径（头文件相对路径或模块路径 + `::` + 类型名），让另一侧能被直接定位，不只是写个类型名。
- 紧跟一行说明"字段必须 1:1，改动要双侧同步"——这是契约的文字版，提醒任何修改者。
- 嵌套结构同样各自定义 dataclass，各自带 `SYNC:`，不要用裸 dict 代替嵌套对象（和 `coding-style` 第 1 节一致）。
- `asdict()` 会递归把嵌套 dataclass 摊平成 dict，正是 JSON 序列化需要的形态。

### C++ 侧写法

定义普通 `struct`，字段与 Python 1:1，用 nlohmann 的非侵入式宏注册字段，注释里写 `SYNC:` 指回 Python 侧：

```cpp
#include <nlohmann/json.hpp>

namespace frm_cta {

// SYNC: py_frm_cta/sim_models.py::SimRunnerConfig
// Fields below must stay 1:1 with the Python dataclass; any field change requires a matching update on both sides.
// signal_path / sim_stats_path / sim_details_path 在 Python 侧无默认值（必填），
// 这里也不给类内默认值—保持"必填"语义两侧一致。
struct SimRunnerConfig {
    std::string signal_path;
    std::string sim_stats_path;
    std::string sim_details_path;
    double aum{3e8};
    std::unordered_map<std::string, SingleExecConfig> exec_cfg_dict{};
};

// 注意：NON_INTRUSIVE 缺任意键（包括有默认值的 aum / exec_cfg_dict）都会抛异常，
// 与 Python 侧"缺键用默认值"不同。asdict 总会输出全部字段，正常路径不受影响；
// 若外部 JSON 可能缺可选字段，改用 WITH_DEFAULT 宏 + 必填字段存在性校验（宏的取舍见下方要点）。
NLOHMANN_DEFINE_TYPE_NON_INTRUSIVE(SimRunnerConfig, signal_path, sim_stats_path, sim_details_path, aum, exec_cfg_dict)

}  // namespace frm_cta
```

要点：

- **默认值与 Python 侧对齐，包括"有没有默认值"。** Python 无默认值的字段（必填），C++ 侧也不给类内默认值；Python 有默认值的字段，C++ 侧给相同默认值。"必填 vs 可缺"是一种语义，两侧必须一致，否则 JSON 缺这个键时一侧抛错一侧静默用默认值，行为分叉。注意：在 `NLOHMANN_DEFINE_TYPE_NON_INTRUSIVE` 下这些类内默认值只在手工构造时生效——JSON 缺任意键都会抛；要让缺键走默认值，用 `WITH_DEFAULT` 宏。
- 宏的选择跟着字段语义走：全部字段都有默认值 → `NLOHMANN_DEFINE_TYPE_NON_INTRUSIVE_WITH_DEFAULT`（缺键走默认值，前向兼容好）；有必填字段 → `NLOHMANN_DEFINE_TYPE_NON_INTRUSIVE`（缺键直接抛，匹配 Python 的"必填"行为）。一个结构里两者混用时，用 `WITH_DEFAULT` 并在解析后对必填字段做一次存在性校验，或拆成两个结构。不要为了统一用一个宏而给必填字段硬塞默认值——那会把"必填"悄悄降级成"可缺"。
- 每个 `SYNC` 结构都要注册宏，包括嵌套的——nlohmann 是按类型注册的，嵌套类型本身也得能被反序列化。
- 字段用 C++ 原生类型（`std::string`、`double`、`bool`、`std::int32_t` 等），不要用 nlohmann 的 `json` 类型当字段。

### 传递数据

Python → C++：

```python
import json
from dataclasses import asdict

# 构造 dataclass
runner_config = SimRunnerConfig(signal_path="...", sim_stats_path="...", ...)

# asdict 递归摊平成 dict，再 json.dumps 成字符串跨边界
config_json = json.dumps(asdict(runner_config))

# 传给 C++ 侧（具体 FFI 调用取决于你的绑定层）
container = strategy_api.get_cpp_strategy_container_v2(
    strategy_config=asdict(runner_config),  # 绑定层内部会做 json.dumps
    strategy_class_name="FrmCtaRunner",
)
container.trigger(asdict(OnTriggerEvent(...)))  # 同理
```

C++ 侧收到 JSON 字符串后反序列化：

```cpp
nlohmann::json j = nlohmann::json::parse(json_str);
SimRunnerConfig cfg = j.get<SimRunnerConfig>();  // 靠宏注册的字段映射
```

反向（C++ → Python）不走 JSON，见下方"返回方向"一节。

### 返回方向：用 pybind11/nanobind 绑定 class + `.pyi`

上面讲的都是 Python → C++（入站）：Python 是数据的构造方，用 stdlib dataclass 组装好、`asdict` → JSON → C++ 侧 nlohmann 反序列化。Python 侧写起来 ergonomic、对类型检查友好。

**C++ → Python（出站）方向不对称，不要走 JSON。** C++ 已经持有对象，再序列化成字符串让 Python 反序列化是纯浪费。出站直接用 pybind11/nanobind 把 C++ `struct`/`class` 绑成一个 Python class 返回，Python 拿到的是带类型的活对象，不拷贝不序列化。

两个返回场景都用 binding + `.pyi`，区别只是 class 里有没有方法：

- **带行为的对象**（比如 C++ 实现的 `Reader`、`Container`）：绑定时 `.def("read", &Reader::read)` 暴露方法，Python 调用的是 C++ 真实方法，对象本身在 C++ 侧，不拷数据出来。
- **纯数据**（比如 `struct { std::string name; std::int64_t id; }`）：绑定时只有 `def_readonly` 暴露字段，没有方法。Python 拿到的是一个带类型的只读对象，等价于一个 frozen dataclass，但不需要序列化往返。

例子（纯数据）：

```cpp
// config_models.h
struct Data {
  std::string name;
  std::int64_t id;
};
```

```cpp
// binding.cpp
#include <pybind11/pybind11.h>
#include "config_models.h"

namespace py = pybind11;

PYBIND11_MODULE(my_mod, m) {
    py::class_<Data>(m, "Data")
        .def_readonly("name", &Data::name)
        .def_readonly("id", &Data::id);
}
```

```python
# my_mod.pyi
# SYNC: config_models.h::Data（对应 binding.cpp 中 py::class_<Data>）
class Data:
    name: str  # SYNC: config_models.h::Data::name（C++ std::string）
    id: int    # SYNC: config_models.h::Data::id（C++ std::int64_t）
```

带方法的 Reader 同理，多加一行 `.def("read", &Reader::read)`，`.pyi` 里方法签名同样加 `SYNC` 注释指回 C++ 方法：

```python
# my_mod.pyi
# SYNC: reader.h::Reader（对应 binding.cpp 中 py::class_<Reader>）
class Reader:
    def read(self, path: str) -> Data: ...  # SYNC: reader.h::Reader::read
    id: int                                 # SYNC: reader.h::Reader::id
```

**要点：**

- **`.pyi` + binding + C++ struct 三方同步。** 改 C++ struct 字段/方法时，binding 代码和 `.pyi` 必须同提交一起改。`.pyi` 的类型标注没有运行时校验兜底：mypy/pyright 只信 `.pyi`、不知道 C++ struct 长什么样，字段漏改时类型检查照样通过，直到运行时访问才 `AttributeError`——同步只能靠注释纪律。在每个 class 定义旁加 `SYNC:` 注释指回 C++ struct 和 binding 代码（如示例中的 `# SYNC: config_models.h::Data`），review 时一眼能发现"只改了一侧"。和入站的 JSON 镜像同一套纪律，只是同步的是 binding 而非 JSON schema。
- **注释分两级：class 级定位，字段/方法级防漂移。** class 旁的 `SYNC` 让 review 时能定位"这个类对应 C++ 哪里"；字段/方法级的 `SYNC` 把改名、改类型这类单点漂移也标出来。类型映射不是显然 1:1 的位置（参数、返回值、有转换的字段）尤其值得写注释，否则改 C++ 侧时不知道 `.pyi` 哪里要跟着改。字段很多的 struct 不必每条都写，但命名不一致、类型有转换的字段必须写。
- **只读字段用 `def_readonly`，不用 `def_readwrite`。** 呼应"frozen 优先"：能不让 Python 改就别让改。Python 侧拿到的是 C++ 对象的视图，允许写入反而引入"C++ 对象被 Python 改了"的耦合，破坏不可变语义。
- **`.pyi` 是类型检查器看到的契约。** Python 运行时拿到的对象类型由 binding 决定，`.pyi` 只给 mypy/pyright 看。两者必须一致——字段名、字段类型、方法签名都要对得上 binding，否则类型检查通过但运行时 AttributeError。
- **入站用 JSON、出站用 binding，不要对称化。** 反对称是刻意的：入站 Python 是构造方，dataclass + JSON 让 Python 侧写起来自然、类型检查友好；出站 C++ 是持有方，binding 直接暴露对象、避免无谓序列化。别为了"对称"强行让入站也走 binding（Python 侧构造 C++ 对象 ergonomic 差）或出站也走 JSON（白白多一次序列化）。
- **什么时候出站也走 JSON：** 几乎没有。除非返回值要被 Python 序列化存盘/转发（这时 C++ 直接 `j.dump()` 给个字符串更省事），或绑定一个只读数据 struct 的成本（写 binding + .pyi）相比字段数确实不划算，否则 binding 总是更优。

这里虽然要写的代码多，但是复杂度并不高，反而提高了可维护性。

### 类型映射约定

两侧类型要对上，以下是常用映射，保持项目内一致：

| Python                      | C++                                  | 说明                                                |
| --------------------------- | ------------------------------------ | --------------------------------------------------- |
| `str`                       | `std::string`                        |                                                     |
| `bool`                      | `bool`                               |                                                     |
| `int`                       | `std::int32_t` / `std::int64_t`      | 按数值范围选宽度，C++ 侧显式写宽度，别用裸 `int`    |
| `float`                     | `double`                             | C++ 侧默认用 `double`，不用 `float`，除非有明确理由 |
| `list[T]`                   | `std::vector<T>`                     |                                                     |
| `dict[str, V]`              | `std::unordered_map<std::string, V>` |                                                     |
| `T \| None` / `Optional[T]` | `std::optional<T>`                   | nlohmann 需要包含 optional 适配头                   |
| 嵌套 dataclass              | 嵌套 struct                          | 两侧都需注册/定义                                   |

### 维护纪律

`SYNC` 注释是契约，不是装饰，要让它真正起作用：

- **改一侧必须改另一侧。** 加字段、删字段、改字段类型、改字段名——Python 和 C++ 两处必须同一次提交一起改。`SYNC` 注释的存在就是为了让 review 时能发现"只改了一侧"。
- **字段顺序保持一致。** JSON 是按键名匹配的，顺序不影响解析，但两侧字段顺序对齐能让 diff 和人工对照更容易，降低看错的概率。
- **默认值两侧对齐。** Python dataclass 字段默认值和 C++ struct 字段默认值必须一致，否则 JSON 里缺这个字段时两侧得到的值不一样，埋下隐性分歧。详见下一节"默认值与缺字段语义"。
- **不要在镜像结构里塞单侧才有的字段。** 如果某字段只有 Python 用、C++ 不需要，不要塞进 `SYNC` 结构——另起一个非镜像的 dataclass。镜像结构必须严格 1:1，否则 `SYNC` 契约失效。
- **命名一致。** 同一个字段 Python 叫 `trading_day`，C++ 就别叫 `tradingDay`，否则 JSON 键对不上，反序列化静默失败或落到默认值。蛇形命名跨两侧通常最省心。

### 默认值与缺字段语义

镜像结构两侧默认值不一致是最隐蔽的跨语言 bug：JSON 里某个字段缺失时（老数据、部分构造、上游没填），Python 和 C++ 各自用自己的默认值补，两边拿到不同的对象继续往下跑，行为分叉却很难发现。前提：**"缺键补默认值"只在 C++ 用 `NLOHMANN_DEFINE_TYPE_NON_INTRUSIVE_WITH_DEFAULT` 宏时存在；`NLOHMANN_DEFINE_TYPE_NON_INTRUSIVE` 缺任意键（包括有默认值的字段）都会直接抛**。规则：

**1. 默认值两侧字面一致。** Python 写 `aum: float = 3e8`，C++ 就写 `double aum{3e8};`，不能一侧 `3e8` 另一侧 `0`。这意味着"有默认值的字段"在两侧都要有默认值、"必填字段"在两侧都无默认值——否则一侧必填一侧可缺，JSON 缺字段时行为就分叉。

**2. 区分"空容器"和"缺省（None/optional）"，两侧语义要对齐。** 这是跨语言最容易错的地方：

- Python `list[T] = field(default_factory=list)`（缺省 = 空列表）↔ C++ `std::vector<T>{}`（缺省 = 空 vector）。语义：字段存在但为空。
- Python `T | None = None`（缺省 = 不存在）↔ C++ `std::optional<T>`（缺省 = `std::nullopt`）。语义：字段可能不存在，存在时才有值。

不要混用这两种语义。同一个字段，Python 用 `None` 默认值而 C++ 用空容器默认值（或反过来），会让 JSON 里没这个键时一侧解释成"空"、一侧解释成"不存在"，下游逻辑分歧。选好一个语义，两侧都按它对齐。

**3. mutable 默认值用 `field(default_factory=...)`。** 这是 dataclass 的硬性要求，不限于跨语言场景，但镜像结构里尤其要检查——Python 直接写 `x: list[str] = []` 会触发共享可变默认值的坑，C++ 侧没有对应概念但容易在对齐时被忽略。容器/字典/可变嵌套 dataclass 一律用 `field(default_factory=...)`。

**4. C++ 侧缺省值的有无和取值都要与 Python 对齐。** "必填字段"在 Python 侧没有默认值，C++ 侧就不要给类内默认值——否则 JSON 里缺这个键时 Python 构造抛 `TypeError`、C++ 却静默用默认值，行为分叉。只对 Python 有默认值的字段给 C++ 类内默认值，且取值字面一致。注意 `WITH_DEFAULT` 宏的一个坑：对没有类内默认值的字段，缺键时会保留字段的默认构造值——裸 `double aum;` 是未定义值，读取即 UB。所以必填字段要么不给默认值并配非 `WITH_DEFAULT` 宏（缺键直接抛），要么显式 `double aum{};` 零初始化并在解析后自行校验存在性。

**5. 改默认值要两侧同提交改。** 默认值是契约的一部分，不只是结构形状。把某字段默认值从 `3e8` 改成 `5e8`，Python 和 C++ 必须一起改，否则"没显式传该字段的旧调用方"两侧行为悄悄分叉。`SYNC` 注释覆盖的不只是字段增删改名，也包括默认值变更。
