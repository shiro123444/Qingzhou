# Harness 独立环境、真实对照与资料生命周期验收

日期：2026-10-22。接续 A–E 的原生 Cordis 组合，不引入第二套 agent 执行内核。本轮完成工程与对照验证设施；**真实质量提升仍未成立，不能视为整个 Qingzhou 已完成生产验收**。

## 工程基线与运行环境

本 checkout 已安装自身依赖，独立数据库角色及数据库、对象存储实例/桶、文件根和 Redis 前缀均与原环境隔离。完整迁移已执行到 0111。原先借用依赖造成的缺失及两处类型错误已修复；`pdf-lib` 原本就在清单中，未添加重复依赖。

私有配置位于 `.data/acceptance/runtime.env`（0600），不入库。测试账号由正常 BetterAuth 注册/密码登录创建；为直达功能页，账号引导完成状态作为测试前置数据准备，这不构成引导流程验收。已在浏览器进入助理档案 → 进阶配置 → 自我迭代，读取真实模型结果，验证未通过的候选不可采用，并实际点击保留原方案。PostgreSQL 发布 generation 从 1 变为 2，active 候选仍为空，作者指令保持不变。

已有私有环境准备完成后，可用以下命令启动：

```bash
node --import tsx scripts/harnessAcceptanceDev.mts
```

脚本仅接受隔离验收数据库与文件根，先检查 3310/9876 端口，再运行 Next 和 Vite；退出时只停止自己创建的子进程。访问 `http://localhost:3310`，日志在 `.data/acceptance/next.log` 和 `vite.log`。不通过 Node `--env-file` 启动 Next 子进程，避免 Next 重启时将该参数复制到 `NODE_OPTIONS`。

## 真实模型结果及证据边界

预登记总上限为 18 次调用，最终实际准入 13 次，其中 1 次鉴权失败，12 次取得真实输出。三个记录分别保留于 `live`、`live-keep`、`live-keep-repaired`，没有覆盖失败记录、复用已暴露的留出题或重放未知尝试。累计保守计账为 650000 costMicros（0.65 美元），这是预约计账，**不是供应商账单**。

- 首轮使用真实 DeepSeek、AgentRuntime/Cordis 上下文、数据库预算和发布事务，完成 3 次试跑调用及 6 次留出验证调用。三次匿名判断为候选、原方案、候选；未满足全部通过门槛，持久化选择为保留原方案。
- 首轮验证后再次登记相同留出题，被污染防护拒绝，没有产生额外调用。验收脚本已改为每次只登记一个候选，重复运行同一预登记目录会停止。
- 退化候选试跑首次因为取用了不同的现有凭据而收到 401；该尝试保留失败与预约，未重放。恢复原先可用的凭据后，单独预登记了最多 3 次调用的保留路径，匿名判断选择原方案，正常保存明确选择。该批未运行留出验证，状态仍为 pending，不能采用。
- 这些是合成、受控任务。两边答案以及匿名评价均出现计算或歧义处理瑕疵；部分候选回答达到 512 token 上限。匿名选择不等于事实正确性，也不证明通用能力提升。

实际付费对照未产生可采用版本，因此**真实模型胜出后的采用、新旧实际对话切换、回滚仍未得到这次付费运行的正向证据**。对应协议由定向测试及 PostgreSQL 进程测试覆盖，不能替代真实质量验收。下一批应先预登记更清楚的任务边界与适配短输出的候选，再使用新的留出题验证；本轮不追加预算追逐胜出结果。

## 同机 PostgreSQL 多进程

`scripts/harnessAcceptancePostgres.mts` 使用实际 PostgreSQL 与独立 Node 子进程；已在独立的 process 数据库/文件命名空间运行。8 项检查包括：

1. 两进程竞争分配，不能超订父预算。
2. 派发后 SIGKILL，预约保持 reserved，稳定尝试身份禁止重放。
3. 另一进程取消在途工作，迟到结果被拒收。
4. 两进程同时采用，仅提交一个决定与 generation。
5. 已准备的 proof 在另一进程取消后不能提交。
6. outbox 派发进程死亡、租约到期后，两名恢复 worker 中只有一名接手。
7. 账号封写后，另一进程新建根预算被拒绝，不能绕过对已有预算的取消。
8. 删除请求持久化；活账号不擦除、另一进程持有租约时不擦除，持有者死亡后新 worker 完成擦除。

采用事务测试使用确定性输出构造 proof，不调用付费模型。SIGKILL 派发测试同样使用可控制回调，验证真实跨进程账本，不声称模拟了供应商端扣费。outbox 整体语义是至少一次；订阅者仍须以 scope + event ID 去重，不能把一次租约内的排他投递解释为永久恰好一次。

运行命令（私有 `process.env` 已由验收环境初始化）：

```bash
node --env-file=.data/acceptance/process.env --import tsx scripts/harnessAcceptancePostgres.mts
```

## 生命周期与部署契约

