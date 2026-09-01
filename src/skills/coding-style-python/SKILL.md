---
name: coding-style-python
description: Use when 编写、生成、修改、编辑、重构或评审任何 Python 代码——涵盖实现功能、修 bug、写脚本、写测试、性能优化、代码迁移、重命名、加减参数或函数、修改函数签名、定义类型、dataclass、处理函数间数据流、JSON 反序列化、pydantic、code review / PR review。任何会产出或改动 Python 代码的任务（write / edit / refactor / review Python code）都要先加载本 skill，即使用户没有提到风格、规范或最佳实践。只读调查不加载：单纯 debug、定位代码、定位问题、读代码理解逻辑等不改代码的任务不需要加载。
---

# Python 编码风格

**REQUIRED BACKGROUND：先加载 `coding-style`（shared）**——语言无关的原则与"为什么"在那里，章节序号与本文件对应；本文件只放 Python 侧的具体写法。

---

## 1. 函数边界容器：dataclass 与 NamedTuple

### 什么时候用 dataclass，什么时候用 NamedTuple

两者都能满足"显式类型 + 字段命名"的核心要求，并且都默认不可变（dataclass 按本 skill 一律带 `frozen=True`，见下文同名小节），所以**可变性不是判别依据**——数据会变就用 `dataclasses.replace` 产出新对象。**默认用 dataclass**：它未来加字段、方法、默认值的阻力最小；NamedTuple 只在有特定理由时才用（见下）。

**默认用 `dataclass(frozen=True, kw_only=True)`：**

```python
from dataclasses import dataclass, field

@dataclass(frozen=True, kw_only=True)
class Position:
    symbol: str
    quantity: int
    avg_price: float
    realized_pnl: float = 0.0
    tags: list[str] = field(default_factory=list)

    def market_value(self, price: float) -> float:
        return self.quantity * price
```

特点：不可变（配合 `dataclasses.replace` 表达状态变化）、支持默认值、可挂方法、可继承。适合带方法、带默认值的对象——账户、持仓、配置、累加器。加字段、加方法、加默认值的阻力最小，所以是默认选择。

**`NamedTuple` 只在有特定理由时用：**

```python
from typing import NamedTuple

class Point(NamedTuple):
    x: float
    y: float

class TradeKey(NamedTuple):
    symbol: str
    side: str  # "buy" / "sell"
    trading_day: int
```

特定理由：

- **序列化语义要求 JSON array。** NamedTuple 是 `tuple` 子类，序列化库会把它转成数组；dataclass 的 `asdict()` 产出的是对象。跨边界协议约定要数组时，用 NamedTuple。
- **需要位置访问/解包。** 调用方要 `p[0]`、`x, y = p` 这种用法时（见本节末尾的注意）。
- **内存/性能敏感的大批量小记录。** NamedTuple 带 `__slots__` 语义，比 dataclass 省内存。

特点：不可变（天然线程安全、可哈希、可作 dict key）、内存占用小。适合那些"本质是一个带名字的元组"的记录型数据——一旦创建就不该改，改了就语义上是另一个值。

**一句话判断：** 没有特定理由就用 dataclass（`frozen=True, kw_only=True`）；只有上面列出的理由成立时才用 NamedTuple。不确定时一律 dataclass。dataclass 的默认参数配置见下文"默认用 `frozen=True, kw_only=True`"。

**`frozen=True` dataclass 是 NamedTuple 的可扩展替代：** 想要不可变但又预见到以后要加方法/默认值，用 `@dataclass(frozen=True)`，不要硬上 NamedTuple 然后受困于它的局限。

**NamedTuple 的位置访问与解包：** `p[0]`、`x, y = p` 是 NamedTuple 的事实特性，在字段少、上下文明确时是便利；但字段多或跨函数传递时优先用属性名——字段顺序变化时解包不会报错，只会静默错位。构造 NamedTuple 时始终用关键字参数（`ParsedOrder(symbol=..., quantity=..., price=...)`），别按位置传参。

### 反模式

下面这些写法都是函数边界上的 `Any` 传递，应该替换成 typed 容器。

#### 反模式 1：裸 dict 作为参数 / 返回值

```python
# 不要这样
def fetch_position(symbol: str) -> dict:
    return {"symbol": symbol, "quantity": 100, "avg_price": 12.5}

def summarize(pos: dict) -> str:
    return f"{pos['symbol']}: {pos['quanitity']}"  # 拼写错误，运行时才炸
```

