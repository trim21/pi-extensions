### aft_import tool

语言感知的 import 管理：add / remove。

支持 TS, JS, TSX, Python, Rust, Go, Solidity, Java, C#, PHP, Kotlin, Scala, Swift, Ruby, Lua, C, C++, Perl, Vue。

- `add`：添加默认导入（`default_import`）、具名导入（`names`，支持按名 `as` 别名，如 `['useState']`、`['ERC20', 'IERC20 as IToken']`）、命名空间导入（`namespace`，如 `import * as ns from 'mod'`）。
- `remove`：移除整个 import（只给 `module`），或只移除其中某个具名导入（`remove_name`）。
- 语言相关修饰符用 `modifiers`（如 Java/C# `static`、Swift `@testable`）；符号类导入用 `import_kind`（如 PHP `function`/`const`、Swift `struct`/`enum`）；仅类型导入用 `type_only`（仅 TS）。
- `validate`：编辑后校验级别，默认 `syntax`，`full` 做完整校验。

import 排序整理交给 lint（如 import/order + --fix），本工具不负责排序。写操作走路径级审批。
