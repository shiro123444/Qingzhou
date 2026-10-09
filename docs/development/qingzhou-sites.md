# 清舟文档与博客改造

目标：文档公开阅读、开放贡献；博客支持清舟托管、本地编辑回传与 Agent 协助。Fumadocs 与 Astro 保留独立前端，通过 Cordis 共享内容能力。视觉以博客的简洁组件为基准，文档首页保留粒子效果。

## 实施顺序

1. **第一轮：内容闭环与视觉基础。** 接入 `sites` 插件、账号所属博客、草稿与公开版本、本地签出 / 回传、版本冲突、发布及回滚；开放两个子站的内容发现协议；统一主题、按钮与排版；把共用摩天轮改成真实运动的矢量结构。
2. **第二轮：身份与贡献闭环。** 文档站现有 New-Nexus 数字身份与清舟身份需要显式映射或迁移，不能直接认作同一账号。接入清舟 OIDC，保留贡献者归属、审核和修订历史；完善贡献差异、合并及回滚界面。
3. **第三轮：完整站点托管。** 对接持久数据库、对象存储和部署适配器，支持图片、独立文章地址、域名与构建产物。站点代码与内容分开；用户代码只在隔离构建环境运行。
4. **第四轮：逐页精修。** 基于统一组件逐页验收主站、文档、博客的手机 / 桌面、明暗主题、空态、错误态和键盘操作。深化演示场景、输入框装饰及过渡动效，避免以降低透明度掩盖结构问题。

## 第一轮接线

- 主项目：`/home/shiro/Projects/lobehub`。聊天原挂载 worktree 没有近期的 `QingzhouBrand`，实际动画在主项目。
- 文档：`/home/shiro/Projects/fumadocs/shiro`。保留已有未提交的同步 outbox 代码。
- 博客模板：`/home/shiro/Projects/blog-replica`。
- 私有调用：`POST /api/runtime/sites`，请求 `{ operation, input }`。身份来自清舟认证中间件，工具参数不能指定所属账号。
- 公共读取：`GET /api/sites/public/:id`，只返回已发布文章；公开页面 `/sites/view/:siteId`。
- 文档协议：`GET /api/cordis[?slug=...]`；`POST /api/cordis` 的 `docs.change` 和 `docs.submit` 复用本站身份与草稿流程，不绕过审核。
- 博客协议：`GET /api/cordis.json`，仅包含公开文章。
- Agent：`sites.agent.edit` 通过模型端口生成受校验的 Markdown 修改，写入草稿；发布独立执行。当前属于一次受限编辑操作，不是任意站点代码执行或无限 Agent loop。

## 开发配置

清舟主站环境：

```dotenv
CORDIS_DOCS_URL=http://localhost:3000
CORDIS_BLOG_URL=http://localhost:4321
CORDIS_SITES_DATA_DIR=/absolute/persistent/path/sites
```

博客 Agent 复用认证用户在清舟主页面保存的模型与服务配置；按次解析，不在全局站点 runtime 保存用户密钥。文本修改不要求视觉模型。当前沿用已有 OpenAI 兼容端口，原生其他协议需后续适配。未配置时，文章编辑、发布与本地同步仍可使用，Agent 返回明确的不可用结果。

文档导航可配置 `NEXT_PUBLIC_QINGZHOU_URL` / `NEXT_PUBLIC_QINGZHOU_BLOG_URL`；博客导航可配置 `PUBLIC_QINGZHOU_URL` / `PUBLIC_QINGZHOU_DOCS_URL`。生产环境需要替换本机地址。

## 本地闭环

在博客模板目录执行，访问令牌来自清舟 OIDC/CLI 登录，保存在 shell 环境，不写进站点文件：