```python
# 这样写
@dataclass(frozen=True, kw_only=True)
class Position:
    symbol: str
    quantity: int
    avg_price: float

def fetch_position(symbol: str) -> Position:
    return Position(symbol=symbol, quantity=100, avg_price=12.5)

def summarize(pos: Position) -> str:
    return f"{pos.symbol}: {pos.quantity}"  # 拼写错误，类型检查直接报
```

#### 反模式 2：`dict[str, Any]` / `list[dict]` 作为函数签名

`dict[str, Any]` 本质就是"一个我想不清楚形状的结构"。如果这个结构在多个函数间流转，它就是一个匿名 dataclass，请给它起名字。

```python
# 不要这样
def enrich_trades(trades: list[dict[str, Any]]) -> list[dict[str, Any]]:
    ...
```

```python
# 这样写
@dataclass(frozen=True, kw_only=True)
class Trade:
    symbol: str
    price: float
    quantity: int
    timestamp: int

@dataclass(frozen=True, kw_only=True)
class EnrichedTrade:
    trade: Trade
    notional: float
    venue: str

def enrich_trades(trades: list[Trade]) -> list[EnrichedTrade]:
    ...
```

#### 反模式 3：裸 tuple 返回多值

```python
# 不要这样：返回元组，调用方得数位置，改返回结构时所有调用方都得改
def parse_order(s: str) -> tuple[str, int, float]:
    symbol, qty, price = s.split(",")
    return symbol, int(qty), float(price)
```

```python
# 这样写
@dataclass(frozen=True, kw_only=True)
class ParsedOrder:
    symbol: str
    quantity: int
    price: float

def parse_order(s: str) -> ParsedOrder:
    symbol, qty, price = s.split(",")
    return ParsedOrder(symbol=symbol, quantity=int(qty), price=float(price))
```

如果你确有理由用 NamedTuple（比如序列化时要求 JSON array），从裸 tuple 迁移到 NamedTuple 的成本几乎为零——调用方 `symbol, qty, price = parse_order(s)` 和 `order.symbol` 两种写法都成立，但拿到了命名和类型。没有这类理由时，默认用 dataclass（见上）。

#### 反模式 4：`Any` 显式标注的参数

```python
# 不要这样
def transform(data: Any) -> Any:
    ...
```

`Any` 等于"我放弃对这段数据做任何约束"。如果 `data` 真的可以是任意类型，那通常说明这个函数职责太宽，应该拆分或用泛型（`TypeVar`）；如果 `data` 实际上有固定形状，就给它一个类型。

这个反模式不包括序列化/反序列化/校验函数：它们本来就该是"从 `Any` 到 typed 容器"（把外部原始数据解析进内部）或"从 typed 容器到 `Any`"（序列化输出），`Any` 只出现在边界、不参与内部流转，符合 `coding-style` 第 1 节"合理的例外"里"与外部边界交互"一条。

```python
# 泛型版本：当函数对多种具体类型做同样的操作
from typing import TypeVar, Type
T = TypeVar("T")

def clone(data: T) -> T:
    ...

# 或者：当 data 有固定形状，就给它命名
@dataclass(frozen=True, kw_only=True)
class TransformInput:
    ...

def transform(data: TransformInput) -> TransformResult:
    ...
```

#### 反模式 5：`**kwargs: Any` 收口不确定参数

```python
# 不要这样：调用方完全不知道能传什么，实现方完全不知道会收到什么
def run_strategy(config: dict[str, Any], **params: Any) -> Any:
    ...
```

```python
# 这样写
@dataclass(frozen=True, kw_only=True)
class StrategyConfig:
    lookback: int
    threshold: float
    symbols: list[str]

def run_strategy(config: StrategyConfig) -> StrategyResult:
    ...
```

如果确实需要"可选、可扩展"的参数传递（比如插件式配置），优先用嵌套 dataclass 或 `kw_only` dataclass，而不是 `**kwargs: Any` 黑洞。

**兼容性场景可以保留。** 公共 API 演进时，为了不破坏老调用方——他们可能还传着已废弃的参数——保留 `**kwargs: Any` 吸收未知参数是合理的。但已知参数仍然用显式参数接收，`**kwargs` 只负责接住并忽略旧参数，不作为新功能的入口。

### dataclass 默认用 `frozen=True, kw_only=True`

（`kw_only` 需要 Python 3.10+，本 skill 默认在此版本之上，不做旧版本兼容。）

定义 dataclass 时，默认带上这两个参数：

