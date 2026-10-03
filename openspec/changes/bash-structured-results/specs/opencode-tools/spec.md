# Spec Delta

## MODIFIED Requirements

### Requirement: bash 沙箱执行

命令在 bwrap 沙箱内执行，内置默认超时。工具在保持现有文本输出、`details` 与抛错语义的同时 MUST 声明输出结构，并在命令执行结束（含非零退出、超时、中止）时给出与该结构匹配的载荷（`structuredResult`）：

```ts
{
  exitCode: number | null;
  output: string;
}
```

字段语义与 claude-code 侧 `Bash` 完全一致（脚本换工具集不用改代码）：载荷只有这两个字段，没有 `ok` / `status` 之类的标志；`exitCode` 在被信号终止（超时、中止）或没有退出码时为 `null`；`output` 是命令的**完整**输出（stdout / stderr 已合并，文本被截断时从落盘文件读回全文），MUST NOT 混入工具追加的截断提示、退出码状态行或沙箱状态说明。非零退出 MUST 是成功的结构化结果，现有 `details`（`exitCode` / `truncated` / `fullOutputPath` / `timeout`）与文本 MUST 保持不变。

#### Scenario: 沙箱执行命令

- **WHEN** 执行 bash 命令
- **THEN** 命令在 bwrap 沙箱内运行（文件系统 + 网络隔离按模式生效），内置默认超时，文本与 `details` 与今天一致，同时给出 `{ exitCode, output }` 载荷

#### Scenario: 非零退出码是正常结果

- **WHEN** 命令以非零退出码结束
- **THEN** 载荷的 `exitCode` 就是该退出码，调用本身是成功的，脚本可以据它分支

#### Scenario: 输出被截断时载荷仍是全文

- **WHEN** 命令输出超过上限（文本被截断、完整输出落到文件）
- **THEN** 文本与 `details` 与今天一致，而载荷的 `output` 是完整输出，且不含工具追加的任何提示文本

#### Scenario: 超时与中止

- **WHEN** 命令超过超时上限或被用户中止
- **THEN** 载荷的 `exitCode` 为 `null`、`output` 为已捕获的部分输出（超时与中止的区别在文本与 `details` 里）；文本、`details.timeout` 与沙箱状态提示与今天一致

#### Scenario: 声明结构不改变既有输出

- **WHEN** 比较改动前后的同一条命令结果
- **THEN** 文本、`details` 与失败时的抛错行为都逐字/逐语义不变
