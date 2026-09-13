## MODIFIED Requirements

### Requirement: 工作区文件事件同步

系统 SHALL 为当前活跃服务器实例的项目根维护递归文件监听器，把监听范围内的文件创建 / 修改 / 删除事件以 `workspace/didChangeWatchedFiles` 批量通知给已启动的语言服务器。事件源不限于本 agent 自己写入的文件。同一目录只监听一次：被其他活跃 root 包含的 root 不单独建立监听器；root 不在会话 cwd 内时退化为监听 cwd。

#### Scenario: 事件类型映射

- **WHEN** 监听范围内文件被创建、内容被修改、或被删除
- **THEN** 分别以 `didChangeWatchedFiles` type 1（created）、2（changed）、3（deleted）通知；删除与创建须能区分（底层事件不区分二者时按文件当前是否存在判定）

#### Scenario: 工作区之外不跟踪

- **WHEN** 变更路径不在会话 `cwd` 之内（含服务器 root 位于 `cwd` 之上的情况）
- **THEN** 不产生任何通知，保持现有仅由工具触发的同步行为

#### Scenario: 按活跃项目根限定监听范围

- **WHEN** 活跃 client 的 root 是会话 cwd 的子目录（`rootMarkers` / `workingDir` 场景）
- **THEN** 只对活跃 root 建立递归监听器，cwd 下没有活跃 client 的其他目录 MUST NOT 产生任何文件监听；投递仍按各 client 的 root 与注册 pattern 过滤
- **WHEN** 多个活跃 client 的 root 存在包含关系（如 `/repo` 与 `/repo/packages/a`）
- **THEN** 只监听最外层 root，不为被包含的 root 重复建立监听器

#### Scenario: 去抖与批量上限

- **WHEN** 短时间内产生大量事件（安装依赖、构建、分支切换）
- **THEN** 事件合并为有限批次发送；单批超过上限时截断并一次性提示，不逐条刷屏

#### Scenario: 忽略规则

- **WHEN** 事件路径命中内置忽略（`node_modules`、`.git`、`dist`、`build`、`.venv`、`target`、`coverage`）或配置追加的忽略 glob
- **THEN** 不转发该路径

#### Scenario: 监听器不可用时降级

- **WHEN** 监听器无法启动或中途失败（如系统 watch 资源耗尽）
- **THEN** 关闭该 root 的监听器并一次性提示，写后诊断链路保持原有行为，不使工具调用失败
- **WHEN** 失败原因是资源耗尽（ENOSPC / EMFILE 等系统级限制）
- **THEN** 在 `/lsp-reload` 之前不再为该 root 重建监听器（重试前须先提高系统限制）

#### Scenario: 生命周期跟随服务器

- **WHEN** 服务器 client 启动
- **THEN** 其项目根纳入监听范围（已被其他 root 覆盖时不重复监听）
- **WHEN** 工作区内最后一个使用某 root 的服务器 client 关闭（`/lsp-stop`、`/lsp-reload`、session 结束）
- **THEN** 该 root 的监听器停止；服务器再次启动时重新建立
- **WHEN** 会话工作目录变化
- **THEN** 按新的 cwd 重算监听范围
