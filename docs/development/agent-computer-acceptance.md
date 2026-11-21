# Agent Computer 测试配置与验收记录

## 最终实现与验收（2026-11-15 后续完成）

此前的浏览器接管控制台、生产 Computer 工具审批链两项缺口已经实现，完整严格验收退出码为 **0**，不再有这两项跳过。最新结果见 [完整验收 JSON](reports/computer-acceptance-2026-11-15-complete.json)。下方初轮报告与失败记录保留为历史，不代表当前状态。

### 交付能力

- 聊天输入区的 Agent 模式提供电脑入口，面板按需加载。查看不分配资源，获准准备后才创建专属容器与持久卷。
- 实时浏览器帧通过认证后端传输，不向网页暴露 Docker、CDP 或 provider 密钥。支持导航、后退、刷新、左/右键、拖动、滚动、文字、粘贴、常用按键和全选。
- 人工输入检查当前账号、助手、控制权和版本。交还后旧输入与旧帧请求失效；人工控制期间拒绝 Agent 输入。忙碌时等待当前动作完成后才交接。
- Chromium 使用持久 `.browser-profile`。休眠等待浏览器完成退出和身份写回，再停止 anchor。Cookie 与 localStorage 跨休眠保留。
- `qingzhou-computer` 已接入原有工具引擎、Cordis 执行与 HITL 卡片。status/observe 只读；execute 支持部署级 allow/ask/deny，默认 ask，headless 后台任务也不能绕过强制审批。
- 执行器核对所属 checkpoint、有效步骤租约、规范工具调用、真实审批及原始参数。模型不能传入执行身份或批准标志；外部 bot 渠道不开放 Computer。
- 面板可使用账号已有 clitnimodel 凭据和 `deepseek-v4.1-flash` 启动原生后台任务，并打开任务与审批。按次使用模型与 Agent 模式，不修改普通聊天设置。
- 原命令去重、持久回执、unknown 隔离与人工核对继续生效。普通导航错误保存失败回执并保留可操作会话，不误判为未知结果。

### 最终测试范围

| 范围                                                                       | 结果                                                                                    |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Computer、界面、RPC、模型、后台活动、worker、定时唤醒、普通聊天后台执行    | 17 个文件，101 项通过                                                                   |
| 工具引擎、HumanInterventionHandler、AgentRuntimeService                    | 3 个文件，134 项通过                                                                    |
| GeneralChatAgent（独立包内执行）                                           | 70 项通过                                                                               |
| 真实 SQL / Cordis / HTTP / Docker / 浏览器 / React 控制台 / 生产审批处理器 | 3 个 live 文件，7 项通过                                                                |
| PostgreSQL 18                                                              | 2 项通过：并发仅一个租约成功、旧租约不能提交；派发后断线过期，重连仍为 unknown 且不重放 |
| 公网浏览                                                                   | 独立 bridge 容器实际访问 HTTPS，核对 URL、标题和非空正文                                |
| DeepSeek                                                                   | 真实模型目录、nonce 生成、生产 Computer schema 的函数调用和参数核对通过                 |
| 质量检查                                                                   | Cordis 类型构建、全仓 tsgo、修改文件 ESLint、Stylelint、Prettier、diff whitespace 通过  |

回归合计 **305 项**。真实 React 测试完成接管、打开浏览器、导航、点击、输入、提交和交还，并保存截图。浏览器工作流还实际测试键盘全选、拖动滑块、离线登录及休眠后身份恢复。没有将手工工具 payload 当成 DeepSeek 函数调用通过。

PostgreSQL 测试使用 Computer 迁移及最小账号表，验证真实行锁与恢复，不冒充整个应用的 PostgreSQL 全量部署验收。验证码和 MFA 由用户通过接管界面完成，本轮没有登录真实账号。物理宿主断电及生产基础设施部署不在本地验收范围内。

### 已配置的本地接入

主数据库已备份并应用 **0116–0119**，共 120 条迁移记录，browser 命令的 SQL CHECK 已核对。备份位于 `.data/local-preview/backups/computer-browser-2026-11-15-1794753414443/`，包含迁移前数据库与环境文件，恢复前必须停止数据库。