```bash
export QINGZHOU_URL=https://your-qingzhou.example
# Export QINGZHOU_TOKEN securely in your shell.
node scripts/qingzhou-blog.mjs create '我的博客' '作者' ../my-blog
cd ../my-blog
node scripts/qingzhou-blog.mjs start
node scripts/qingzhou-blog.mjs status
node scripts/qingzhou-blog.mjs push
node scripts/qingzhou-blog.mjs publish
node scripts/qingzhou-blog.mjs pull
node scripts/qingzhou-blog.mjs agent '修改欢迎文章的开头'
node scripts/qingzhou-blog.mjs deploy
```

`deploy` 输出可托管的静态 `dist/`；它不自动购买域名或上传外部服务。回传只覆盖 `src/content/blog/**/*.md`，删除必须表现为显式的 `null` 变更，基准版本过期返回 409。本地未回传修改存在时，pull 不覆盖它们。

## 当前边界

第一轮托管的是 Markdown 内容，公开阅读由清舟渲染；Astro 的主题、MDX、图片和用户代码部署属于后续托管适配器。当前文件存储要求持久可写的单机 Node 环境；多副本 / 无状态部署需切换数据库及对象存储。历史公开版本最多保留 20 份。

站点操作包含：`sites.sources`、`sites.source.read`、`sites.list`、`sites.create`、`sites.read`、`sites.change`、`sites.publish`、`sites.rollback`、`sites.agent.edit`。

## 第一轮验收（2026-10-09）

- Cordis 站点操作、用户模型端口与桌面路由同步共 24 项测试通过；清舟与文档站类型检查通过。
- 博客模板静态构建通过；新签出的个人博客独立安装依赖后构建出 8 个页面。签出时移除模板的演示文档、项目、友链与条款页面，避免携带其他人的示例资料和空文档导致的构建错误。
- 隔离本机测试账户完成真实 HTTP 创建、签出、本地修改、回传、发布；过期基准版本返回 409；公开响应包含发布内容，不含所属账号、草稿、历史或密钥。本地状态文件没有访问令牌。
- 两个公开来源通过主站 Cordis 操作读取成功。文档贡献保留已有登录和审核流程；尚未验证真实清舟账号到文档账号的统一登录。
- 浏览器通过独立开发入口验证真实工作台与公开阅读组件，完成 390px 手机和桌面布局、深色阅读、矢量轮圈与座舱相反旋转，以及文档粒子背景检查。完整主站登录后的整页导航仍需在实际账户环境补验。
- 新增功能的 ESLint / 样式检查通过；扩大到既有代理文件时发现原有 3 处 `console.log` 规则错误，未在本轮改动它们。
- Agent 使用模拟模型端口验证草稿行为与账号隔离；尚未调用真实模型服务。当前没有部署线上。
- 验收后已停止隔离的 mock 身份后端。文档与博客开发预览保留；正式使用工作台需启动清舟正常认证的后端。

## 博客工作台 UI 精修（2026-10-09）

- 直接复用清舟的 NavPanel、NavItem、NavHeader 与组件主题；移除右上角跨站返回按钮和常驻说明。文章设置、本地命令与版本历史收进弹窗。
- 标题、正文与文章元信息分别编辑；修改正文保留原有发布元信息和自定义字段。新增 3 项内容编辑测试通过，清舟类型检查、ESLint 与样式检查通过。
- 独立开发入口验证实际组件的桌面、390px 手机与深色主题，手机无横向溢出。隔离本机账户通过实际 Cordis 插件完成文章切换、保存与发布；完整登录环境及真实模型调用仍沿用上述待补验范围。

## 完整主站与社区验收（2026-10-09）

- 已切回真实 Next.js 后端（3010）与 Vite SPA（9876），停止用于隔离站点验收的模拟身份后端。主站登录与社区导航通过真实浏览器验证。
- 社区公开详情在客户端令牌被上游拒绝时使用独立匿名客户端重试一次，不修改原有账号客户端；技能、Agent、MCP 详情恢复。推荐列表失败不影响已读取的详情，认证或网络失败显示可重试状态，真实 404 保留不存在状态。
- 公开请求的令牌隔离、重试次数与拒绝访问，以及市场和发现服务共 71 项测试通过；清舟类型检查通过。