`qingzhou.improvement.maintenance` 是原生 Cordis 服务。启用后由 Node instrumentation 在服务器启动时挂载，周期任务受 `ctx.effect` 管理，卸载会停止定时器并等待本轮结束。它扫描未投递 outbox，调用已有带 token/过期租约的投递逻辑；恢复通知不会再调用模型，也不能撤销已提交的用户决定。

需要显式配置：

```dotenv
QINGZHOU_HARNESS_LEARNING_ENABLED=1
QINGZHOU_HARNESS_DATA_ROOT=/persistent/qingzhou/harness
QINGZHOU_LEARNING_LIFECYCLE_ROOT=/persistent/qingzhou/learning-lifecycle
CORDIS_PRESENTATION_DATA_DIR=/persistent/qingzhou/presentation
QINGZHOU_LEARNING_WORKER=1
QINGZHOU_HARNESS_RETENTION_DAYS=90
# 可选：指定本机 Python；默认 python3
QINGZHOU_FILE_LOCK_PYTHON=python3
```

生命周期当前要求 POSIX 文件锁和 Python。作用域写入、后台 worker、删除入口应使用同一持久卷及配置。启用生命周期后，文件作用域的 OS 锁随进程死亡释放；未配置生命周期的既有部署继续使用原先独占文件锁和显式陈旧锁恢复策略，不给普通 Chat 增加 Python 依赖。PPT 原有执行租约继续通过同一底层锁能力工作。启用/回退文件锁模式前应停止全部旧写入进程；混用旧独占文件锁与新 OS 锁的滚动迁移不在当前支持契约内，回退时需先按旧策略核对残留锁。

BetterAuth 的删除入口仅在生命周期根已配置时启用，保留正常密码/新鲜会话校验。预算读取/准入也检查账号封写状态，删除期间不能另开根预算派发工作。删除钩子先登记经所有者包络验证的旧目录、持久化封写标记并取消学习预算；数据库删除失败时不擦除文件，重试删除可复用请求。只有用户行确实不存在，worker 才尝试擦除。

所有者索引由可信存储构造器登记，API 不接受任意磁盘路径。范围包括完整 harness 状态、PPT 工作资料、试跑工作区/原始运行/快照/预览/评价/学习记录、留出验证、能力记忆、用户模板及教学记忆。清理时验证配置根、所有者摘要、索引身份与符号链接边界。先等在途共享租约释放，再把目录移入隔离区、在旧根留下零字节文件栅栏并删除隔离区。即便不配合的迟到写入尝试重建目录，也会失败；中途崩溃留下的隔离区会在下次恢复时清理。完成后移除所有者明细和含用户 ID 的临时记录，只保留匿名完成标记及空栅栏。

删除 API 返回数据库删除成功不等于磁盘清理已同步完成；在途任务或正进行的维护轮次可能使其暂时 pending。已通过真实密码鉴权的 `/api/auth/delete-user` 完成一次性账号删除，并确认后续 worker 完成磁盘擦除，迟到 mkdir 失败，其他账号的源方案仍在。

旧资料回填依赖可验证的 scope/摘要：不猜测无所有者包络、损坏记录或自定义路径的归属；这类遗留数据需要部署者修复/迁移。当前验收为**同机多进程**；多主机本地磁盘的节点归属与删除广播、备份擦除、站点产品自己的其他文件生命周期不在此验收范围。

## 保留与材料实现退役

默认 90 天、最低 30 天的 GC 只处理过期、未被引用且没有未知预约的失败/取消/未执行草稿。source、active、用户决定/proof、学习记录引用、待验证结果、在途任务、未知派发和缺少创建时间的旧记录均保留。PPT 证据不自动按年龄丢弃。数据库发布证据不受工作区草稿 TTL 影响。

材料提供者退役从新候选列表隐藏，并拒绝新提案选择它，但不删除其实现；旧运行快照仍按原 manifest 解析。已有活动租约仍会阻止退役，同版本注册仍禁止替换。部署时仍须保留历史版本实现；未知版本继续显式报错，不自动换成新实现。

## 验证记录

定向测试覆盖文件归属与跨账号隔离、在途写入/迟到写入、旧 scope 回填、保守 GC、材料退役后恢复、原生 Cordis、技能/发布 CAS、PPT 对照/验证/模板/教学、UI、ModelRuntime，以及工程基线相关文件。最终定向回归为 18 个文件、318 项通过；另有预算专项 9 项及 fetch-sse 错误解析 3 项通过，`bun run type-check` 通过，PostgreSQL 多进程 8 项通过。未运行整个平台的浏览器 E2E、生产构建或线上部署。

账号删除入口可独立复核：`node --env-file=.data/acceptance/runtime.env --import tsx scripts/harnessAcceptanceErasure.mts --case=<新的验收标识>`。它只允许隔离环境，正常注册/密码鉴权删除一次性账号，并等待后台清理完成；已登记的标识不会自动重试，完成后清除临时凭据。

私有证据：`.data/acceptance/browser-report.json`、`browser-keep.png`、`live/report.json`、`live-keep-repaired/report.json`、`postgres/report.json`、`erase-auth-report.json`。这些不包含可公开分享的生产验收结论，配置与账号文件不得提交。
