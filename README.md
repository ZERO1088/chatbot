<a href="https://chatbot.ai-sdk.dev/demo">
  <img alt="Chatbot" src="app/(chat)/opengraph-image.png">
  <h1 align="center">Chatbot</h1>
</a>

<p align="center">
    Chatbot (formerly AI Chatbot) is a free, open-source template built with Next.js and the AI SDK that helps you quickly build powerful chatbot applications.
</p>

<p align="center">
  <a href="https://chatbot.ai-sdk.dev/docs"><strong>Read Docs</strong></a> ·
  <a href="#features"><strong>Features</strong></a> ·
  <a href="#model-providers"><strong>Model Providers</strong></a> ·
  <a href="#deploy-your-own"><strong>Deploy Your Own</strong></a> ·
  <a href="#running-locally"><strong>Running locally</strong></a>
</p>
<br/>

## 我的个人修改说明 (Personal Modifications)

> 本仓库 fork 自 Vercel 的 AI Chatbot 模板，下面是**我在本地做的个人改动**，与上游无关。
> 上游模板的原始说明保留在本文档后半部分。
>
> 四项改动：① localStorage 会话历史持久化 · ② DeepSeek 模型直连支持 · ③ 深色主题与侧边栏优化 ·
> ④ 本地开发免数据库（早期所做，一并记录）。

### 1. localStorage 会话历史持久化（刷新后对话还在）

原来的实现把聊天记录放在服务端（Postgres / 内存），一旦服务端那份数据不在了（重启 dev server、
热更新把内存存储重置、或根本没配数据库），刷新页面就看不到当前对话。现在浏览器里也存了一份，
刷新页面后对话依然在。

| 文件 | 作用 |
| --- | --- |
| `lib/local-history.ts`（新增） | localStorage 存储层。单一带版本号的 key `chatbot.local-history.v1`；写入去抖 400ms，并在 `pagehide` / 标签页隐藏时强制落盘；最多保留 50 个会话；超出配额时自动丢弃最旧的会话而不是报错。 |
| `hooks/use-local-chats.ts`（新增） | 用 `useSyncExternalStore` 把存储层接到 React，服务端渲染返回空列表，因此没有 hydration 警告。 |
| `hooks/use-active-chat.tsx` | 打开会话时先从 localStorage 立即恢复内容，再把服务端返回的消息**按消息 id 做并集**合并进来（同一条消息以服务端版本为准，两边各自多出来的部分都保留），避免任何一边把对话截断；流式输出过程中持续写回 localStorage。 |
| `components/chat/sidebar-history.tsx`、`sidebar-history-item.tsx` | 侧边栏把"只存在于本浏览器"的会话也列出来，并显示 `Local` 小标签；删除会话时同时删除本地副本。 |
| `components/chat/app-sidebar.tsx` | "Delete all" 同时清空 localStorage。 |
| `components/chat/message-editor.tsx`、`hooks/use-chat-visibility.ts` | 对"只在浏览器里存在"的会话，服务端的删除尾部消息 / 切换可见性调用会失败，现在按尽力而为处理，不再打断编辑或分享操作。 |
| `components/chat/sidebar-user-nav.tsx` | 退出登录时清空本地历史，避免同一浏览器换账号后看到上一个人的会话。 |

会话标题直接取第一条用户消息（截断到 60 字），因此**不需要调用大模型**也能有标题。别人分享的
**只读**会话不会被镜像到本地（避免把别人的对话存进你的浏览器）。

### 2. 支持切换 DeepSeek 模型（直连 + AI Gateway 自动选择）

在模型选择里可以看到三个 DeepSeek 模型，并且**哪条调用链路可用就走哪条**：

- 配置了 `DEEPSEEK_API_KEY` → 直连官方 `https://api.deepseek.com/v1`（可用 `DEEPSEEK_BASE_URL` 改地址）；
- 没配置 → 继续走 Vercel AI Gateway（原模板行为，其它模型不受影响）。

| 文件 | 作用 |
| --- | --- |
| `lib/ai/deepseek-provider.ts`（新增） | 自己实现的 OpenAI 兼容 `LanguageModelV3` provider（**没有引入任何新依赖**）：请求体构造、SSE 流式解析、`reasoning_content` 思维链、tool calls 增量拼接、token 用量统计、错误信息透传。 |
| `lib/ai/providers.ts` | 按上面的规则选择模型；标题生成在直连模式下用 `deepseek-chat`，这样没有 Gateway 额度也能生成标题。 |
| `lib/ai/models.ts` | 新增 `deepseek/deepseek-reasoner`、`deepseek/deepseek-chat`，默认模型改为 `deepseek/deepseek-v3.2`；为每个模型补上**静态能力声明**（tools / reasoning）作为兜底，并给 Gateway 元数据查询加 2.5s 超时——否则网络不通时会误判为"不支持工具/推理"，甚至让每条消息先卡十几秒。 |
| `app/(chat)/api/models/route.ts` | 额外返回 `deepseekDirect`，模型选择器据此在 DeepSeek 条目上显示 `Direct` 标签。 |

