# 电脑伙伴入口与玻璃动效

2026-11-16。按用户后续要求改为 Muse 风格的常驻 Bot 右侧栏，沿用 React 19、motion/react、Three.js、antd-style 和现有 Liquid Glass 材质，没有增加 UI 依赖。

## 用户入口

- 聊天与主页右侧常驻青瓷伙伴，保持带手臂、双脚的立体伙伴形态。头部和眼睛跟随页面内指针；电脑使用状态通过名称下方的简短文案表达，不在侧栏直接显示电脑画面。
- 右侧栏与聊天区并排占位，展示当前 Bot 名称与状态、专属电脑入口，以及“动态 / 待确认 / 感知”三个分区。收起后缩为 60px；窄屏改为下方可滚动的占位栏，避免覆盖输入区。展开时点击伙伴或“查看与接管”才打开工作台，收起时点击伙伴先展开侧栏。按用户最新选择，暂时移除整盏灯与拉绳入口。
- 工作台采用最大 76px 的控制状态标题与青瓷玻璃电脑，移除重复的小状态行、状态圆点和轨道装饰。标题按服务端已确认状态切换，以 260/24 弹簧进入，并支持 Weight wave；不以本地点击推定接管成功。模型和回执收进详情，任务输入按需展开。
- “动态”显示当前运行、当前 Bot 实际分配的计划与任务，以及最多五条真实操作回执。计划通过现有鉴权任务接口按助理过滤，仅查询 backlog/running/scheduled/paused 状态，最多六条；没有任务时显示任务入口，不填充演示计划。最近操作采用紧凑时间线。
- “待确认”展示真实审批会话和需要核对的未知回执，没有待办时显示简短空状态。“感知”集中放置跟随开关、当前线索和一句边界说明；其余分区只在有线索时显示简短提示。关闭感知即时清空线索并停止跟随。三个分区支持方向键、Home/End、RTL 和减少动画设置。
- 点击“打开电脑”才按修订版本顺序完成初始化、人工接管和浏览器启动；任一步失败停止后续操作并刷新真实状态。浏览器使用深青色边框，胶囊工具栏与接管/交还按钮位于画面下方，短窗口按可用高度缩放且保持 11:7 坐标比例。
- 所有状态与操作文案沿用 `chat` namespace，跟随系统语言即时切换，已补齐 default/en-US/zh-CN；没有强制修改账户语言。减少动画偏好会关闭文字、图标、光场与标题弹簧的连续运动，功能保留。
- 侧栏保留原来的拖动宽度、持久化偏好、键盘焦点转移和 inert 行为，伸缩改用弹簧。
- 当前回复的新增正文词片段柔和进入，中文按 Intl.Segmenter 分词。代码块、链接和 Markdown 结构仍由原渲染器负责；原有关闭流式动效的设置继续有效。

## 真实状态与控制边界

`AgentComputerService.get()` 只读取当前账户、当前助理的会话和 checkpoint。电脑活动只匹配结构化工具身份；历史轮次的电脑调用、用户文本里的工具名称、过期执行租约和已完成任务都不会使伙伴显示“正在操作”。接口不返回工具参数、输入内容或 provider 凭据，查看入口不创建容器。

实时画面通过已有鉴权 observe 接口获取，只在点击后打开的工作台内读取。侧栏不挂载截图、不轮询取帧；关闭工作台后停止取帧。完整控制台在动作回执期间保留最后画面并提示等待，禁止对旧版本画面输入，减少页面跳动。右栏会话状态与任务摘要的轻量读取仍保留，不会因此启动电脑或模型任务。

接管成功以服务端回执为准。执行中的单条动作需要先结束并确认回执；界面不会声称已经抢占了该动作。交还控制后鼠标、键盘与文字输入失效。发送文字失败保留草稿。

当前可视化对象为沙盒 Chromium 浏览器；终端任务保留已有命令回执入口，并非完整操作系统桌面的 VNC 直播。

入口按 native runtime、服务端能力开关、登录账户与助理身份加载；3D 伙伴及完整面板均延迟加载。3D 使用 demand 渲染，在形变、目光跟随与眨眼时更新；退出账户或切换助理会卸载对应入口。减少动画设置使用即时位置/状态切换，放大镜功能仍可用。

## 鼠标感知与 Agent 上下文