```python
from dataclasses import dataclass

@dataclass(frozen=True, kw_only=True)
class Position:
    symbol: str
    quantity: int
    avg_price: float
```

#### 为什么 `kw_only=True`

位置参数是隐式契约，而且是个脆弱的契约。

- **防同类型字段传错位置。** `Position("AAPL", 100, 12.5)` 里字段顺序错了，类型检查只有在类型不匹配时才报；如果两个字段类型相同（比如 `x: float, y: float`），位置传反了类型检查发现不了，运行时也不报，语义就静默错了。`kw_only` 强制 `Position(symbol="AAPL", quantity=100, avg_price=12.5)`，字段名显式出现在调用点，传错立刻可见。
- **字段增删/重排不破坏调用方。** 位置参数的 dataclass 一旦加字段、删字段、调顺序，所有按位置构造的调用点都得改，而且类型检查未必能全兜住（尤其是同类型字段）。`kw_only` 让字段顺序变得无关，加字段只要给默认值就不影响老调用方。
- **可读性。** 构造点自带字段名，读到 `Position(symbol=..., quantity=..., avg_price=...)` 不用跳回定义就知道每个值的含义。

#### 为什么 `frozen=True`

可变性是 dataclass 默认行为里最容易引入 bug 的一个。

- **防止共享数据被意外修改。** 一个 `Position` 对象穿过 fetch → enrich → persist 三个函数，中间某个函数顺手 `pos.quantity += 10` 改了它，上游调用方如果还持有引用，看到的数据就变了，而且毫无痕迹。`frozen` 让这种修改在赋值时直接抛 `FrozenInstanceError`，而且 mypy / pyright 在静态检查时就会对这类赋值报错（`Cannot assign to attribute ...`）——错误在编译期就暴露，不用等到运行时；运行时异常则是最后一道兜底。双重保障逼你显式"构造一个新对象"来表达状态变化——这正是数据流清晰的写法，也和 `coding-style` 第 1 节"函数间传递的是值不是状态"的理念一致。
- **可哈希。** `frozen` dataclass 在字段都可哈希时默认可哈希，能当 dict key、放 set、做缓存键。可变 dataclass 不行。
- **并发安全。** 不可变对象天生线程安全，跨函数、跨线程传递时不用担心竞态。

注意：`frozen` 冻结的是属性赋值，不冻结容器字段的**内容**——`pf.positions["X"] = pos` 照样能改 dict，不会抛 `FrozenInstanceError`。需要整体不可变时，容器字段用 `tuple` / `frozenset`；否则接受该字段可变，状态变化通过 `replace` + 重建容器表达（见下方示例），而不是就地改容器内容。

#### "状态会变"不是放开 frozen 的理由

最常见的放开 `frozen` 的冲动是"这个对象的状态会变"——累积器、随事件增长的状态、逐步填充的构建器。但这恰恰是应该坚持 frozen 的场景，因为 `dataclasses.replace` 让"用新对象表达状态变化"几乎没有代价：

```python
from dataclasses import replace

@dataclass(frozen=True, kw_only=True)
class Portfolio:
    positions: dict[str, Position] = field(default_factory=dict)
    realized_pnl: float = 0.0

# "更新"状态 = 产出新对象，原对象不变
def add_position(pf: Portfolio, pos: Position) -> Portfolio:
    return replace(pf, positions={**pf.positions, pos.symbol: pos})

def realize(pf: Portfolio, pnl: float) -> Portfolio:
    return replace(pf, realized_pnl=pf.realized_pnl + pnl)
```

### 与类型检查工具配合

本 skill 的价值依赖类型检查器把守边界。实操建议：

- 函数签名上必须有返回类型标注。无返回类型标注的函数，调用方拿到的就是 `Any`，typed 容器的传递链就断了。哪怕函数体很难标全，先把签名标上。
- 在 `mypy` / `pyright` 配置里启用 `disallow_untyped_defs` 或等价选项，让无标注的函数签名在 CI 里报错，从制度上阻止 `Any` 回潮。
- 对 `dict[str, Any]` 这类签名，可以配 `warn_return_any` 让它显眼。

类型检查工具是本 skill 的执行机构；skill 定义规范意图，工具把意图变成可强制检查的约束。

---

## 2. 边界校验与"构造即合法"的 Python 写法

原则见 `coding-style` 第 2 节；下面是各场景的 Python 代码。

**场景一：把已经构造好的结构化数据在类型上确定下来。** 有 pydantic 这类成熟校验库时，从 dict 一步解析，不手写逐字段检查：