Web 的 `.env.development.local` 已配置 Computer endpoint/token、DeepSeek 模型与 provider、默认 ask 策略。独立 provider 的 `.data/computer-provider/runtime.env` 权限为 0600，仅包含 provider/Docker 配置；网络明确选 bridge，以支持公网浏览。密钥未进入仓库。

```bash
# 手动启动本地 Computer；不会自动启动主 Web 或 worker
colima start qingzhou-test --activate=false --mount none --ssh-config=false
npm run computer:local

# 主开发服务按原方式启动；原生 worker 单独监督
npm run agent:worker

# 定向回归（无真实服务与模型调用）
npm run computer:test
npm run computer:test:approval
```

完整真实复测仍用下方隔离引擎流程，但运行 `--all --strict`，并先执行 `docker pull postgres:18-alpine`。另可用 `--postgres` 单独执行真实 PostgreSQL 测试。主数据库必须停止后才能冷复制账号 vault 进行模型验收；副本用后删除。所有 live Vitest 文件默认跳过，只有验收入口才注入独立 endpoint/token 与显式 live 标志。

本轮最终已停止 provider、主数据库与虚拟机，清理测试容器和卷；没有留下执行旧任务的 worker，没有配置开机自启，默认 Docker context 保持 default。

### 后续实现时发现并修复的问题

1. 新 browser 命令被旧 SQL CHECK 拒绝：补齐 0119 迁移，并在 PGlite、PostgreSQL 和本地实际迁移验证。
2. Chromium 与控制进程同时运行超出 128 进程上限：调整为 256，保留 CPU、内存、非 root、只读根目录等限制。
3. 过早结束 anchor 导致身份未写回：等待 Chromium 退出，调整停止时限，验证真实表单和休眠恢复。
4. React 验收 fixture 缺少 Vite refresh preamble，以及交还测试过早断言：修复 fixture 并等待真实 SQL 回执。
5. 公网页面正文已变化：公网验证采用 URL、标题与非空正文，不依赖旧标题文字重复出现在正文中。

## 以下为初轮历史记录

记录日期：2026-11-15（Asia/Shanghai）。用户授权本轮临时启动必要测试服务，完成后停止。测试没有迁移或启动主数据库，没有启用主应用的 Web/native worker，也没有更改账号模型目录。

## 初轮结论（已被上方最终结果替代）

已实现功能的定向回归与真实 Docker、DeepSeek、Chromium 持久化验收均通过。交互式浏览器接管控制台、Computer 工具接入生产 Agent 审批链尚未实现，不能记为测试通过。严格验收命令会因这两项缺口返回退出码 1。

- 定向回归：14 个文件、94 项通过。
- SQL → Cordis → 真实 HTTP → Docker：3 项通过，使用独立内存 PGlite 和完整迁移。
- 容器/HTTP/浏览器实际运行、真实网关模型目录和生成调用：见下表及保存的 JSON。
- Cordis 类型构建、全仓 `tsgo --noEmit`、新增代码 ESLint、Prettier 和 `git diff --check` 通过。
- 本轮结束时 provider 已退出，专用测试容器和卷已删除，`qingzhou-test` 虚拟机停止。Docker/Colima CLI 和构建镜像保留用于后续复测；没有配置登录自启。

最终完整报告：[computer-acceptance-2026-11-15.json](reports/computer-acceptance-2026-11-15.json)。本地日志和账本位于 `.data/computer-acceptance/2026-11-15T14-06-58-744Z-ab449bb5/`，其中 `report.json`、`runtime-live.log`、`provider.log`、`resources.json` 可逐项核查。

## 测试矩阵

