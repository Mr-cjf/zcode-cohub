# zcode-cohub

ZCode 中文智能体编排插件。将 `oh-my-opencode-cohub` 的 12 代理编排体系移植到 ZCode 平台，采用 **Skills + MCP Server** 混合架构。

## 代理清单

| Skill | 角色 | 权限 |
|-------|------|------|
| `orchestrator` | 纯调度——分析需求→委派→审核 | 只调度 |
| `planner` | 方案制定——综合需求+信息+规范输出任务分解 | 只读+Web |
| `oracle` | 架构审查 / 代码审查 / YAGNI 简化 / 复杂调试 | 只读+Web |
| `librarian` | 官方文档 / API / GitHub 研究 | 只读+Web |
| `explorer` | 代码库搜索定位——grep / glob / AST | 只读 |
| `designer` | UI/UX 设计实现 / 视觉润色 / 响应式布局 | 读写 |
| `fixer` | 代码修改 / 构建 / 测试执行 | 读写+Bash |
| `observer` | 图片 / PDF / 截图视觉分析 | 只读 |
| `council` | 多模型并行共识 | 决策用 |
| `rule-user` | 用户级 `~/.zcode/AGENTS.md` 分析 | 只读 |
| `rule-project` | 项目 `AGENTS.md` 分析 | 只读 |
| `rule-app` | `.zcode/rules/*.md` 分析 | 只读 |

除 `orchestrator` 外的 11 个角色同时是**用户级 subagent**（模板见 `agents-template/`，安装时铺设到 `~/.zcode/agents/`），可在 ZCode 设置里逐个指定模型；`orchestrator` 是主会话调度者，只作为 skill 存在，不会被 spawn。

## 架构

```
zcode-cohub/
├── .zcode-plugin/plugin.json    # ZCode 插件清单
├── skills/                       # 12 个 ZCode skills（提示词唯一源文件）
├── agents-template/             # 11 个角色 agent 模板（生成物，install 铺设到 ~/.zcode/agents/）
├── hooks/hooks.json             # Hook 注册（中文注入 / Job Board / 编排提醒）
├── src/                         # MCP Server 源码
│   ├── index.ts                 # MCP Server 入口
│   ├── tools/                   # delegate / council / job-control
│   ├── context/                 # 上下文共享引擎
│   ├── hooks/                   # Hook 脚本
│   └── utils/                   # 工具函数
└── scripts/                     # generate-skills（技能生成）/ generate-agents（角色 agent 模板生成）/ install（ZCode 注册 + 角色 agent 铺设）
```

## MCP 工具

| 工具 | 功能 |
|------|------|
| `co_delegate` | 提示词装配器——匹配 skill → 登记任务/上下文 → 返回 `subagent_type` / `agent_prompt` / `inline_prompt`（**不 spawn**，由主代理用 Agent 工具两步协议 spawn） |
| `co_council` | 多模型并行共识 |
| `co_close_job` | 取消作业 |

## 角色模型分配

除 `orchestrator` 外的 11 个角色同时是**用户级 subagent**，模型与主会话解耦——在 ZCode **Settings → Subagents** 里可逐个角色指定模型（如 `co-explorer` 用便宜的快速模型、`co-oracle` 用强推理模型）。

| 要点 | 说明 |
|------|------|
| model 格式 | `<providerId>/<modelId>` 或别名（`inherit` / `lite` 等）；模板默认一律 `model: inherit` |
| 生效时机 | 设置界面改动后需**新开会话**才生效 |
| 安装 merge 策略 | 脚本管理键 `name` / `description` / `tools` 与正文强制更新；用户键 `model` / `thoughtLevel` / `color` / `maxTurns` / `permissionMode` / `background` / `disallowedTools` / `skills` / `injectAgentsMd` / `mcpServers` **存在即保留**（目标缺失该键时才补模板值）。frontmatter 解析失败或存在**重复键**（ZCode loose YAML 后写胜出，merge 会改变实际生效值）则原样保留并告警；正文被模板覆盖时打印提示 |
| 安装参数 | `--force-agents` 全量重置（连用户键一起覆盖为模板值）；`--no-agents` 跳过角色 agent 铺设；`--dry-run` 只打印变更，不写任何文件 |

11 个角色 agent 模板默认带 `maxTurns: 12`（覆盖平台 subagent 默认 4），给多步委派与批量读取留足轮次；`maxTurns` 属用户键——install 时目标已有该值则保留用户设置。

## 构建

**依赖 Bun**：脚本内部实际执行 `bun run` / `bun build` / `bun test`，必须先安装 Bun（npm 仅作入口）。开发环境为 Windows + Git Bash，脚本统一用 bun 执行。