```python
from typing import Annotated
from pydantic import Field, TypeAdapter

# 边界：解析外部配置
@dataclass(frozen=True, kw_only=True)
class Position:
    symbol: str
    quantity: Annotated[int, Field(ge=0)]     # 内部约定：>= 0，pydantic 在边界强制执行
    avg_price: Annotated[float, Field(gt=0)]  # 内部约定：> 0

_PositionAdapter: TypeAdapter[Position] = TypeAdapter(Position)

def parse_position(raw: dict[str, Any]) -> Position:
    # 在边界一次性校验，不合法就抛 ValidationError，不让坏数据进入内部
    return _PositionAdapter.validate_python(raw)

# 内部：信任 Position 已经合法，不再重复校验
def market_value(pos: Position, price: float) -> float:
    return pos.quantity * price  # 不写 if pos.quantity < 0: raise
```

**能由类型保证的，就不要靠运行时检查：**

```python
# 不要：靠约定 + 运行时检查保证取值合法
@dataclass(frozen=True, kw_only=True)
class Order:
    side: str  # 约定只能是 "buy"/"sell"，但 str 类型本身不保证
    # ... 每个用到的地方都 if order.side not in ("buy", "sell"): raise

# 这样：用枚举把"非法取值"变成"构造不出来"
from enum import Enum
class Side(Enum):
    BUY = "buy"
    SELL = "sell"

@dataclass(frozen=True, kw_only=True)
class Order:
    side: Side  # 传非法值类型检查器直接在调用点报错（arg-type），后续免检
```

**场景二：自己拼接结构化数据——先逐个构造字段值，最后拼装成对象：**

```python
# 不要：构造时数据可能非法，指望后面修正
order = Order(side="maybe_invalid", quantity=-1)
normalize(order)  # 事后修正，万一没调用到呢？提前 return 呢？

# 要：每个值独立构造/校验，最后纯组合
def make_order(raw: dict) -> Order:
    side = Side(raw["side"])            # 非法值在这一步就抛
    quantity = _validate_quantity(raw["quantity"])
    price = _validate_price(raw["price"])
    return Order(side=side, quantity=quantity, price=price)
```

---

## 3. JSON 反序列化分两层（pydantic TypeAdapter + stdlib dataclass）

原则见 `coding-style` 第 3 节；Python 侧的选型与写法如下。

### 优先用 stdlib dataclass + pydantic 校验引擎，而不是 BaseModel

两层都用 stdlib `@dataclass`：原始 schema 也是 `@dataclass`，pydantic 只作为校验引擎在解析瞬间起作用，校验完产出的是普通 stdlib dataclass 实例。不要用 pydantic `BaseModel` 做原始 schema，除非有具体理由。

为什么优先 stdlib dataclass：

- **两层一致。** 原始 schema 和内部模型都是 stdlib dataclass，同样的 `frozen`/`kw_only`/`field(default_factory=...)` 规则适用，读代码不用在两套类型系统之间切换。`BaseModel` 有自己的构造、继承、`model_config`、`model_dump` 等语义，混进来增加心智负担。
- **校验是瞬时动作，类型是长期契约。** pydantic 的价值集中在"从 dict 到 typed 对象"这一步；对象一旦构造出来，后续传递靠的是 stdlib dataclass 的类型标注，不需要 pydantic 的运行时开销和方法。用 `TypeAdapter` 把 pydantic 当工具调用，而不是让 `BaseModel` 污染整个数据模型。
- **字段级 pydantic 配置用 `Annotated` 注入。** 需要别名、约束等 pydantic 特有配置时，用 `Annotated[T, pydantic.Field(alias=...)]` 写在类型标注上，不引入 `BaseModel`。类型标注仍然是 stdlib 类型，pydantic 元数据是附加层，mypy/IDE 仍然按 stdlib 类型理解。

什么时候才用 `BaseModel`：需要 pydantic 的高级特性（ORM 模式、`model_dump` 的复杂序列化控制、字段方法、动态模型生成等），且 stdlib dataclass + `TypeAdapter` 无法覆盖。这是少数情况，多数"校验 dict → 对象"的需求 `TypeAdapter` 已经够用。

### 怎么做

