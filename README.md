# Qingzhou・清舟

**让想法在对话中长成作品。**

清舟是一个围绕 Agent 构建的创作平台。你描述目标、补充想法、指出需要修改的地方，Agent 调用工具，把内容、素材和版式逐步组织成可以继续编辑的作品。

我们从演示文稿开始，也在为更多创作能力建设共同的运行基础。

[开始开发](#本地开发) · [PPT 与插件开发](./docs/development/cordis-atomic-presentation.md) · [Cordis 迁移进展](./docs/cordis/foundation-migration.md) · [反馈问题](https://github.com/shiro123444/Qingzhou/issues)

## 与作品一起工作

### 从一句话到一份演示文稿

告诉 Agent 主题、受众和表达目的，让它规划内容框架与大纲。故事板按页呈现，展开后可以查看要点、讲稿和视觉决策，再进入生成。

### 生成中，也可以继续对话

新想法可以随时加入。修改指令会进入队列，依次应用；指定某一页时，保留其他页面。你也可以在预览中标注位置，让 Agent 针对选中的内容做局部调整。

### 素材参与设计

图片生成、资产复用、透明化处理、抠图与组合都是可调用的能力。模板学习先渲染真实页面，再分析视觉规范和组件，区分可复用素材与带有旧文字的内容，为后续排版提供参考。

### 交付之后，继续创作

导出可编辑的 PPTX，保留讲者备注，也可导出 PDF 和页面 SVG。任务、版本、资产和修改记录持久化保存，让作品可以恢复、重试和继续迭代。

## 能力可以组合，平台可以生长

清舟将业务能力拆成有明确输入、输出和作用范围的原子操作。PPT 负责页面设计和作品状态，资产插件负责素材处理，工具桥接负责接入外部能力。

原子工具宿主已接入真实 **Cordis 4.0.2**，由其管理插件生命周期和资源回收。清舟适配层负责工具发现、候选版本切换、调用上下文与运行中的版本锁。一个任务进行期间，插件实现不会被另一版悄悄替换。

```text
src/features/PresentationStudio/ 对话、故事板与演示文稿工作台
src/server/runtime/             原子工具宿主、组合技能与业务插件
packages/cordis-foundation/      固定来源的 Cordis / Cosmokit
packages/cordis-kernel/          迁移中的兼容层与平台服务
packages/runtime-contracts/      任务、页面、事件和资产协议
```

## 当前阶段

清舟正在持续开发。当前已打通真实 PPT 生成、生图、模板视觉分析、页级修改、恢复与导出；Cordis 的原子工具宿主迁移已完成首阶段验证。

接下来继续推进通用 Agent 循环的插件化、服务迁移、配置装配和 Loader/HMR。复杂模板的精细还原、跨环境恢复与视觉质量也仍在完善。安装一个插件不会自动获得业务授权、持久化或任意代码沙箱，这些边界需要由宿主和业务共同定义。

2026-09-13 的一次验收包括 **269 项定向测试**，以及真实 3 页 PPT 的生成、图片嵌入、讲者备注、LibreOffice 打开验证和单页对话修改。具体范围见[验收记录](./docs/cordis/foundation-migration.md#本轮实测记录2026-09-13)。

## 本地开发

需要 Git、Node.js（版本见 [.nvmrc](./.nvmrc)）、pnpm、Bun，以及运行基础服务的 Docker Compose。

```bash
git clone https://github.com/shiro123444/Qingzhou.git
cd Qingzhou
pnpm install

cp docker-compose/dev/.env.example docker-compose/dev/.env
cp .env.example.development .env
```

编辑环境配置，设置数据库、对象存储、认证和模型服务，然后启动：

```bash
bun run dev:docker
pnpm db:migrate
bun run dev
```

应用入口为 `http://localhost:3010`，PPT 工作台位于 `/presentation`。完整开发模式会启动 Next.js 后端和 Vite SPA。

真实 PPT 生成还需要配置可用的规划模型、图片服务及导出工具链；启动网页本身不会提供这些外部服务。配置入口见[规划模型](./src/server/runtime/presentation/production-multimodal-chat-config.ts)、[图片服务](./src/server/runtime/presentation/production-image-config.ts)和[导出工具链](./src/server/runtime/presentation/production-config.ts)。作品目录由 `CORDIS_PRESENTATION_DATA_DIR` 配置，默认使用 `.data/presentation`，部署时需要持久化保存。

## 参与开发

界面使用 Next.js、React、TypeScript、Zustand 与 `@lobehub/ui`；数据层使用 PostgreSQL、Drizzle 和对象存储。pnpm 管理依赖，Bun 运行脚本，Vitest 验证行为。

修改功能时，优先运行对应测试。运行时改动可以从以下检查开始：

```bash
bunx vitest run --silent=passed-only src/server/runtime/cordis-atomic-host.test.ts src/server/runtime/atomic-runtime.test.ts
bunx vitest run --silent=passed-only --root packages/cordis-kernel
bun run type-check
```

新增能力时，先定义操作边界、输入输出、取消和恢复语义，再接入 Agent 的工具目录。详细约定见 [AGENTS.md](./AGENTS.md)、[原子能力开发指南](./docs/development/cordis-atomic-presentation.md)与[组合技能说明](./docs/cordis/presentation-composable-skills.md)。

欢迎提交 [Issue](https://github.com/shiro123444/Qingzhou/issues) 交流使用体验、复现问题或提出能力设计。

## 来源与许可

清舟基于 [LobeHub](https://github.com/lobehub/lobehub) 继续开发，保留原有 Git 提交历史与版权信息。感谢上游在对话、界面、模型接入和应用基础设施上的工作。

根目录 [LICENSE](./LICENSE) 保留 LobeHub Community License 原文；本项目不将上游代码重新声明为 MIT。Cordis 与 Cosmokit 的来源、固定提交、补丁和校验记录见 [PROVENANCE.md](./packages/cordis-foundation/PROVENANCE.md)，各自许可证保留在 vendor 目录中。