```bash
npm run build       # generate-skills → generate-agents → 打包 src/index.ts → tsc 仅生成 .d.ts
npm run build:hooks # 单独构建 hook 脚本（chinese-inject + job-board + orchestrate-remind → dist/hooks）
npm run test        # 运行测试（bun test ./src）
```

无独立 lint/typecheck 脚本，类型检查由 build 末尾的 `tsc --emitDeclarationOnly` 承担。

`bun scripts/generate-agents.ts --check` 做漂移检测：比对 `agents-template/` 与 `skills/*/SKILL.md`，不一致（缺模板 / 内容漂移 / 多余模板）时退出码为 1。

## 安装

```bash
bun scripts/install.ts   # 开发模式加 --dev
```

安装按 ZCode 真实机制注册插件（marketplace source 相对路径、known_marketplaces、installed_plugins、enabledPlugins、数据目录 `~/.zcode/cli/plugins/data/zcode-cohub@local`），并**铺设 11 个角色 agent 到 `~/.zcode/agents/`**——保留用户在设置界面改过的模型等用户键，铺完后在 Settings → Subagents 即可逐角色选模型。

| 参数 | 作用 |
|------|------|
| `--force-agents` | 全量覆盖角色 agent（连 `model` 等用户键一起重置为模板值） |
| `--no-agents` | 跳过角色 agent 铺设 |
| `--dry-run` | 只打印将要做的变更，不写任何文件 |
| `--dev` | 开发模式：非 Windows 平台对组件建 symlink |

## 源码地图

| 找什么 | 去哪里 |
|--------|--------|
| Skill 提示词源文件 | `skills/*/SKILL.md`（YAML frontmatter 定义 name/description） |
| 技能生成脚本 | `scripts/generate-skills.ts` |
| 角色 agent 模板生成 | `scripts/generate-agents.ts`（从 `skills/*/SKILL.md` 生成 11 个模板，跳过 orchestrator；`--check` 漂移检测） |
| 角色 agent 模板源（生成物，勿手编） | `agents-template/*.md`（改 `skills/*/SKILL.md` 后重新生成，install 铺设到 `~/.zcode/agents/`） |
| 安装脚本 | `scripts/install.ts`（构建产物安装 + ZCode 注册 + 角色 agent 铺设） |
| 生成的技能简报（勿手编） | `src/skills-briefs.ts` |
| MCP Server 入口 | `src/index.ts`（switch 分发 3 个工具） |
| 委托工具 | `src/tools/delegate.ts`（返回 `subagent_type` / `agent_prompt` / `inline_prompt` 装配结果，不 spawn） |
| 委员会工具 | `src/tools/council.ts` |
| 作业控制工具 | `src/tools/job-control.ts` |
| 上下文引擎 | `src/context/`（engine / extractor / formatter / strategy / types） |
| 任务追踪 | `src/tracker.ts` |
| 工具函数 | `src/utils/log.ts` |
| Hook 脚本 | `src/hooks/`（chinese-inject / job-board / orchestrate-remind），经 `hooks/hooks.json` 注册 |

## 常见陷阱

| 陷阱 | 后果 | 正确做法 |
|------|------|---------|
| 直接编辑 `src/skills-briefs.ts` 或 `agents-template/*.md` | 均为生成物（文件头标注 DO NOT EDIT），下次构建/生成覆盖 | 编辑 `skills/*/SKILL.md` 源文件后重新构建 |
| 在插件根放 `agents/` 目录 | ZCode 会当作**插件级 agent** 注册，优先级高于用户级，**覆盖用户在设置界面选的模型**，角色模型分配改造失效 | 角色 agent 模板必须放 `agents-template/`，且不得打包进插件（`package.json` 的 `files` 已排除，`install.ts` / `generate-agents.ts` 均有护栏告警） |
| 在 `agents-template/` 里硬编码 provider UUID 作为默认 model | 不同机器 provider ID 不同必崩 | 默认一律 `model: inherit`，由用户在设置界面选 |
| 忘记 `npm run build` | Hook 脚本不更新 | 修改 `src/hooks/` 后运行 `build:hooks` |
| 用 node 直接跑 install/脚本 | 脚本是 TypeScript，node 无法执行 | 统一用 bun |
| 认为子代理能并行执行全部工具调用 | Bash/Edit/Write/MCP 被平台按安全设计串行调度（只读白名单 Read/Grep/Glob/WebFetch/WebSearch 才同组并行），插件只能通过提示词引导批量提交 | 并行纪律文本的权威源是 11 个可 spawn 角色（orchestrator 除外）的 `skills/*/SKILL.md` 中统一的 `## 并行工具纪律` 小节（经 generate-agents 逐字进入角色 agent 系统提示），另有 `src/tools/delegate.ts` 的 `PARALLEL_DISCIPLINE` 常量注入任务提示层与降级路径；改完须 `npm run build` 并重装 |