- 鼠标在本应用内移动时，头部采用 260/24 弹簧，眼睛采用更快的 620/36 弹簧分别追踪；每隔约 3.4–5.6 秒自然眨眼。离开窗口、关闭感知或收起侧栏时回到中立姿态。减少动画偏好下不显示头眼追踪和眨眼。
- 这是页面内鼠标位置反馈，不使用摄像头或真实人眼追踪。原始坐标仅用于本地 3D 姿态，模型接口不接受坐标、输入内容或任意页面文本。
- 感知线索来自输入焦点或至少 1200ms 的停留，只保留 compose/computer/approval/music/documents/tasks/presentation 等语义枚举。兼容伙伴延迟加载前编辑器已自动聚焦的情形。
- 客户端缓冲按账户与 Bot 隔离，30 秒失效；关闭感知、切换账户/Bot或卸载时清除。普通聊天发送与明确发起的电脑任务会携带当前线索，服务器严格校验并将其作为“不确定、非指令”的上下文交给 Agent。线索进入已发起运行后按现有会话留存机制处理。
- 移动鼠标、聚焦或停留不会调用模型、创建任务或执行工具。界面先提供可关闭的本地推测，Agent 在收到下一条明确消息后结合线索理解请求；不能把线索当作用户授权或屏幕内容。
- 右栏同时显示普通 Bot 的运行/等待批准/排队状态，所有阶段保持伙伴形态；浏览器屏幕只出现在显式打开的工作台内。

## 参考与参数

先读取下列 HTML、对应 CSS/JS 与 shared 文件，再进行项目改造。保留的是质量为 1 的弹簧参数；删除演示内容、自动拉绳、自动漫游和外部字体/统计脚本。