| 项目                         | 边界与断言                                                                                                                           | 本轮结果                                                                           |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| 基础回归                     | Computer 租约、账号/助手隔离、超时隔离、回执关联、模型选择、RPC、管理面板、后台活动核对、worker 心跳、唤醒和普通聊天后台执行         | 94 项通过；外部边界为测试替代实现，不能当作真实容器验收                            |
| SQL / Cordis / HTTP / Docker | 查看不创建电脑；持久命令和去重；人工控制时拒绝 Agent；实际执行后注入丢失响应，SQL 进入 unknown，仅人工查询真实回执恢复且不重放 shell | 3 项通过；真实隔离 SQL、Cordis、网络监听和 Docker                                  |
| 创建与隔离                   | UID 1000:1000、只读根文件系统、nanetwork=none、没有宿主目录 bind mount                                                               | 通过；检查真实 `docker inspect`                                                    |
| HTTP 边界                    | 错误 Bearer 返回 401；带伪造 owner 的输入返回 400                                                                                    | 通过                                                                               |
| 文件与幂等                   | 容器实际写文件；相同 commandId 返回原回执，文件只追加一次                                                                            | 通过                                                                               |
| 休眠与唤醒                   | anchor 停止后重新启动，命名卷内文件仍存在                                                                                            | 通过                                                                               |
| 控制权交接                   | 人工持有控制权时拒绝 Agent 写入；交还后可继续；被拒绝的文件不存在                                                                    | 通过                                                                               |
| provider 重启                | 实际停止并重启 Node provider，SQLite 完成回执仍可查询；重发原命令不重复写入                                                          | 通过                                                                               |
| 客户端断线                   | 等待服务端持久接收后主动断开 HTTP 请求；服务端仍完成并保存回执；后续查询成功                                                         | 通过                                                                               |
| Chromium 身份写入            | 在真实沙盒中启动 Chromium，在容器回环 HTTP 页面写 Cookie 与 localStorage                                                             | 通过；没有访问真实账号或外部网站                                                   |
| Chromium 身份保留            | 关闭浏览器进程、休眠容器、重启 provider、唤醒后再开 Chromium，读取同一 Cookie 与 localStorage                                        | 通过                                                                               |
| shell 超时                   | 超时退出码 137；延迟写文件的子进程被终止，等待后文件仍不存在                                                                         | 通过                                                                               |
| 过期未完成回执               | 真实 SQLite 重开，受控时钟推进；未完成命令保持 unknown，拒绝再次派发                                                                 | 通过；这是时钟控制测试，未冒充真实进程崩溃验收                                     |
| clitnimodel 模型目录         | 使用当前账号已保存的加密 vault，精确匹配启用的 remote DeepSeek 模型                                                                  | 通过；当日 `/models` 返回 11 个不同 ID，包含 `deepseek-v4.1-flash`                 |
| DeepSeek 生成调用            | 真实 `/chat/completions`，随机 nonce 严格回显，单次请求、不自动重试                                                                  | 通过；返回 `workbuddy/deepseek-v4.1-flash`，finish_reason=stop，最终一轮 84 tokens |
| 清理                         | provider 监听关闭，只删除本轮资源；测试引擎容器/卷列表为空；最后停止虚拟机                                                           | 通过                                                                               |
| 交互式接管控制台             | 实时画面、鼠标键盘、人工输入通道撤销、登录后交还                                                                                     | 未实现，未执行；不能用 headless 持久化测试替代                                     |
| 生产 Agent 工具审批链        | 模型调用 Computer 工具，实际 HITL 卡片批准/拒绝并恢复生产任务                                                                        | 未接入，未执行；联调使用的 trusted test authority 不能替代生产审批                 |

本轮没有执行真实账号登录/验证码接管、真实 PostgreSQL 生产并发、容器宿主重启断电恢复，也没有验证生产浏览器实时推流。当前测试没有声称覆盖这些行为。

## 可重复执行的入口

在仓库根目录执行。依赖已安装后无需重新安装项目依赖。当前主机 Node 为 v26.13.0，Docker CLI 29.9.3，测试引擎 29.5.2，Colima 0.10.3。镜像包含 Node 24 和 Chromium；测试固定构建后的不可变 image ID。

```bash
# 不启动任何服务，只检查验收模块加载
node --import tsx scripts/computerAcceptance.mts --check

# 仅定向回归，不启动 Docker/provider，不调用模型
npm run computer:test

# 全仓类型检查的直接等价命令
node_modules/.bin/tsc --build packages/cordis-foundation/vendor/cosmokit/tsconfig.json packages/cordis-foundation/vendor/cordis/tsconfig.json
node_modules/.bin/tsgo --noEmit
```