模型 id 对应关系（UI 用 Gateway 风格 id，官方 API 用 DeepSeek 自己的名字）：

| UI 模型 id | 直连时的官方模型 |
| --- | --- |
| `deepseek/deepseek-v3.2` | `deepseek-chat` |
| `deepseek/deepseek-chat` | `deepseek-chat` |
| `deepseek/deepseek-reasoner` | `deepseek-reasoner` |

`DeepSeek Reasoner`（thinking 模式）默认声明为**不支持工具调用**：DeepSeek 对 thinking 模式的
function calling 没有保证，一旦工具 schema 被拒就会整轮失败；如果你的账号支持，把 `lib/ai/models.ts`
里那条的 `capabilities.tools` 改成 `true` 即可（Gateway 可达时以 Gateway 返回的元数据为准）。

另外，所选模型本来只存在 Cookie 里、且只在打开已存在会话时才生效；现在客户端一挂载就会读回该
Cookie（并校验是否还在模型列表里），刷新页面后选择不会丢。

### 3. UI 优化（深色主题 + 侧边栏）

- `app/globals.css`：深色主题从纯灰改成**冷调石板灰**（hue 258），页面更深、卡片/侧边栏层次更清楚，
  次要文字对比度按 WCAG 计算从 4.63:1 提升到 5.76:1（侧边栏上为 6.00:1）。
- `app/layout.tsx`：`defaultTheme` 改为 `dark`（想恢复跟随系统就改回 `"system"`），并把
  `theme-color` 元信息改成与新背景色完全一致的 `#101316`。
- 侧边栏：本地历史立即渲染（不再因为服务端历史为空而一直显示骨架屏 / "Loading..."），
  本地会话带 `Local` 标签，"Delete all" 一并清理本地数据。

### 4. 本地开发免数据库（`DEV_BYPASS_DB=1`，早期改动）

为了在没有 Postgres / 登录的情况下开发 UI：

- `lib/dev-bypass.ts`、`lib/db/mock.ts`（新增）：内存版数据库，实现了 `lib/db/queries.ts` 用到的查询形态；
- `lib/db/queries.ts`：`DEV_BYPASS_DB=1` 时走内存实现，否则完全保持原样；
- `app/(auth)/auth.ts`：返回固定的本地 guest 会话；`proxy.ts`：跳过跳转 guest 登录；
- `.env.local` 里 `DEV_BYPASS_DB=1`，生产环境（`NODE_ENV=production`）自动忽略。

内存数据在 dev server 重启 / 热更新后就会丢失**（这正是第 1 项 localStorage 持久化要解决的问题）**。
回退：删掉 `.env.local` 里的 `DEV_BYPASS_DB` 那一行即可恢复 Postgres + 登录。

> 顺带说明：仓库根目录里 `_probe-*.ts`、`_inspect-drizzle.ts`、`_verify-http.mjs`、`_bypass.test.ts`、
> `_hook-boot.mjs`、`_server-only-hook.mjs`、`tsconfig.check.json` 是当时排查用的临时脚本，可以直接删。

### 5. 环境变量

| 变量 | 是否必需 | 说明 |
| --- | --- | --- |
| `DEV_BYPASS_DB` | 仅在无数据库本地开发时 | `1` = 免 Postgres / 免登录 |
| `DEEPSEEK_API_KEY` | 想直连 DeepSeek 时 | 官方 key；设置了就直连，不设置就走 AI Gateway |
| `DEEPSEEK_BASE_URL` | 可选 | 默认 `https://api.deepseek.com/v1`，可指向代理/自建网关 |
| `AI_GATEWAY_API_KEY` | 走 Gateway 时 | 非 Vercel 部署需要；Vercel 上用 OIDC 自动鉴权 |
| `AUTH_SECRET` | 是 | 本仓库里是本地开发用的固定值 |

> 上游模板引用的 `.env.example` 已被删除（早期免数据库改动的一部分），变量以上表为准。
> `.env.local` 里的 `AI_GATEWAY_API_KEY` 目前是占位符 `****`，要用 Gateway 的模型请填真实 key。

### 6. 怎么验证这些改动