| 组件                  | 原始来源                                                                                                                               | 项目参数                                                                                                                                  |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Pull cord（暂不挂载） | [HTML](https://designbookmark.com/motion-src/pull-cord/index.html)、同目录 cord.css/cord.js                                            | 已核对原例为灯罩、灯泡和拉绳组成的整盏灯；按用户最新选择移除页面入口，保留参考文件，不将单独绳头放在伙伴头顶                              |
| Morph tooltip         | [HTML](https://designbookmark.com/motion-src/morph-tooltip/index.html)、同目录 tooltip.css/tooltip.js                                  | 前缘 620/36、后缘 190/19，方向切换时交换；文字 420/32；隐藏延迟 140ms                                                                     |
| Glass lens            | [HTML](https://designbookmark.com/motion-src/glass-lens/index.html)、同目录 lens.css/lens.js                                           | 跟随 180/17、缩放 260/26；直径 150；1.7× / 按下 2.4×；三层透镜 1/1.05/1.12                                                                |
| Streaming reply       | [HTML](https://designbookmark.com/motion-src/streaming-reply/index.html)、同目录 stream.css/stream.js                                  | 词片段 340/26，高度 260/26；实际消息增量驱动，无模拟回复计时器                                                                            |
| Sidebar collapse      | [HTML](https://designbookmark.com/motion-src/sidebar-collapse/index.html)、同目录 side.css/side.js                                     | 宽度 260/24、标签 300/26、按钮 300/22；标签延迟 60ms，适配现有导航结构                                                                    |
| Toolbar               | [Kokonut UI 文档](https://kokonutui.com/docs/navigation/toolbar)、[registry 源码](https://kokonutui.com/r/toolbar.json)                | 选中板 spring/bounce=0/0.25s；布局 spring/bounce=0/0.4s；已有 React/motion/antd-style 重建                                                |
| Weight wave           | [HTML](https://designbookmark.com/motion-src/weight-wave/index.html)、同目录 wave.css/wave.js                                          | 字重 260/22、焦点 150/22、扩散 .13；用于公共导航和电脑大标题，按实际字体字号适配字重范围；去掉演示自动扫动，连写文字按完整词处理          |
| Read along            | [HTML](https://designbookmark.com/motion-src/read-along/index.html)、同目录 read.css/read.js                                           | 前缘 520/40、后缘 210/26、纵向 600/48、透明度 300/30、横向留白 .16em；换行收合后在下一行展开                                              |
| Glass player          | [Kokonut UI 文档](https://kokonutui.com/docs/cards/liquid-glass-card)、[registry 源码](https://kokonutui.com/r/liquid-glass-card.json) | 参考 v2.0.0 的唱片布局和 200°/s 转速，启动/停止时间常数 .22/.2s；采用当前真实音频引擎和玻璃材质，保留原生进度条、拖动、账户隔离和暂停恢复 |

共享来源：[tokens.css](https://designbookmark.com/motion-src/shared/tokens.css)、[base.css](https://designbookmark.com/motion-src/shared/base.css)、[motion.js](https://designbookmark.com/motion-src/shared/motion.js)。已有参数在 `src/features/GlassMotion/springs.ts`；新增文字动效的组件专属参数在 `WeightWave.tsx` 和 `textMotion.ts`，对应原组件 JS，不把它们误换成 shared 的另一组弹簧。

Read along 由实际新增的 Markdown 正文片段或歌词时间戳驱动，不自动模拟回复，也不猜测无逐词时间戳的歌词进度；普通 LRC 按当前行跟随。代码块保持原渲染方式。停止生成、切换歌曲、卸载和关闭页面时清理对应观察器与动画；减少动画使用即时位置更新。

`MotionGlyph` 为原生 CSS 线条图标，接入公共导航、左右侧栏开关、伙伴入口、电脑工具栏、音乐导航和播放器；复杂品牌等图标继续保留原身份。图标按悬停、焦点和明确状态变化响应，只有真实播放时的节奏条持续运动。无限播放装饰不参与 `useCapsuleMotion` 的有限布局动画等待，防止玻璃重绘持续运行。

本次使用用户指定命令安装并读取了 `~/.agents/skills/frontend-design/SKILL.md`。沿用项目字体、颜色、圆角、i18n 与 antd-style，未引入 Tailwind、演示字体、演示定时器或新的播放器引擎。Kokonut UI 的播放器参考代码为 Dorian Baffier 提供的 MIT 作品。

Toolbar 参考作品由 Dorian Baffier / Kokonut UI 提供，MIT 许可。本项目按现有组件栈独立重建所需交互，没有引入其 Tailwind、全局 CSS、完整拖拽停靠系统或快捷键系统。

开源产品参考：[OpenFuse（原 OpenMuse）的电脑工作区](https://github.com/CopilotKit/openfuse/blob/main/apps/mobile/src/computer-workspace.tsx)、[OpenDots Computers](https://github.com/CopilotKit/OpenDots/blob/main/docs/COMPUTERS.md)、[invisible_dots Guide](https://github.com/feder-cr/invisible_dots/blob/main/docs/guide.md)。沿用本项目原生持久会话、审批与控制版本协议。

本轮另在真实 Muse 页面核对伙伴、活动、审批与身份分区，并阅读 [Muse 设计说明](https://muse.ai/blog/how-we-designed-muse)。清舟沿用自己的青瓷玻璃材质与业务状态，采用“动态 / 待确认 / 感知”组织信息。用户给出的 [DesignBookmark Appish 条目](https://designbookmark.com/tool/appish)指向 [Appish Mac 工具套件](https://appish.app/)，并非 React 组件库；另查阅 [Motion 分类](https://designbookmark.com/motion)及原始动效源码，没有安装该 Mac 工具或引入演示脚本。报告不保存第三方账户的私人聊天内容。

## 验证与复现

- `activity.test.ts`：真实隔离 SQL 查询，验证助理范围、结构化身份、过期租约、普通文字、历史轮次、私有参数不外泄及不启动 provider。
- `companionState.test.ts`、`StreamingReply.test.ts`：状态投影及中文/代码块边界。
- `Companion.test.tsx`、`Panel.test.tsx`、`ToggleLeftPanelButton.test.tsx`：按助理读取任务、审批入口、分区键盘切换、感知清空、中英切换、接管回执、忙碌阻止、读取失败、输入草稿、键盘焦点；伙伴保持人形，点击前不观察、不分配电脑。
- `console.live.integration.test.ts`：真实 Docker、服务端、React 与 Chrome；从未分配电脑开始，验证真实隔离计划、零侧栏截图请求、没有拉绳入口；点击伙伴打开工作台，再显式初始化、接管和启动浏览器。继续验证实际点击/输入/保存、交还后输入撤销、透镜、Markdown 增量、头眼跟随，以及减少动画/390px 窄屏/深色工作台与中文大标题。关闭工作台后检查观察请求计数停止增长。隔离测试页面不属于产品路由。
- 主项目本地登录预览另外检查右栏占位、实际分区和点击展开的工作台；不启动 native worker，也不发送模型请求。

局部测试使用 `TEST_SERVER_DB=0 NODE_OPTIONS=--no-experimental-webstorage node_modules/.bin/vitest run --silent=passed-only <上述测试文件>`。真实容器测试额外需要启动 computer provider 和专用 Docker 引擎，并设置 `QINGZHOU_COMPUTER_ACCEPTANCE=1`；令牌从已有私有环境文件加载，不能写进测试源文件。

本轮 17 项组件回归及 1 项真实容器流程通过，类型、ESLint、Stylelint、Prettier 与 diff 检查通过。截图与 JSON 测试报告保存在 `output/companion-panel-validation/`，包括侧栏、头眼跟随、打开前、接管中、交还后、中文与窄屏深色版本。遵循最新“启动我看看”的预览要求，主应用与电脑服务保持运行；测试创建的隔离电脑在 finally 中清理，native worker 保持暂停。

后续更新：头像已替换为青瓷外壳与暖色面盘，眼睛、头部与躯干分层跟随；空闲时眨眼和短暂呼吸，依据真实运行状态调整眼形与倾角。当前身份、跨插件提问入口、权限边界和验证见[伙伴接入约定](./bot-surfaces.md)。新截图位于 `output/bot-surface-validation/`。
