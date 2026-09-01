## MODIFIED Requirements

### Requirement: 工作区文件事件同步

系统 SHALL 为会话工作区目录维护**单个**递归文件监听器，把工作区内的文件创建 / 修改 / 删除事件以 `workspace/didChangeWatchedFiles` 批量通知给已启动的语言服务器。事件源不限于本 agent 自己写入的文件。

#### Scenario: 事件类型映射

- **WHEN** 工作区内文件被创建、内容被修改、或被删除
- **THEN** 分别以 `didChangeWatchedFiles` type 1（created）、2（changed）、3（deleted）通知；删除与创建须能区分（底层事件不区分二者时按文件当前是否存在判定）

#### Scenario: 工作区之外不跟踪

- **WHEN** 变更路径不在会话 `cwd` 之内（含服务器 root 位于 `cwd` 之上的情况）
- **THEN** 不产生任何通知，保持现有仅由工具触发的同步行为

#### Scenario: 去抖与批量上限

- **WHEN** 短时间内产生大量事件（安装依赖、构建、分支切换）
- **THEN** 事件合并为有限批次发送；单批超过上限时截断并一次性提示，不逐条刷屏

#### Scenario: 忽略规则

- **WHEN** 事件路径命中内置忽略（`node_modules`、`.git`、`dist`、`build`、`.venv`、`target`、`coverage`）或配置追加的忽略 glob
- **THEN** 不转发该路径

#### Scenario: 忽略目录不创建内核 watch

- **WHEN** 监听器启动时，运行环境支持在 `fs.watch` 层声明忽略列表（Node >= 24.14 / 26）
- **THEN** 内置忽略目录与 `watch.ignore` 命中的目录 SHALL 不创建任何内核级（inotify）watch，其子树内的事件在源头即不产生；即使忽略目录内文件数量巨大，也不得因系统 watch 配额（如 `fs.inotify.max_user_watches`）耗尽而使监听器或进程失败

#### Scenario: 忽略目录内的新建子目录

- **WHEN** 忽略规则命中的目录在监听期间新建了子目录或文件（如 git 操作创建 `.git/index.lock`）
- **THEN** 不为其创建内核 watch，不转发相关事件，监听器保持运行

#### Scenario: 旧运行环境回退

- **WHEN** 运行环境的 `fs.watch` 不支持忽略列表选项
- **THEN** 监听器正常启动并回退为事件层过滤，不因未知选项报错

#### Scenario: 监听器不可用时降级

- **WHEN** 监听器无法启动或中途失败（如系统 watch 资源耗尽）
- **THEN** 关闭该监听器并一次性提示，写后诊断链路保持原有行为，不使工具调用失败

#### Scenario: 生命周期跟随服务器

- **WHEN** 工作区内最后一个服务器 client 关闭（`/lsp-stop`、`/lsp-reload`、session 结束）
- **THEN** 监听器停止；服务器再次启动时重新建立
- **WHEN** 会话工作目录变化
- **THEN** 在新工作目录上重建监听器