以下命令在 **`chatbot/` 的上一级目录**（也就是 `F:\GOOD Project\ai-chat`，两个验证脚本所在处）执行：

```bash
# 类型检查
node chatbot/node_modules/typescript/bin/tsc --noEmit --incremental false -p chatbot/tsconfig.check.json

# DeepSeek 直连 provider 的验证脚本（用假 fetch，不需要联网／不需要 key）
node _verify-deepseek.ts

# localStorage 会话存储的验证脚本（用假的 window/localStorage，不需要浏览器）
node _verify-local-history.ts
```

`_verify-deepseek.ts` 覆盖 17 项断言：请求体构造、SSE 分包重组、
`reasoning_content`、tool calls 参数拼接（含**并行工具调用不能合并**的回归用例）、token 用量映射、
错误透传，以及**真实** `streamText()` / `generateText()` 消费该 provider 的端到端集成。

`_verify-local-history.ts` 覆盖 23 项断言：标题推导、消息按 id 合并（含"较短副本不能改变顺序"的
回归用例）、保存/读取、**用一个全新的模块实例模拟"刷新页面"后仍能读到会话**、侧边栏快照的引用稳定性
（流式输出时不会反复重渲染侧边栏）、订阅通知时机、删除/清空、50 个会话上限与"被淘汰的会话不会
残留在侧边栏"、localStorage 配额不足时的降级、以及数据损坏 / 字段缺失时的容错。

> 说明：这些改动是在一台**没有外网、且沙箱禁止 fork 子进程**的机器上完成的，因此直连链路是用假
> transport 验证的（请求/响应映射已全部断言），没有对真实 DeepSeek API 发过请求，也**没有**跑过
> 浏览器端 / Playwright 的端到端测试。你本地 `pnpm dev` 起来后，建议人工确认一遍：刷新页面后对话
> 是否还在、切到 DeepSeek 是否能正常回复。

---

## Features (上游原文，以下内容未改动)

- [Next.js](https://nextjs.org) App Router
  - Advanced routing for seamless navigation and performance
  - React Server Components (RSCs) and Server Actions for server-side rendering and increased performance
- [AI SDK](https://ai-sdk.dev/docs/introduction)
  - Unified API for generating text, structured objects, and tool calls with LLMs
  - Hooks for building dynamic chat and generative user interfaces
  - Supports OpenAI, Anthropic, Google, xAI, and other model providers via AI Gateway
- [shadcn/ui](https://ui.shadcn.com)
  - Styling with [Tailwind CSS](https://tailwindcss.com)
  - Component primitives from [Radix UI](https://radix-ui.com) for accessibility and flexibility
- Data Persistence
  - [Neon Serverless Postgres](https://vercel.com/marketplace/neon) for saving chat history and user data
  - [Vercel Blob](https://vercel.com/storage/blob) for efficient file storage
- [Auth.js](https://authjs.dev)
  - Simple and secure authentication

## Model Providers

This template uses the [Vercel AI Gateway](https://vercel.com/docs/ai-gateway) to access multiple AI models through a unified interface. Models are configured in `lib/ai/models.ts` with per-model provider routing. Included models: Mistral, Moonshot, DeepSeek, OpenAI, and xAI.

### AI Gateway Authentication

**For Vercel deployments**: Authentication is handled automatically via OIDC tokens.

**For non-Vercel deployments**: You need to provide an AI Gateway API key by setting the `AI_GATEWAY_API_KEY` environment variable in your `.env.local` file.

With the [AI SDK](https://ai-sdk.dev/docs/introduction), you can also switch to direct LLM providers like [OpenAI](https://openai.com), [Anthropic](https://anthropic.com), [Cohere](https://cohere.com/), and [many more](https://ai-sdk.dev/providers/ai-sdk-providers) with just a few lines of code.

## Deploy Your Own

You can deploy your own version of Chatbot to Vercel with one click:

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/templates/next.js/chatbot)

## Running locally

You will need to use the environment variables [defined in `.env.example`](.env.example) to run Chatbot. It's recommended you use [Vercel Environment Variables](https://vercel.com/docs/projects/environment-variables) for this, but a `.env` file is all that is necessary.

> Note: You should not commit your `.env` file or it will expose secrets that will allow others to control access to your various AI and authentication provider accounts.

1. Install Vercel CLI: `npm i -g vercel`
2. Link local instance with Vercel and GitHub accounts (creates `.vercel` directory): `vercel link`
3. Download your environment variables: `vercel env pull`

```bash
pnpm install
pnpm db:migrate # Setup database or apply latest database changes
pnpm dev
```

Your app template should now be running on [localhost:3000](http://localhost:3000).
