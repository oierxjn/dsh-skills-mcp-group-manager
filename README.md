# DeepSeek Harness Skills & MCPs 分组管理器

**DeepSeek Harness Skills & MCPs Group Manager** — DSH 插件:分组管理 Skills、过滤模型技能目录、独立开关 MCP 服务器,在设置页集中管理。

> A DSH plugin that groups Skills, filters the model skill catalog, toggles MCP servers independently, and manages everything from the settings page.

[![license](https://img.shields.io/npm/l/dsh-skills-mcp-group-manager.svg?style=flat-square)](LICENSE)
[![GitHub release](https://img.shields.io/github/v/release/oierxjn/dsh-skills-mcp-group-manager?style=flat-square&logo=github)](https://github.com/oierxjn/dsh-skills-mcp-group-manager/releases)
[![GitHub stars](https://img.shields.io/github/stars/oierxjn/dsh-skills-mcp-group-manager?style=flat-square&logo=github)](https://github.com/oierxjn/dsh-skills-mcp-group-manager/stargazers)
[![node](https://img.shields.io/badge/node-%3E%3D18-brightgreen?style=flat-square&logo=node.js)](package.json)

---

> [!IMPORTANT]
> **Fork 维护声明 / Fork notice** — 本仓库 fork 自 [SeverusZh/dsh-skills-mcp-group-manager](https://github.com/SeverusZh/dsh-skills-mcp-group-manager),自 0.4.0 起由 [oierxjn](https://github.com/oierxjn) **自行维护,不再向上游提交 PR**。分支模型:**默认分支 `downstream` 承载全部维护工作;`main` 是上游的纯镜像**,只随 `upstream` remote fast-forward,不直接提交。向上游同步用 `git fetch upstream`(remote `upstream` 指向上游);问题与 PR 请提到本仓库(目标分支 `downstream`)。

---

## ✨ 功能特性 / Features

- **🎯 Skill 分组 / Skill Groups** — 创建/重命名/删除分组,分组可折叠;成员与挑选器均为列表 + 多选,支持搜索过滤后的全选/全不选与批量增删。
- **🧠 注入过滤 / Injection Filtering** — 上下文只注入启用分组中出现的 Skill(并集去重,一次一个);未分组 Skill 默认不注入;切换分组实时刷新目录。
- **🧵 按会话分组 / Per-session Groups** — 每个会话可脱离全局独立勾选启用的分组(会话头部按钮弹出);未设置的会话跟随全局。详见下文「按会话分组」。
- **🔌 MCP 管理 / MCP Management** — 以 profile 的 `cordis.patch.yml` 为唯一事实源:枚举 loader 组合中的全部 MCP 服务器(含实时状态与工具数),启停/增删改直接编辑补丁文件,由宿主 HMR 热重载真实生效(无需重启);支持一键连接探测(独立客户端 `initialize` + `tools/list`,8s 超时)。
- **💾 持久化 / Persistence** — `~/.dsh/mcp-skill-manager/state.json`(原子写)存分组与各会话覆写;下次会话默认沿用上次设置。
- **🖥️ UI** — 设置页两个分区(`settings.section`):「技能分组」(order 17)与「MCP」(order 18);会话头部按钮(`conversation.session.header.actions`,带 "Skills&MCPs" 标签)弹出本会话分组 popover,可直接勾选/新建分组。不修改产品布局。

---

## 📦 安装 / Install

```bash
# 从本 fork 的 git 仓库安装(dsh plugin add 底层是 pnpm add,支持 git URL)
dsh plugin --profile web add https://github.com/oierxjn/dsh-skills-mcp-group-manager

# 或本地开发时从克隆目录 link: 安装
dsh plugin --profile web add link:E:\path\to\dsh-skills-mcp-group-manager

# 重启 web profile 进程后生效(当前 GUI 由 dsh web 提供,重启后刷新页面)
```

> **为什么无需额外步骤?** 宿主半插件为 TypeScript 源码,构建产物(单文件 `lib/index.js` + `lib/types/*.d.ts`)已提交到 git,git 安装无需现场构建;仅有的两个运行时依赖(`js-yaml`、`@modelcontextprotocol/sdk`,见 `dependencies`)在安装时由 pnpm 自动落盘,且均为惰性加载——即使 `link:` 安装缺少 node_modules,插件与分组功能仍可启动,仅 MCP 编辑/探测会报出明确错误。

> **npm 包说明** 本仓库是自行维护的 fork,不发布到 npm registry;`dsh plugin add dsh-skills-mcp-group-manager`(npm 包名)安装的是上游版本,不含本 fork 的改动。

## 🗑️ 卸载 / Uninstall(数据随插件一并删除)

```bash
dsh plugin --profile web remove dsh-skills-mcp-group-manager
```

卸载时 pnpm 会执行包的 `postuninstall` 脚本(`scripts/cleanup.mjs`),删除整个状态目录 `~/.dsh/mcp-skill-manager/`(含 `state.json`),分组随插件一同移除。手动删除亦可:`rm -rf ~/.dsh/mcp-skill-manager`。注意:MCP 服务器行写在 profile 的 `cordis.patch.yml` 里,卸载不会触碰该文件,需要时在设置页「MCP」分区或文件中手动删除。

---

## 🧩 组成 / Structure

| 文件 | 说明 |
| --- | --- |
| `src/index.ts` | Host 半插件:状态模型、skill 目录过滤(shadow provider `skill-manager-filter`,按会话解析覆写)、MCP 枚举/启停/增删改(编辑 `cordis.patch.yml`,HMR 热生效)与连接探测、15 个 `manager_*` 工具、RPC 路由 `/plugins/dsh-skills-mcp-group-manager/rpc` |
| `src/state.ts` | 纯状态逻辑(零依赖):分组操作、按会话注入集合(`enabledSkillNamesFor`)+ MCP 配置的字段级校验 |
| `src/store.ts` | 分组与会话覆写状态存储(原子写 + 序列化写链 + 容错读取)+ 共享原子写辅助 |
| `src/patch.ts` | `cordis.patch.yml` 读写(insert 行 / `{id,name,disabled}` 覆写行,`!!js` 保留,原子写) |
| `src/status.ts` | 从 loader entries 枚举 MCP 服务器(fiber 相位镜像 + `mcp__<server>__*` 工具计数) |
| `src/probe.ts` | 独立 MCP 客户端连接探测(`initialize` + `tools/list`,8s 超时,永不抛出) |
| `src/types.ts` | 共享类型契约(仅类型,零运行时):ManagerState / McpServerConfig / PatchRow / 各 RPC 参数等 |
| `src/errors.ts` | 结构化错误 `McpError(code, message, fields?)`(RPC/tool 面统一错误码) |
| `src/tool-schemas.ts` | 纯工具 schema 数据 + `parameterSchema`/`valueSchema` 转换器 |
| `lib/index.js` | **构建产物**(`tsc → lib/types → tsdown`):host 半的单文件 ESM bundle(loader 的 import 目标) |
| `lib/types/*.d.ts` | **构建产物**:host 半的声明(发布面) |
| `lib/client.js` | Client 半插件(仍为手写经典脚本):设置页「技能分组」「MCP」两个分区 + 会话头部按会话分组 popover(可新建分组);MCP 卡片列表(状态徽标/探测/编辑) |
| `scripts/cleanup.mjs` | `postuninstall` 清理脚本 |
| `types/dsh.d.ts` | DSH 宿主平台面的环境声明(注入服务的最小成员面,全局可见) |
| `tsconfig.json` | `tsc` 构建配置(rootDir `src`,outDir `lib/types`) |
| `tsdown.config.ts` | host bundle 配置(entry `lib/types/index.js` → `lib/index.js`;生产依赖 external,其余内联) |
| `cordis.patch.yml` | bundle 补丁,把插件行插入宿主组合 |

## 🔨 构建与类型检查 / Build & Type Checking

宿主半侧为 TypeScript 源码,经官方同款链路构建:tsc 产出 `lib/types/*.{js,d.ts,map}`,tsdown 再打包为单文件 `lib/index.js`。**构建产物已提交到 git**(本 fork 不发布 npm,git 安装无需现场构建);`lib/types/*.js` 与 `*.map` 为中间产物,不入库。

```bash
npm install          # 开发依赖(typescript、tsdown、tsx、@types/*);装机依赖用 --legacy-peer-deps(见 package.json 说明)
npm run typecheck    # tsc --noEmit,检查 src/**/*.ts,当前 0 错误
npm test             # node --import tsx --test tests/*.test.mjs,行为锚点
npm run build        # tsc && tsdown,重新生成 lib/index.js + lib/types/*.d.ts
npm run check:built  # build 后 git diff --exit-code lib/,防产物漂移
```

约定:

- **共享契约集中在 `src/types.ts`**(仅类型模块,`import type { ... } from './types.ts'` 完全擦除,不产生运行时代码);宿主平台面(注入的 skills/tools/agents/loader/webServer 服务)在 `types/dsh.d.ts` 以全局环境声明描述。
- **类型转换只出现在边界**:不可信 JSON 入口(`args as unknown as X`)、惰性加载的第三方库(MCP SDK 的 exactOptionalPropertyTypes 不兼容处)、以及"运行时已由校验保证"的窄化点,均以显式转换并附注释。
- **`tests/**` 不在 tsc 范围内**:测试的价值在行为(以 `node --test` 为锚点),其 mock 双对象若按严格检查标注需要为宿主内部面发明完整类型,收益低于噪声;`lib/client.js` 同样暂未纳入(经典脚本加载格式,属后续切片)。


## 🧵 按会话分组 / Per-session Groups

默认情况下,所有会话共享全局的「启用分组」设置(设置页「技能分组」分区里的勾选)。点击会话头部的 **Skills&MCPs** 按钮可展开本会话的分组 popover(底部输入框可就地新建分组,分组的重命名/删除/成员管理在设置页进行):

- **跟随全局 / Follow global**(默认)— 会话使用全局启用分组的并集;全局勾选变化立即生效。
- **取消勾选「跟随全局」后**,该会话脱离全局,独立选择启用哪些分组;覆写值是显式的组 id 集合(空选择 = 该会话不注入任何分组 skill)。覆写与全局开关完全解耦:即使某分组被全局停用,会话覆写中勾选它仍会注入其 skill。
- 覆写只影响本会话,其他会话不受影响;重新勾选「跟随全局」即删除覆写、恢复全局行为。
- 覆写按会话 id 存在 `state.json` 的 `sessions` 段;会话 resume 沿用同一 id(设置保留),fork 出的新会话是新 id(跟随全局,不继承覆写)。
- 模型也可通过工具操作自己所在的会话:`manager_session_get`(查看覆写与生效分组)、`manager_session_set`(`enabledGroupIds: string[] | null`,`null` = 回到跟随全局)。

## 🛠️ 工具 / Tools

`manager_groups_list/create/delete/rename/set_enabled/add_skill/remove_skill`、`manager_skills_list`、`manager_session_get/set`(作用于调用方会话)、`manager_mcp_list/toggle/add/update/remove`(语义 = 编辑 `cordis.patch.yml`)。连接探测仅走 RPC(`manager.mcp.probe`),不进工具面。

## ⚠️ Breaking change(0.3.x → 0.4.0)

- **MCP 配置的单一事实源改为 profile 的 `cordis.patch.yml`**(默认 `~/.dsh/profiles/web/cordis.patch.yml`,可用插件行 config 的 `patchFile`/`profile` 覆盖)。`state.json` 的 `mcp` 段被弃用且不做迁移:旧版中添加的用户 MCP 服务器与禁用标记需在面板重新添加/停用。
- **启停语义变更**:旧版对 profile 服务器做 per-agent 工具软禁用(tools.restrict)、对用户服务器动态挂载;0.4.0 改为编辑补丁文件、由宿主 HMR 热重载 loader 树,真实启停。对 bundle/profile 定义的服务器执行停用会在补丁文件追加 `{id, name, disabled}` 覆写行。
- MCP 工具与 RPC 参数从 `serverName` 改为 loader **条目 id**(`manager_mcp_toggle/remove/update`、`manager.mcp.*`);新增 `manager_mcp_update` 工具与 `manager.mcp.probe` RPC;RPC 错误由字符串改为结构化 `{ code, message, fields? }`。
- 分组功能(state.json 的 `groups` 段)不受影响。

---

## 📄 License

[MIT](LICENSE) © [SeverusZh](https://github.com/SeverusZh)(上游原作者),fork 由 [oierxjn](https://github.com/oierxjn) 维护