```python
from dataclasses import dataclass, field
from pathlib import Path
from typing import Annotated
import json
from pydantic import Field, TypeAdapter

# — 第 1 层：原始 schema，1:1 对应配置文件形状（stdlib dataclass）—
@dataclass(frozen=True, kw_only=True)
class RawStrategyConfig:
    """忠实镜像配置文件 schema。字段与文件里的键 1:1 对应，不做业务转换。"""
    lookback: int
    # 外部键用 snake_case 以外的写法时，用 Annotated 注入 pydantic alias，
    # 类型标注仍是 stdlib int，不引入 BaseModel
    threshold: Annotated[float, Field(alias="thresh")]
    symbols: list[str]
    # 新加字段：用默认值表达"外部可以没有"，兼容旧配置文件
    venue: str | None = None
    fee_bps: float = 0.0

_RawAdapter: TypeAdapter[RawStrategyConfig] = TypeAdapter(RawStrategyConfig)

def load_raw_config(path: str) -> RawStrategyConfig:
    raw = json.loads(Path(path).read_text())
    # pydantic 按类型标注校验、类型转换、错误聚合，返回 stdlib dataclass 实例
    return _RawAdapter.validate_python(raw)

# — 第 2 层：内部模型，加载时转换得到 —
@dataclass(frozen=True, kw_only=True)
class StrategyConfig:
    lookback: int
    threshold: float
    symbols: tuple[str, ...]      # 内部要不可变，转成 tuple
    venue: str                    # 内部不接受 None，转换时给默认/报错
    fee_rate: float               # 派生字段：bps → 比率

def to_internal(raw: RawStrategyConfig) -> StrategyConfig:
    # 类型安全的转换：全程操作对象字段，有类型标注兜底
    venue = raw.venue if raw.venue is not None else "default_venue"
    return StrategyConfig(
        lookback=raw.lookback,
        threshold=raw.threshold,
        symbols=tuple(raw.symbols),
        venue=venue,
        fee_rate=raw.fee_bps / 1e4,
    )

def load_config(path: str) -> StrategyConfig:
    return to_internal(load_raw_config(path))
```

要点：

- **两层都用 stdlib `@dataclass(frozen=True, kw_only=True)`。** 原始 schema 和内部模型遵循同一套规则，pydantic 只在 `validate_python` 那一瞬间起校验作用，产出的是普通 dataclass。不要把内部模型也做成带验证逻辑的 pydantic 模型到处传——那是把外部 schema 的包袱带进内部。
- **pydantic 通过 `TypeAdapter` 当校验引擎，不通过 `BaseModel`。** `TypeAdapter[T]` 能校验任意 stdlib 类型（含 dataclass），校验完返回该类型的普通实例。模块级建一个 `TypeAdapter` 复用，不要每次解析都新建。
- **字段级 pydantic 配置用 `Annotated[T, pydantic.Field(...)]`。** 别名、数值约束、描述等写在类型标注里：`Annotated[int, Field(alias="thresh", ge=0)]`。类型标注仍是 stdlib 类型，pydantic 元数据是附加层，对类型检查器透明。
- **可选字段的语义就是"有默认值"。** 在原始 schema 里，一个字段是否可选由它有没有默认值决定——有默认值的字段，外部 dict 里可以不出现对应的 key，解析时用默认值补上；没有默认值的字段是必填，缺 key 就报错。由此推出一条硬性约束：**新增可选字段时必须带默认值**，否则旧配置文件会因为缺这个 key 而解析失败，破坏向后兼容。反过来，想从"可选"改成"必填"也要谨慎——原本可不带的旧数据会突然变非法。
- **转换函数从原始 schema 产出内部模型。** 需要合并多个来源（比如配置文件 + 命令行 + 环境变量）时，让转换函数接收多个原始 schema 参数，合并逻辑集中在这一处。
- **原始 schema 声明哪些字段，看 schema 归谁控制：我们定义的（配置文件）写全支持的项，上游控制的（API 响应、消息、DB 原始行）只写代码读取的项。** 未声明的键两种情况都靠解析库默认忽略，不为此加配置。详见下一小节。
- **不要跳过第一层直接 dict → 内部模型。** 即使外部形状和内部形状恰好相同，也保留原始 schema 这一层——它把"外部形状"作为可追踪的契约固化下来。一旦未来外部形状和内部形状分叉（几乎必然发生），你有一个明确的层去改，而不是去改散落各处的 `raw["key"]`。
- **用成熟校验库，不要手写解析。** pydantic、msgspec 都可以，选项目已在用的。手写 `isinstance` + `get` + 逐字段构造的解析代码是 bug 温床（缺字段静默用默认、类型不匹配静默通过、错误信息零散），成熟库替你处理这些并把错误信息聚合抛出。

