# Tasks

## 1. 宿主侧实现

- [x] 1.1 新增 `src/codemode/fs.ts`：`createCodemodeFs({ policy, reads })` 返回 `{ handles, execute }`；`fs.read` 直接按 UTF-8 读全文（不设大小上限、非 UTF-8 报错、保留 BOM），成功后 `recordRead`；`fs.write` 先 `requireCurrentRead`（文件不存在时跳过）、再 `guardWriteAccess`（`contentOld` 用已读到的内容作 before）、`mkdir -p` 父目录后落盘、最后 `recordRead` 新内容
- [x] 1.2 在 `src/codemode/tool.ts` 里 `createCodemodeTools(pi)` 的 `register(bus, { policy, reads })` 建 fs handler；`onCall` 先走 fs 再走工具总线；工具结果的 `details.reads` 带上本次 fs 产生的已读增量（成功与失败路径都带）
- [x] 1.3 `EXCLUDED_TOOL_NAMES` 加上 `Read` / `Edit` / `Write` 与 `read` / `edit` / `write`
- [x] 1.4 在 `src/index.ts` 把 `services.policy` 与 `fileToolset.reads` 注入 `codemode.register(bus, deps)`
- [x] 1.5 两套文件工具集暴露 `readonly reads: ReadsState`，并把自己传给 `restoreReads` 的工具名集合加上 `"codemode"`
- [x] 1.6 在 `src/codemode/prelude.ts` 暴露 Node 风格的 `fs.read(path)` / `fs.write(path, content)`（过桥仍是可校验的对象），并在 `src/codemode/declarations.ts` 渲染 `declare const fs: {...}`
- [x] 1.7 运行 `pnpm run build:codemode-worker` 重建 `src/codemode/worker.js`
- [x] 1.8 `pnpm exec tsc --noEmit` 与 `pnpm exec eslint .` 通过

## 2. 测试

- [x] 2.1 新增 `test/codemode-fs.test.ts`：原始内容（无行号、不截断）、保留 BOM（指纹与磁盘字节一致）、相对路径按 cwd 解析、大文件不截断、非 UTF-8 报错、未读就写被拒且文件不变、读后外部改动再写被拒、工具读过的文件脚本可以直接写（共用记账）、新建文件 + 自动建父目录、工作区内写入不弹审批、工作区外写入弹审批（含 diff 预览）、审批拒绝后文件不变、headless 与 deny 策略下区外写入直接拒绝、符号链接按链接目标记账、参数校验、未知 fs 操作报错
- [x] 2.2 在 `test/codemode-tool.test.ts` 补：描述里有 `fs` 声明且 `ALL_TOOLS` / call 重载里没有它们；`Read` / `Edit` 不在可调用集合里、`call("Read")` 以 `CallFailedError` 失败且工具未执行；端到端 fs 脚本（读原文 → 写完整个文件）与「fs 失败在脚本里是 CallFailedError」
- [x] 2.3 运行 `pnpm exec vitest run test/codemode-fs.test.ts test/codemode-tool.test.ts test/codemode.test.ts` 通过

## 3. 文档与全量验证

- [x] 3.1 `README.md` 的 codemode 段落补 `fs.read` / `fs.write`（原文读写、写入走 write-guard、与文件工具共享已读记账）与「脚本不能调用文件读写工具」
- [x] 3.2 `pnpm check`、`pnpm lint`、`pnpm test`（1359 passed / 6 skipped）全绿，`openspec validate codemode-fs-io --strict` 通过
- [ ] 3.3 归档顺序：先归档 `codemode-call-structured-results`，再归档本变更（两者改同一条 requirement，见 design D7）