项目正常 pnpm 环境也可运行 `pnpm computer:test`、`pnpm computer:acceptance --check` 和 `pnpm type-check`。本机 fallback pnpm 会在运行前触发依赖同步，并因无 TTY 拒绝移除 node_modules，因此本轮使用 npm 脚本和既有本地二进制；没有通过重装依赖绕过这个保护。

真实测试必须明确指定独立引擎。下面这组命令可作为一次性本地执行流程：

```bash
(
  set -eu
  # 仅使用本测试专用 profile；不切换默认 Docker context，不挂载宿主目录。
  trap 'colima stop qingzhou-test' EXIT
  colima start qingzhou-test --activate=false --vm-type vz --cpu 2 --memory 4 --disk 25 --mount none --ssh-agent=false --ssh-config=false
  export DOCKER_HOST="unix://${HOME}/.colima/qingzhou-test/docker.sock"
  docker build -t qingzhou-computer:local docker/computer
  node --import tsx scripts/computerAcceptance.mts --all
)
```

`--docker` 运行容器与 SQL 联调；`--browser` 还运行 Chromium 身份持久化；`--model` 仅测试现有账号的模型目录和真实生成；`--all` 包含上述全部。每次创建新的私有 run 目录、随机 Bearer token 和回环端口。provider 只接收 Docker/provider 配置，不继承应用的模型密钥。容器中也没有 DeepSeek 密钥。

`--all --strict` 用于完整产品验收门禁：任何已选测试失败或任何项目未执行均返回非零。当前真实检查通过但仍有两项未实现，因此最终严格运行的退出码为 1，报告 verdict 为 `implemented-checks-passed-with-open-gaps`。普通模式退出 0 只代表已实现的检查通过，报告仍保留缺口。

模型测试依赖此开发环境现有 `.env.development.local` 的 vault secret、`.data/local-preview/account.json` 的 userId 和 `.data/local-preview/tooling/` 的同版本 PGlite 工具。不接受测试参数中的明文 key，不把凭据打印到日志。测试要求主数据库 55432 未监听，冷复制现有数据库到私有目录，只打开副本读取账号配置；完成后关闭并删除副本，不更新原数据库、模型目录或迁移记录。另一个开发环境尚无这些文件时会明确失败，需要先配置自己的开发账号，不能把本机凭据文件提交到仓库。

`QINGZHOU_COMPUTER_IMAGE` 可覆盖预先构建的镜像标签；`QINGZHOU_COMPUTER_MODEL` 必须是实际同步的 DeepSeek ID；存在多个合格 provider 时用 `QINGZHOU_COMPUTER_MODEL_PROVIDER` 明确选择当前账号的 provider。不会自动回退到内置模型或其它网关。

单独执行 live Vitest 文件默认跳过，防止普通回归意外运行真实容器。验收脚本启动自己的 provider 后才设置 `QINGZHOU_COMPUTER_ACCEPTANCE=1`、独立 endpoint/token 和 `TEST_SERVER_DB=0` 调用该文件。不要使用生产数据库运行 live fixture。

## 本轮发现和修复

首轮真实联调中，测试脚本把完整 dispatch 对象传给回执查询，服务端按严格 schema 返回 400，导致重启回执、断线后的依赖项失败。生产运行时本来只传三个身份字段。已将脚本修正为显式提取 sessionId、commandId、revision；同时修复 suite 汇总在子项失败时仍显示通过的问题。随后独立浏览器复测和最终完整严格复测中，所有已实现检查通过。

首轮失败报告保留在 `.data/computer-acceptance/2026-11-15T14-05-19-352Z-262f3aff/`，修正后的浏览器复测在 `.data/computer-acceptance/2026-11-15T14-06-00-190Z-4699afef/`。没有删除失败历史或把未执行项计入通过数。

## 后续验收顺序

1. 实现浏览器实时画面、可撤销人工输入授权和交还后旧连接失效，再加入真实浏览器控制台 E2E。
2. 将 Computer 工具接入现有 Agent 审批与步骤租约，加入 allow/ask/deny、批准/拒绝、超时、页面关闭后恢复的完整测试。
3. 在真实 PostgreSQL 与部署环境验证多 worker 并发、provider/容器宿主异常退出和恢复；这部分不能只靠 PGlite 或受控时钟测试通过。
