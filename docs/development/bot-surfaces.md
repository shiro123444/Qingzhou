# 当前伙伴：身份、界面与执行周期

聊天、PPT、音乐和站点编辑器使用同一当前助理 ID。BotSurfaceHost 安装在登录工作区布局（桌面、移动）内；公开分享页没有此入口。可通过插件的伙伴按钮或 Alt+B 打开提问框。在标准对话框的文本控件或带 data-bot-mention 的文本域中，输入独立的 @bot 再按空格也可以打开。原草稿留在原处。仅新提问框中明确发送的文字会交给 Bot，不自动传递文件、选区或插件内容。

富文本聊天的 @ 列表固定显示当前伙伴，搜 bot 也能匹配。提及自己直接留在本轮；选择其他助理沿用已有路由。在群聊中，选择伙伴打开私下提问框，不会改变群成员或将群消息转发给伙伴。PPT 的创作输入框只开放伙伴提问，提交幻灯片仍走原有流程。

## 插件接入

1. 在可信应用代码的 Cordis manifest 中声明 botMention，并在部署 profile 注册对应的私有工作区路由。BUILTIN_PLUGINS 已包含 presentation、music、sites。配置只选模块，不从配置载入代码。
2. 在工具栏渲染 BotMentionButton（src/features/BotSurface/context.tsx），或使用 BotSurfaceContext 的 open()；没有登录、当前助理或插件未启用时不提供入口。新增文本编辑器可用 data-bot-mention 标注。通用组件不得假定自己能读取工作区内容。
3. 如需展示运行状态，挂载 useBotPresence()；按账户与 Bot 缓存，只返回当前最近一项有效运行的阶段和话题 ID。此接口读取原生运行检查点，可用于未启用沙盒电脑的部署。解除订阅后停止轮询。头像、电脑状态、插件对话都不拥有后台任务。
4. 提交使用 aiAgent.mentionBot，只接受 agentId、prompt 和可选的内置插件标识。服务端核对部署配置和账户归属，随后为此次提交懒加载 Cordis 的 qingzhou.bot.ask 服务；其唯一参数是问题文本。该实例不暴露设备、文件、审批决策或工具清单，并在提交结束或异常时释放。运行由既有 Agent 服务持有，检查点、队列、审批及执行回执沿用既有机制。返回 topicId 供用户打开结果。插件启用标志是功能配置，并非用于隔离任意不可信同源 JavaScript 的沙盒。

本设计借鉴本机 harness2/harness2/substrate/base.py 中对可用能力描述和实际执行请求的区分。harness2 本身没有作为常驻进程或依赖引入。查看状态、选中伙伴、移动指针都不会启动任务；显式发送使用 manual 审批策略，并禁用本地系统工具。卸载界面释放查询和监听器，不撤销已经由用户提交的后台任务。

## 验证

权限与持久化：src/server/routers/lambda/**tests**/aiAgent.test.ts 中的 mentionBot 用例。生命周期与隔离：src/server/services/agentComputer/activity.test.ts。文本触发器及监听器回收：src/features/BotSurface/trigger.test.ts。真实浏览器验证覆盖视线变化、关闭跟随后静止、窄屏及减少动画；截图位于 output/bot-surface-validation。音乐页另外在实际登录账户中打开过提问框，未向模型发送测试消息。
