# DeepSeek Harness Skills & MCPs 分组管理器

**DeepSeek Harness Skills & MCPs Group Manager** — DSH 插件:分组管理 Skills、过滤模型技能目录、独立开关 MCP 服务器,左侧面板一键管理。

> A DSH plugin that groups Skills, filters the model skill catalog, toggles MCP servers independently, and manages everything from a left panel.

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
- **🔌 MCP 管理 / MCP Management** — 以 profile 的 `cordis.patch.yml` 为唯一事实源:枚举 loader 组合中的全部 MCP 服务器(含实时状态与工具数),启停/增删改直接编辑补丁文件,由宿主 HMR 热重载真实生效(无需重启);支持一键连接探测(独立客户端 `initialize` + `tools/list`,8s 超时)。
- **💾 持久化 / Persistence** — `~/.dsh/mcp-skill-manager/state.json`(原子写)仅存分组;下次会话默认沿用上次分组设置。
- **🖥️ UI** — 对话框左侧分组管理面板(`shell.overlay`)+ 会话头部开关(`conversation.session.header.actions`,带 "Skills&MCPs" 标签)。纯浮动面板,不修改产品布局。

---

## 📦 安装 / Install

```bash
# 从本 fork 的 git 仓库安装(dsh plugin add 底层是 pnpm add,支持 git URL)
dsh plugin --profile web add https://github.com/oierxjn/dsh-skills-mcp-group-manager

# 或本地开发时从克隆目录 link: 安装
dsh plugin --profile web add link:E:\path\to\dsh-skills-mcp-group-manager

# 重启 web profile 进程后生效(当前 GUI 由 dsh web 提供,重启后刷新页面)
```

> **为什么无需额外步骤?** 宿主半插件保持纯手写 JS、零构建;仅有的两个运行时依赖(`js-yaml`、`@modelcontextprotocol/sdk`,见 `dependencies`)在安装时由 pnpm 自动落盘,且均为惰性加载——即使 `link:` 安装缺少 node_modules,插件与分组功能仍可启动,仅 MCP 编辑/探测会报出明确错误。

> **npm 包说明** 本仓库是自行维护的 fork,不发布到 npm registry;`dsh plugin add dsh-skills-mcp-group-manager`(npm 包名)安装的是上游版本,不含本 fork 的改动。

## 🗑️ 卸载 / Uninstall(数据随插件一并删除)

```bash
dsh plugin --profile web remove dsh-skills-mcp-group-manager
```

卸载时 pnpm 会执行包的 `postuninstall` 脚本(`scripts/cleanup.mjs`),删除整个状态目录 `~/.dsh/mcp-skill-manager/`(含 `state.json`),分组随插件一同移除。手动删除亦可:`rm -rf ~/.dsh/mcp-skill-manager`。注意:MCP 服务器行写在 profile 的 `cordis.patch.yml` 里,卸载不会触碰该文件,需要时在面板或文件中手动删除。

---

## 🧩 组成 / Structure

| 文件 | 说明 |
| --- | --- |
| `lib/index.js` | Host 半插件:状态模型、skill 目录过滤(shadow provider `skill-manager-filter`)、MCP 枚举/启停/增删改(编辑 `cordis.patch.yml`,HMR 热生效)与连接探测、13 个 `manager_*` 工具、RPC 路由 `/plugins/dsh-skills-mcp-group-manager/rpc` |
| `lib/client.js` | Client 半插件:左侧分组管理面板 + 会话头部开关;MCP 卡片列表(状态徽标/探测/编辑) |
| `lib/state.js` | 纯状态逻辑(零依赖):分组操作 + MCP 配置的字段级校验 |
| `lib/store.js` | 分组状态存储(原子写 + 序列化写链 + 容错读取)+ 共享原子写辅助 |
| `lib/patch.js` | `cordis.patch.yml` 读写(insert 行 / `{id,name,disabled}` 覆写行,`!!js` 保留,原子写) |
| `lib/status.js` | 从 loader entries 枚举 MCP 服务器(fiber 相位镜像 + `mcp__<server>__*` 工具计数) |
| `lib/probe.js` | 独立 MCP 客户端连接探测(`initialize` + `tools/list`,8s 超时,永不抛出) |
| `scripts/cleanup.mjs` | `postuninstall` 清理脚本 |
| `cordis.patch.yml` | bundle 补丁,把插件行插入宿主组合 |

## 🛠️ 工具 / Tools

`manager_groups_list/create/delete/rename/set_enabled/add_skill/remove_skill`、`manager_skills_list`、`manager_mcp_list/toggle/add/update/remove`(语义 = 编辑 `cordis.patch.yml`)。连接探测仅走 RPC(`manager.mcp.probe`),不进工具面。

## ⚠️ Breaking change(0.3.x → 0.4.0)

- **MCP 配置的单一事实源改为 profile 的 `cordis.patch.yml`**(默认 `~/.dsh/profiles/web/cordis.patch.yml`,可用插件行 config 的 `patchFile`/`profile` 覆盖)。`state.json` 的 `mcp` 段被弃用且不做迁移:旧版中添加的用户 MCP 服务器与禁用标记需在面板重新添加/停用。
- **启停语义变更**:旧版对 profile 服务器做 per-agent 工具软禁用(tools.restrict)、对用户服务器动态挂载;0.4.0 改为编辑补丁文件、由宿主 HMR 热重载 loader 树,真实启停。对 bundle/profile 定义的服务器执行停用会在补丁文件追加 `{id, name, disabled}` 覆写行。
- MCP 工具与 RPC 参数从 `serverName` 改为 loader **条目 id**(`manager_mcp_toggle/remove/update`、`manager.mcp.*`);新增 `manager_mcp_update` 工具与 `manager.mcp.probe` RPC;RPC 错误由字符串改为结构化 `{ code, message, fields? }`。
- 分组功能(state.json 的 `groups` 段)不受影响。

---

## 📄 License

[MIT](LICENSE) © [SeverusZh](https://github.com/SeverusZh)(上游原作者),fork 由 [oierxjn](https://github.com/oierxjn) 维护