### 原始 schema 声明哪些字段：代码示例

第 1 层该声明哪些字段的判断标准（我们控制的声明完整 / 上游控制的只声明读到的）见 `coding-style` 第 3 节。落到 Python 侧：

```python
# 上游控制：只声明代码读取的字段，响应里其余几十个键都不进 schema
@dataclass(frozen=True, kw_only=True)
class RawOrderRow:
    order_id: str
    status: str
    fills: list[RawFill]  # 嵌套同样只声明读到的那条路径
    # 签名、内部 ID、我们从不读的上游字段一概不写：
    # 它们怎么变都不该让我们的解析抛错
```

我们控制的那一侧就是上面"怎么做"里的 `RawStrategyConfig`：配置文件支持的配置项一个不漏地声明，新加的可缺省项带默认值，让旧文件继续解析得了。两个类长得像，取向相反。

两种归属共用的规则：

- **未声明的键靠解析库默认忽略，不为此写任何配置。** 这个默认值对两边都恰好正确：上游一定会加我们从不读的字段；配置文件里的多余键要么键名拼错了，要么属于同一份文件里别的组件的段落，都轮不到 schema 来否决。给配置那一层加 `extra="forbid"` 看着能抓拼写错误，代价是把"还没升级的旧代码读带新键的配置"也变成启动失败——灰度、回滚、多个组件共用一份配置都依赖这个方向；而拼错的键本来就会以"某个行为没按预期发生"的形式暴露在运行日志里，比让进程起不来便宜得多。真要做未知键诊断，写成显式的 warning 检查，不要写成 schema 的硬约束。
- **字段少不等于可以省校验。** 声明出来的字段仍按"数据合法性检查外推到系统边界"写约束（`Annotated[T, Field(...)]`）；"可选"仍然表现为有默认值。

确有特殊需求时才偏离这两种默认做法，且把偏离的理由写进注释：

- **我们控制的配置需要读进来、改几个键再原样写回**（配置文件的读写往返工具）：这时才需要显式持有未知键（`extra="allow"` + pydantic 的 `model_extra`），不要为了"能存住"就逐个猜字段。更常见的解法是让每个组件只读写自己那一段，不做整文件往返。
- **上游数据要全字段落盘 / 审计**（数据本身就是产品）：直接保留原始 dict 或原始 bytes，别把上游全部字段抄成 dataclass——那还是一份会腐烂的文档，只是多了一层转换。
- **就是要主动探测上游新增字段**：显式 `extra="forbid"`，并在注释里写明这是"上游一动我就报错"的有意选择。
- **Python ↔ C++ 跨语言镜像结构不属于这两种归属**：那是我们自己两侧维护、两侧都读的契约，必须严格 1:1，写法见 `coding-style-ffi`。

---

## 4. 文件读写：简单单次读写用 `Path.read_text` / `read_bytes`

简单的单次文件读写（整个文件一次读入、整个文件一次写出），优先用 `pathlib.Path` 的 `read_text` / `read_bytes` / `write_text` / `write_bytes`，不要用裸 `open`：

```python
from pathlib import Path

# 这样：一次读完，自带关闭
content = Path("config.json").read_text(encoding="utf-8")
Path("out.txt").write_text(content)

# 不要这样：要自己管 with 块
with open("config.json", encoding="utf-8") as f:
    content = f.read()
with open("out.txt", "w", encoding="utf-8") as f:
    f.write(content)
```

为什么：

- **没有资源管理负担。** `read_text` 自己处理打开、读取、关闭，不存在漏 `close` / 忘 `with` 的资源泄漏；`open` 必须配 `with` 或手动关闭，是多出来的心智负担。
- **编码显式写在调用点。** `Path.read_text(encoding="utf-8")` 的编码是调用点上的显式参数；`open` 不写 `encoding` 时依赖 locale，跨机器行为不一致，而 `read_text` 的形式逼你在每个调用点决定。
- **返回 str / bytes 一步到位。** `read_text` 直接返回解码后的 `str`、`read_bytes` 直接返回 `bytes`，不用在 `f.read()` 之后再处理类型问题。

什么时候该用 `open`：大文件流式处理（逐行、逐块读，不能一次全部载入内存）、追加写（`"a"` 模式）、同时读写、自定义缓冲——`Path` 的便捷方法覆盖不了的场景。这些场景下 `open` + `with` 仍然是对的，规则只约束"简单单次读写"。
