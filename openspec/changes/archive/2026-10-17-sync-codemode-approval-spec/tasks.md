# Tasks

## 1. spec 同步

- [x] 1.1 `openspec/specs/codemode/spec.md` 的 Purpose 去掉「含各自的审批」，改为需要授权的调用在脚本内直接失败。
- [x] 1.2 delta 的「脚本文件原语」改为工作区外 `fs.write` 直接以 `CallFailedError` 失败，不弹审批。

## 2. 验证

- [x] 2.1 `openspec validate sync-codemode-approval-spec --strict` 通过。
- [x] 2.2 确认本 change 不涉及代码与测试改动。
