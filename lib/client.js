/**
 * dsh-mcp-skill-manager — client half (browser).
 *
 * A bundle-plugin client half: a classic script in the client-modules format
 * (`window.__ModuleLoader__.load({ id, factory })`). The factory is CJS-style
 * and may require only platform seed words (`react`, `react/jsx-runtime`,
 * `@deepseek-ai/dsh-client-ui-primitives`); everything else is self-contained.
 * The exports are the Cordis plugin face: `{ apply, inject }`.
 *
 * UI: two settings sections registered in the additive `settings.section`
 * slot (root scope) — "Skill groups" (create/rename/delete/enable, add/remove
 * member skills) and "MCP" (server list with live status, enable/disable,
 * add/edit/remove, on-demand connection probe) — plus a per-session groups
 * button in `conversation.session.header.actions` (session scope; props carry
 * `sessionId`, the entry remounts on session switch). The header button opens
 * a popover that edits ONLY that session's group selection (override ?? the
 * global toggles) via `manager.session.get/set` and can create a new group in
 * place; global management lives in the settings sections. Everything calls
 * the host RPC route `POST /plugins/dsh-skills-mcp-group-manager/rpc` (bundle
 * plugins have no `harness.handle`/`host.call`; the host serves the same
 * business logic over one JSON POST route with body { method, args } →
 * { ok, value } | { ok: false, error: { code, message, fields? } }). MCP
 * mutations edit the profile's cordis.patch.yml and the harness hot-reloads
 * the tree, so after every mutation the section re-reads immediately and
 * twice delayed (800/2400ms) while the HMR reload settles.
 *
 * Interaction model: loading / empty / error states; optimistic local updates
 * with rollback on RPC failure; busy gating.
 *
 * Lifecycle: every side effect is fiber-scoped — locale dictionaries and the
 * stylesheet are installed through ctx.effect (disposed on unload), slot
 * registrations go through ctx.slots.inject/register (fiber-owned), and all
 * component effects (measurement, yield, storage, event listeners) return
 * cleanups. No live data is serialized: only plain JSON from the RPC route.
 */
window.__ModuleLoader__.load({
  id: 'dsh-skills-mcp-group-manager',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
    let react = require('react');
    const h = react.createElement;

    // ── constants ──────────────────────────────────────────────────────────
    const RPC_PATH = '/plugins/dsh-skills-mcp-group-manager/rpc';
    const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
    const ENTRY_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

    // ── dictionaries ────────────────────────────────────────────────────────
    const zh = {
      'navGroups': '技能分组',
      'navMcp': 'MCP',
      'toggle.label': 'Skills&MCPs',
      'state.loading': '加载中…',
      'state.retry': '重试',
      'group.create': '新建',
      'group.createPlaceholder': '新分组名称',
      'group.empty': '还没有分组。创建一个分组并加入 skill,即可控制注入到会话的 skill 目录。',
      'group.members': '{count} 个 skill',
      'group.rename': '重命名',
      'group.delete': '删除分组',
      'group.expand': '展开分组',
      'group.collapse': '收起分组',
      'group.selectAll': '全选',
      'group.deselectAll': '全不选',
      'group.removeSelected': '移除选中({count})',
      'group.selectAllFiltered': '全选',
      'group.deselectAllFiltered': '全不选',
      'group.addSelected': '添加选中({count})',
      'group.deleteConfirm': '确定删除该分组?其成员 skill 不会从其他分组移除。',
      'group.detailTitle': '分组:{name}',
      'group.membersLabel': '成员 skill',
      'group.memberSearchPlaceholder': '搜索成员…',
      'group.noMembers': '该分组还没有成员 skill。',
      'group.pickerLabel': '添加 skill',
      'group.searchPlaceholder': '搜索 skill…',
      'group.noMatch': '没有匹配的 skill。',
      'group.allAdded': '全部 skill 已加入该分组。',
      'group.addSkill': '将 {skill} 加入分组',
      'group.removeSkill': '从分组移除 {skill}',
      'mcp.empty': '没有 MCP 服务器。',
      'mcp.emptyHint': '在下方表单添加,或直接编辑 profile 的 cordis.patch.yml。',
      'mcp.sourceUser': '用户',
      'mcp.sourceProfile': '配置',
      'mcp.tools': '{count} 个工具',
      'mcp.enable': '启用 {name}',
      'mcp.disable': '停用 {name}',
      'mcp.edit': '编辑 {name}',
      'mcp.remove': '删除 {name}',
      'mcp.removeConfirm': '确定删除 MCP 服务器 {name}({id}) 的补丁行?',
      'mcp.test': '测试连接',
      'mcp.cancel': '取消',
      'mcp.save': '保存',
      'mcp.add': '新增',
      'mcp.addTitle': '新增 MCP 服务器',
      'mcp.editTitle': '编辑 MCP 服务器:{name}',
      'mcp.formId': '条目 id(字母/数字/_/-)',
      'mcp.formName': 'serverName(字母/数字/_/-)',
      'mcp.formTransport': '传输方式',
      'mcp.formCommand': '命令(如 npx)',
      'mcp.formArgs': '参数(每行一个,可选)',
      'mcp.formEnv': '环境变量(每行 KEY=VALUE,可选)',
      'mcp.formCwd': '工作目录(可选)',
      'mcp.formUrl': 'URL(streamable-http)',
      'mcp.formHeaders': '请求头(每行 Key: Value,可选)',
      'mcp.formTimeout': '工具调用超时(ms)',
      'mcp.formFailStartup': '启动失败即报错',
      'mcp.statusConnected': '已连接({count})',
      'mcp.statusNoTools': '已激活,无工具',
      'mcp.statusFailed': '连接失败',
      'mcp.statusDisabled': '已停用',
      'mcp.statusLoading': '加载中',
      'mcp.statusPending': '待启动',
      'mcp.statusUnloading': '卸载中',
      'mcp.statusNotLoaded': '未加载',
      'mcp.probeOk': '探测成功:{ms}ms,{count} 个工具',
      'mcp.probeFail': '探测失败({ms}ms):{error}',
      'mcp.errIdRequired': '条目 id 必填',
      'mcp.errIdPattern': 'id 需匹配 ^[A-Za-z0-9_-]{1,64}$',
      'mcp.errIdTaken': '该 id 已被占用',
      'mcp.errNameRequired': 'serverName 必填',
      'mcp.errNamePattern': 'serverName 需匹配 ^[A-Za-z0-9_-]{1,32}$',
      'mcp.errNameTaken': '该 serverName 已被占用',
      'mcp.errUrlRequired': 'streamable-http 需要 http(s):// URL',
      'mcp.errCommandRequired': 'stdio 需要非空命令',
      'session.aria': '本会话 skill 分组',
      'session.title': '本会话 skill 分组',
      'session.popoverTitle': '本会话分组',
      'session.followGlobal': '跟随全局分组',
      'session.empty': '还没有分组。在下方创建一个。',
    };
    const en = {
      'navGroups': 'Skill groups',
      'navMcp': 'MCP',
      'toggle.label': 'Skills&MCPs',
      'state.loading': 'Loading…',
      'state.retry': 'Retry',
      'group.create': 'Create',
      'group.createPlaceholder': 'New group name',
      'group.empty': 'No groups yet. Create a group and add skills to control which skills are injected into sessions.',
      'group.members': '{count} skills',
      'group.rename': 'Rename',
      'group.delete': 'Delete group',
      'group.expand': 'Expand group',
      'group.collapse': 'Collapse group',
      'group.selectAll': 'Select all',
      'group.deselectAll': 'Deselect all',
      'group.removeSelected': 'Remove selected ({count})',
      'group.selectAllFiltered': 'Select all',
      'group.deselectAllFiltered': 'Deselect all',
      'group.addSelected': 'Add selected ({count})',
      'group.deleteConfirm': 'Delete this group? Its member skills are not removed from other groups.',
      'group.detailTitle': 'Group: {name}',
      'group.membersLabel': 'Member skills',
      'group.memberSearchPlaceholder': 'Search members…',
      'group.noMembers': 'This group has no member skills yet.',
      'group.pickerLabel': 'Add skills',
      'group.searchPlaceholder': 'Search skills…',
      'group.noMatch': 'No matching skills.',
      'group.allAdded': 'All skills are already in this group.',
      'group.addSkill': 'Add {skill} to the group',
      'group.removeSkill': 'Remove {skill} from the group',
      'mcp.empty': 'No MCP servers.',
      'mcp.emptyHint': 'Add one with the form below, or edit the profile cordis.patch.yml directly.',
      'mcp.sourceUser': 'user',
      'mcp.sourceProfile': 'profile',
      'mcp.tools': '{count} tools',
      'mcp.enable': 'Enable {name}',
      'mcp.disable': 'Disable {name}',
      'mcp.edit': 'Edit {name}',
      'mcp.remove': 'Remove {name}',
      'mcp.removeConfirm': 'Remove the patch rows of MCP server {name} ({id})?',
      'mcp.test': 'Test connection',
      'mcp.cancel': 'Cancel',
      'mcp.save': 'Save',
      'mcp.add': 'Add',
      'mcp.addTitle': 'Add MCP server',
      'mcp.editTitle': 'Edit MCP server: {name}',
      'mcp.formId': 'Entry id (letters/digits/_/-)',
      'mcp.formName': 'serverName (letters/digits/_/-)',
      'mcp.formTransport': 'Transport',
      'mcp.formCommand': 'Command (e.g. npx)',
      'mcp.formArgs': 'Args (one per line, optional)',
      'mcp.formEnv': 'Environment (KEY=VALUE per line, optional)',
      'mcp.formCwd': 'Working directory (optional)',
      'mcp.formUrl': 'URL (streamable-http)',
      'mcp.formHeaders': 'Headers (Key: Value per line, optional)',
      'mcp.formTimeout': 'Tool call timeout (ms)',
      'mcp.formFailStartup': 'Fail on startup error',
      'mcp.statusConnected': 'Connected ({count})',
      'mcp.statusNoTools': 'Active, no tools',
      'mcp.statusFailed': 'Failed',
      'mcp.statusDisabled': 'Disabled',
      'mcp.statusLoading': 'Loading',
      'mcp.statusPending': 'Pending',
      'mcp.statusUnloading': 'Unloading',
      'mcp.statusNotLoaded': 'Not loaded',
      'mcp.probeOk': 'Probe OK: {ms}ms, {count} tools',
      'mcp.probeFail': 'Probe failed ({ms}ms): {error}',
      'mcp.errIdRequired': 'Entry id is required',
      'mcp.errIdPattern': 'id must match ^[A-Za-z0-9_-]{1,64}$',
      'mcp.errIdTaken': 'That id is already taken',
      'mcp.errNameRequired': 'serverName is required',
      'mcp.errNamePattern': 'serverName must match ^[A-Za-z0-9_-]{1,32}$',
      'mcp.errNameTaken': 'That serverName is already taken',
      'mcp.errUrlRequired': 'streamable-http requires an http(s):// URL',
      'mcp.errCommandRequired': 'stdio requires a non-empty command',
      'session.aria': 'Skill groups for this session',
      'session.title': 'Skill groups for this session',
      'session.popoverTitle': 'This session',
      'session.followGlobal': 'Follow global groups',
      'session.empty': 'No groups yet. Create one below.',
    };

    /** Fallback translator when the framework `t` prop is unavailable. */
    function dictFor() {
      const lang = (typeof document !== 'undefined' && document.documentElement && document.documentElement.lang) || 'en';
      return lang.toLowerCase().startsWith('zh') ? zh : en;
    }
    function makeT(t) {
      if (typeof t === 'function') return t;
      const dict = dictFor();
      return (key, params) => {
        let text = dict[key] ?? key;
        if (params !== undefined) {
          for (const [name, value] of Object.entries(params)) {
            text = text.split(`{${name}}`).join(String(value));
          }
        }
        return text;
      };
    }

    // ── RPC client ─────────────────────────────────────────────────────────
    async function rpc(method, args) {
      const res = await fetch(RPC_PATH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method, args: args ?? {} }),
      });
      const data = await res.json();
      if (!data.ok) {
        // The host error is structured: { code, message, fields? }; `fields`
        // carries field-level validation messages the form displays inline.
        const raw = data.error;
        const message = (typeof raw === 'object' && raw !== null ? raw.message : raw) ?? `RPC ${method} failed`;
        const error = new Error(message);
        if (typeof raw === 'object' && raw !== null) {
          if (typeof raw.code === 'string') error.code = raw.code;
          if (raw.fields !== undefined) error.fields = raw.fields;
        }
        throw error;
      }
      return data.value;
    }
    function errorMessage(error) {
      return error instanceof Error ? error.message : String(error);
    }

    // ── icons (inline SVG, currentColor) ───────────────────────────────────
    function GearIcon({ size }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: '1.3', strokeLinecap: 'round', 'aria-hidden': true },
        h('circle', { cx: '8', cy: '8', r: '2.4' }),
        h('path', { d: 'M8 1.8v2M8 12.2v2M1.8 8h2M12.2 8h2M3.6 3.6l1.4 1.4M11 11l1.4 1.4M12.4 3.6L11 5M5 11l-1.4 1.4' }),
      );
    }
    function ChevronIcon({ size, direction }) {
      const paths = {
        left: 'M10 3L7 6l3 3',
        right: 'M6 3l3 3-3 3',
        down: 'M3 6l3 3 3-3',
        up: 'M3 9l3-3 3 3',
      };
      const d = paths[direction] ?? paths.down;
      return h('svg', { width: size, height: size, viewBox: '0 0 12 12', fill: 'none', stroke: 'currentColor', strokeWidth: '1.5', strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        h('path', { d }),
      );
    }
    function PlusIcon({ size }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 12 12', fill: 'none', stroke: 'currentColor', strokeWidth: '1.5', strokeLinecap: 'round', 'aria-hidden': true },
        h('path', { d: 'M6 2.5v7M2.5 6h7' }),
      );
    }
    function XIcon({ size }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 12 12', fill: 'none', stroke: 'currentColor', strokeWidth: '1.5', strokeLinecap: 'round', 'aria-hidden': true },
        h('path', { d: 'M3 3l6 6M9 3l-6 6' }),
      );
    }
    function PencilIcon({ size }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 12 12', fill: 'none', stroke: 'currentColor', strokeWidth: '1.3', strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        h('path', { d: 'M8.6 1.9l1.5 1.5L3.4 10H2V8.6L8.6 1.9Z' }),
        h('path', { d: 'M7.4 3.1l1.5 1.5' }),
      );
    }

    // ── selection logic (pure; exported as __logic for unit tests) ─────────
    /** Candidates for the picker: not already members, matching the query. */
    function filterCandidates(skills, members, query) {
      const q = query.trim().toLowerCase();
      return skills.filter((skill) =>
        !members.includes(skill.name)
        && (q.length === 0
          || skill.name.toLowerCase().includes(q)
          || (skill.description ?? '').toLowerCase().includes(q)));
    }
    /** Filter a member name list by the query (name match only). */
    function filterMembers(members, query) {
      const q = query.trim().toLowerCase();
      if (q.length === 0) return members;
      return members.filter((name) => name.toLowerCase().includes(q));
    }
    /** Toggle one name in a Set (immutable). */
    function toggleInSet(set, name) {
      const next = new Set(set);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    }
    /** Select every filtered candidate (union with the current selection). */
    function selectAllFiltered(filtered, selected) {
      const next = new Set(selected);
      for (const skill of filtered) next.add(skill.name);
      return next;
    }
    /** Deselect every filtered candidate (keeps non-filtered selections). */
    function clearAllFiltered(filtered, selected) {
      const next = new Set(selected);
      for (const skill of filtered) next.delete(skill.name);
      return next;
    }
    /** Select all members when not all are selected; clear them when all are. */
    function toggleAllMembers(members, selected) {
      const allSelected = members.length > 0 && members.every((name) => selected.has(name));
      const next = new Set(selected);
      if (allSelected) {
        for (const name of members) next.delete(name);
      } else {
        for (const name of members) next.add(name);
      }
      return next;
    }
    /** Append the selected names to the member list, deduped. */
    function addSelectedToGroup(members, selected) {
      const next = [...members];
      for (const name of selected) if (!next.includes(name)) next.push(name);
      return next;
    }
    /** Remove exactly the selected names from the member list. */
    function removeSelectedFromGroup(members, selected) {
      return members.filter((name) => !selected.has(name));
    }

    // ── group card ─────────────────────────────────────────────────────────
    function GroupCard({ t, group, skills, busy, onDelete, onRename, onSetEnabled, onAddSkills, onRemoveSkills }) {
      const [editing, setEditing] = react.useState(false);
      const [draft, setDraft] = react.useState(group.name);
      const [expanded, setExpanded] = react.useState(false);
      const commit = () => {
        const name = draft.trim();
        if (name.length > 0 && name !== group.name) onRename(name);
        setEditing(false);
      };
      return h('div', { className: 'msm-group', 'data-expanded': expanded || undefined },
        h('div', { className: 'msm-group-row' },
          h('button', {
            type: 'button',
            className: 'msm-group-caret',
            onClick: () => setExpanded((current) => !current),
            'aria-label': expanded ? t('group.collapse') : t('group.expand'),
            title: expanded ? t('group.collapse') : t('group.expand'),
          }, h(ChevronIcon, { size: 12, direction: expanded ? 'down' : 'right' })),
          h('input', {
            type: 'checkbox',
            className: 'msm-group-check',
            checked: group.enabled,
            disabled: busy,
            onChange: (event) => onSetEnabled(event.target.checked),
            'aria-label': t('group.members', { count: group.skills.length }),
          }),
          editing
            ? h('input', {
                className: 'msm-input msm-group-edit',
                value: draft,
                autoFocus: true,
                onChange: (event) => setDraft(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Enter') commit();
                  if (event.key === 'Escape') setEditing(false);
                },
                onBlur: commit,
              })
            : h('span', {
                className: 'msm-group-name',
                onClick: () => setExpanded((current) => !current),
                onDoubleClick: () => { setDraft(group.name); setEditing(true); },
                title: group.name,
              }, group.name),
          h('span', { className: 'msm-group-count' }, t('group.members', { count: group.skills.length })),
          h('div', { className: 'msm-group-actions' },
            h('button', {
              type: 'button',
              className: 'msm-icon-button',
              onClick: () => { setDraft(group.name); setEditing(true); },
              'aria-label': t('group.rename'),
              title: t('group.rename'),
              disabled: busy,
            }, h(PencilIcon, { size: 12 })),
            h('button', {
              type: 'button',
              className: 'msm-icon-button msm-danger',
              onClick: onDelete,
              'aria-label': t('group.delete'),
              title: t('group.delete'),
              disabled: busy,
            }, h(XIcon, { size: 12 })),
          ),
        ),
        expanded && h(GroupDetail, {
          t,
          group,
          skills,
          busy,
          onAddSkills: (names) => onAddSkills(group.id, names),
          onRemoveSkills: (names) => onRemoveSkills(group.id, names),
        }),
      );
    }

    // ── group detail (members list + picker, both multi-select) ────────────
    function GroupDetail({ t, group, skills, busy, onAddSkills, onRemoveSkills }) {
      const [query, setQuery] = react.useState('');
      const [memberQuery, setMemberQuery] = react.useState('');
      const [picked, setPicked] = react.useState(() => new Set());
      const [removing, setRemoving] = react.useState(() => new Set());
      const members = group.skills;
      const visibleMembers = filterMembers(members, memberQuery);
      const candidates = filterCandidates(skills, members, query);
      const visibleCandidates = candidates.slice(0, 50);
      return h('div', { className: 'msm-detail' },
        // ── selected members: searchable list with multi-select ────────────
        h('div', { className: 'msm-detail-head' },
          h('span', { className: 'msm-detail-label' }, t('group.membersLabel')),
          h('div', { className: 'msm-bulk-actions' },
            h('button', {
              type: 'button',
              className: 'msm-button msm-button-mini',
              disabled: busy || visibleMembers.length === 0,
              onClick: () => setRemoving((current) => selectAllFiltered(visibleMembers.map((name) => ({ name })), current)),
            }, t('group.selectAll')),
            h('button', {
              type: 'button',
              className: 'msm-button msm-button-mini',
              disabled: busy || visibleMembers.length === 0,
              onClick: () => setRemoving((current) => clearAllFiltered(visibleMembers.map((name) => ({ name })), current)),
            }, t('group.deselectAll')),
            h('button', {
              type: 'button',
              className: 'msm-button msm-button-mini msm-button-danger',
              disabled: busy || removing.size === 0,
              onClick: () => { onRemoveSkills([...removing]); setRemoving(new Set()); },
            }, t('group.removeSelected', { count: removing.size })),
          ),
        ),
        h('input', {
          className: 'msm-input',
          value: memberQuery,
          placeholder: t('group.memberSearchPlaceholder'),
          onChange: (event) => setMemberQuery(event.target.value),
        }),
        members.length === 0
          ? h('div', { className: 'msm-empty' }, t('group.noMembers'))
          : visibleMembers.length === 0
            ? h('div', { className: 'msm-empty' }, t('group.noMatch'))
            : h('div', { className: 'msm-list' },
                visibleMembers.map((name) => h('label', { key: name, className: 'msm-list-row' },
                  h('input', {
                    type: 'checkbox',
                    className: 'msm-row-check',
                    checked: removing.has(name),
                    disabled: busy,
                    onChange: () => setRemoving((current) => toggleInSet(current, name)),
                  }),
                  h('span', { className: 'msm-list-name', title: name }, name),
                )),
              ),
        // ── picker: search + filtered multi-select ─────────────────────────
        h('div', { className: 'msm-detail-head' },
          h('span', { className: 'msm-detail-label' }, t('group.pickerLabel')),
          h('div', { className: 'msm-bulk-actions' },
            h('button', {
              type: 'button',
              className: 'msm-button msm-button-mini',
              disabled: busy || visibleCandidates.length === 0,
              onClick: () => setPicked((current) => selectAllFiltered(visibleCandidates, current)),
            }, t('group.selectAllFiltered')),
            h('button', {
              type: 'button',
              className: 'msm-button msm-button-mini',
              disabled: busy || visibleCandidates.length === 0,
              onClick: () => setPicked((current) => clearAllFiltered(visibleCandidates, current)),
            }, t('group.deselectAllFiltered')),
            h('button', {
              type: 'button',
              className: 'msm-button msm-button-mini msm-button-primary',
              disabled: busy || picked.size === 0,
              onClick: () => { onAddSkills([...picked]); setPicked(new Set()); },
            }, t('group.addSelected', { count: picked.size })),
          ),
        ),
        h('input', {
          className: 'msm-input',
          value: query,
          placeholder: t('group.searchPlaceholder'),
          onChange: (event) => setQuery(event.target.value),
        }),
        visibleCandidates.length === 0
          ? h('div', { className: 'msm-empty' }, query.trim().length > 0 ? t('group.noMatch') : t('group.allAdded'))
          : h('div', { className: 'msm-list msm-picker-list' },
              visibleCandidates.map((skill) => h('label', { key: skill.name, className: 'msm-list-row' },
                h('input', {
                  type: 'checkbox',
                  className: 'msm-row-check',
                  checked: picked.has(skill.name),
                  disabled: busy,
                  onChange: () => setPicked((current) => toggleInSet(current, skill.name)),
                }),
                h('span', { className: 'msm-list-name', title: skill.description ?? '' }, skill.name),
              )),
            ),
      );
    }

    // ── groups section ──────────────────────────────────────────────────────
    function GroupSection({ t, state, skills, busy, onCreate, onDelete, onRename, onSetEnabled, onAddSkills, onRemoveSkills }) {
      const [newName, setNewName] = react.useState('');
      const submitCreate = () => {
        const name = newName.trim();
        if (name.length === 0) return;
        setNewName('');
        onCreate(name);
      };
      return h('div', { className: 'msm-section' },
        h('div', { className: 'msm-create-row' },
          h('input', {
            className: 'msm-input',
            value: newName,
            placeholder: t('group.createPlaceholder'),
            disabled: busy,
            onChange: (event) => setNewName(event.target.value),
            onKeyDown: (event) => { if (event.key === 'Enter') submitCreate(); },
          }),
          h('button', {
            type: 'button',
            className: 'msm-button msm-button-primary',
            disabled: busy || newName.trim().length === 0,
            onClick: submitCreate,
          }, t('group.create')),
        ),
        state.groups.length === 0
          ? h('div', { className: 'msm-empty' }, t('group.empty'))
          : h('div', { className: 'msm-group-list' },
              state.groups.map((group) => h(GroupCard, {
                key: group.id,
                t,
                group,
                skills,
                busy,
                onDelete: () => onDelete(group.id),
                onRename: (name) => onRename(group.id, name),
                onSetEnabled: (enabled) => onSetEnabled(group.id, enabled),
                // Two-arg wrapper: GroupCard calls onAddSkills(group.id, names);
                // a one-arg wrapper here would bind `names` to the group id and
                // `for (const name of names)` would iterate the id's characters.
                onAddSkills: (id, names) => onAddSkills(id, names),
                onRemoveSkills: (id, names) => onRemoveSkills(id, names),
              })),
            ),
      );
    }

    // ── MCP helpers (pure) ─────────────────────────────────────────────────
    /** Derive the visual status of one server (badge tone + locale key). */
    function statusOf(server) {
      if (!server.enabled) return { tone: 'off', key: 'mcp.statusDisabled' };
      switch (server.fiberPhase) {
        case 'active':
          // The fiber being active only means the mcp-client entry is running;
          // the MCP handshake succeeded only when tools are actually
          // registered, so zero tools never renders green.
          return server.toolCount > 0
            ? { tone: 'ok', key: 'mcp.statusConnected', count: server.toolCount }
            : { tone: 'warn', key: 'mcp.statusNoTools' };
        case 'failed': return { tone: 'bad', key: 'mcp.statusFailed' };
        case 'loading': return { tone: 'warn', key: 'mcp.statusLoading' };
        case 'pending': return { tone: 'warn', key: 'mcp.statusPending' };
        case 'unloading': return { tone: 'warn', key: 'mcp.statusUnloading' };
        default: return { tone: 'off', key: 'mcp.statusNotLoaded' };
      }
    }
    /** One-line connection target shown under the server name. */
    function targetOf(server) {
      if (server.transport === 'stdio') {
        return [server.command, ...(server.args ?? [])].filter(Boolean).join(' ');
      }
      return server.url ?? '';
    }
    function splitLines(text) {
      return text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '');
    }
    /** Trim surrounding quotes from a pasted JSON-style key/value pair. */
    function stripQuotes(value) {
      const trimmed = value.trim();
      if (trimmed.length >= 2) {
        const first = trimmed[0];
        const last = trimmed[trimmed.length - 1];
        if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
          return trimmed.slice(1, -1).trim();
        }
      }
      return trimmed;
    }
    /** Parse a key=value / `key: value` line block into a record. */
    function parsePairs(text) {
      const lines = splitLines(text);
      if (lines.length === 0) return undefined;
      const out = {};
      for (const line of lines) {
        const eq = line.indexOf('=');
        const colon = line.indexOf(':');
        const sep = eq === -1 ? colon : colon === -1 ? eq : Math.min(eq, colon);
        if (sep <= 0) continue;
        out[stripQuotes(line.slice(0, sep))] = stripQuotes(line.slice(sep + 1));
      }
      return out;
    }
    const EMPTY_MCP_FORM = {
      id: '', serverName: '', transport: 'streamable-http', url: '', command: '',
      argsText: '', envText: '', cwd: '', headersText: '', toolCallTimeoutMs: '',
      failOnStartupError: false,
    };
    function formOfServer(server) {
      if (server === undefined) return EMPTY_MCP_FORM;
      return {
        id: server.id,
        serverName: server.serverName,
        transport: server.transport,
        url: server.url ?? '',
        command: server.command ?? '',
        argsText: (server.args ?? []).join('\n'),
        envText: Object.entries(server.env ?? {}).map(([k, v]) => `${k}=${v}`).join('\n'),
        cwd: server.cwd ?? '',
        headersText: Object.entries(server.headers ?? {}).map(([k, v]) => `${k}: ${v}`).join('\n'),
        toolCallTimeoutMs: server.toolCallTimeoutMs !== undefined ? String(server.toolCallTimeoutMs) : '',
        failOnStartupError: server.failOnStartupError === true,
      };
    }
    /** Flatten the form into the RPC payload config fields (id stays separate). */
    function configOfForm(form) {
      const config = { serverName: form.serverName.trim(), transport: form.transport };
      if (form.transport === 'streamable-http') {
        if (form.url.trim() !== '') config.url = form.url.trim();
      } else {
        if (form.command.trim() !== '') config.command = form.command.trim();
        const args = splitLines(form.argsText);
        if (args.length > 0) config.args = args;
        const env = parsePairs(form.envText);
        if (env !== undefined) config.env = env;
        if (form.cwd.trim() !== '') config.cwd = form.cwd.trim();
      }
      const headers = parsePairs(form.headersText);
      if (headers !== undefined) config.headers = headers;
      if (form.toolCallTimeoutMs.trim() !== '' && Number.isFinite(Number(form.toolCallTimeoutMs))) {
        config.toolCallTimeoutMs = Number(form.toolCallTimeoutMs);
      }
      if (form.failOnStartupError) config.failOnStartupError = true;
      return config;
    }

    // ── MCP add/edit form ─────────────────────────────────────────────────
    // One form serves both modes: add (empty initial, id editable) and edit
    // (opens in place of the card, id locked). Field-level errors come from
    // local validation and from the host's structured RPC error (`fields`).
    function McpServerForm({ t, initial, servers, busy, onCancel, onSave }) {
      const editing = initial !== undefined;
      const [form, setForm] = react.useState(() => formOfServer(initial));
      const [fieldErrors, setFieldErrors] = react.useState({});
      const [submitError, setSubmitError] = react.useState(null);
      const [saving, setSaving] = react.useState(false);
      const set = (key, value) => setForm((prev) => ({ ...prev, [key]: value }));
      const err = (key) => fieldErrors[key];
      const inputClass = (key) => `msm-input${err(key) !== undefined ? ' msm-input-invalid' : ''}`;
      const validateLocal = () => {
        const errors = {};
        const id = form.id.trim();
        if (id === '') errors.id = t('mcp.errIdRequired');
        else if (!ENTRY_ID_PATTERN.test(id)) errors.id = t('mcp.errIdPattern');
        else if (!editing && servers.some((s) => s.id === id)) errors.id = t('mcp.errIdTaken');
        const serverName = form.serverName.trim();
        if (serverName === '') errors.serverName = t('mcp.errNameRequired');
        else if (!SERVER_NAME_PATTERN.test(serverName)) errors.serverName = t('mcp.errNamePattern');
        else if (!editing && servers.some((s) => s.serverName === serverName)) errors.serverName = t('mcp.errNameTaken');
        if (form.transport === 'streamable-http' && form.url.trim() === '') errors.url = t('mcp.errUrlRequired');
        if (form.transport === 'stdio' && form.command.trim() === '') errors.command = t('mcp.errCommandRequired');
        return errors;
      };
      const submit = async () => {
        const local = validateLocal();
        setFieldErrors(local);
        if (Object.keys(local).length > 0) return;
        setSaving(true);
        setSubmitError(null);
        try {
          const error = await onSave(editing, { id: form.id.trim(), ...configOfForm(form) });
          if (error !== undefined) {
            setFieldErrors(error.fields ?? {});
            setSubmitError(error.message);
          } else {
            onCancel(); // saved — close the form
          }
        } finally {
          setSaving(false);
        }
      };
      const field = (key, labelKey, input) =>
        h('div', { className: 'msm-field' },
          h('label', { className: 'msm-label' }, t(labelKey)),
          input,
          err(key) !== undefined ? h('p', { className: 'msm-hint' }, err(key)) : null,
        );
      const disabled = saving || busy;
      return h('div', { className: 'msm-form' },
        h('div', { className: 'msm-detail-label' },
          editing ? t('mcp.editTitle', { name: initial.serverName }) : t('mcp.addTitle')),
        field('id', 'mcp.formId', h('input', {
          className: inputClass('id'),
          value: form.id,
          placeholder: 'mcp-github',
          spellCheck: false,
          disabled: editing || disabled,
          onChange: (event) => set('id', event.target.value),
        })),
        field('serverName', 'mcp.formName', h('input', {
          className: inputClass('serverName'),
          value: form.serverName,
          placeholder: 'github',
          spellCheck: false,
          disabled,
          onChange: (event) => set('serverName', event.target.value),
        })),
        h('div', { className: 'msm-field' },
          h('label', { className: 'msm-label' }, t('mcp.formTransport')),
          h('select', {
            className: 'msm-select',
            value: form.transport,
            disabled,
            onChange: (event) => set('transport', event.target.value),
          },
            h('option', { value: 'streamable-http' }, 'streamable-http'),
            h('option', { value: 'stdio' }, 'stdio'),
          ),
        ),
        form.transport === 'streamable-http'
          ? field('url', 'mcp.formUrl', h('input', {
              className: inputClass('url'),
              value: form.url,
              placeholder: 'http://127.0.0.1:3000/mcp',
              spellCheck: false,
              disabled,
              onChange: (event) => set('url', event.target.value),
            }))
          : h(react.Fragment, null,
              field('command', 'mcp.formCommand', h('input', {
                className: inputClass('command'),
                value: form.command,
                placeholder: 'npx',
                spellCheck: false,
                disabled,
                onChange: (event) => set('command', event.target.value),
              })),
              field('args', 'mcp.formArgs', h('textarea', {
                className: 'msm-textarea',
                rows: 3,
                value: form.argsText,
                placeholder: '-y\n@modelcontextprotocol/server-github',
                spellCheck: false,
                disabled,
                onChange: (event) => set('argsText', event.target.value),
              })),
              field('env', 'mcp.formEnv', h('textarea', {
                className: 'msm-textarea',
                rows: 3,
                value: form.envText,
                placeholder: 'GITHUB_TOKEN=ghp_xxx',
                spellCheck: false,
                disabled,
                onChange: (event) => set('envText', event.target.value),
              })),
              field('cwd', 'mcp.formCwd', h('input', {
                className: 'msm-input',
                value: form.cwd,
                spellCheck: false,
                disabled,
                onChange: (event) => set('cwd', event.target.value),
              })),
            ),
        field('headers', 'mcp.formHeaders', h('textarea', {
          className: 'msm-textarea',
          rows: 2,
          value: form.headersText,
          placeholder: 'Authorization: Bearer xxx',
          spellCheck: false,
          disabled,
          onChange: (event) => set('headersText', event.target.value),
        })),
        field('toolCallTimeoutMs', 'mcp.formTimeout', h('input', {
          className: inputClass('toolCallTimeoutMs'),
          value: form.toolCallTimeoutMs,
          inputMode: 'numeric',
          placeholder: '60000',
          disabled,
          onChange: (event) => set('toolCallTimeoutMs', event.target.value.replace(/[^0-9]/g, '')),
        })),
        h('label', { className: 'msm-check' },
          h('input', {
            type: 'checkbox',
            checked: form.failOnStartupError,
            disabled,
            onChange: (event) => set('failOnStartupError', event.target.checked),
          }),
          t('mcp.formFailStartup'),
        ),
        submitError !== null && h('div', { className: 'msm-op-error' }, submitError),
        h('div', { className: 'msm-form-actions' },
          h('button', {
            type: 'button',
            className: 'msm-button',
            disabled: saving,
            onClick: onCancel,
          }, t('mcp.cancel')),
          h('button', {
            type: 'button',
            className: 'msm-button msm-button-primary',
            disabled,
            onClick: () => { void submit(); },
          }, editing ? t('mcp.save') : t('mcp.add')),
        ),
      );
    }

    // ── MCP section ─────────────────────────────────────────────────────────
    // Server cards: status badge (fiber phase + live tool count), source badge
    // (user patch vs profile/bundle), enable switch (real start/stop via the
    // patch file + HMR), connection probe, edit, remove. The add form sits at
    // the bottom; the edit form opens in place of the card being edited.
    function McpSection({ t, servers, busy, onToggle, onRemove, onSave, onProbe }) {
      const [adding, setAdding] = react.useState(false);
      const [editingId, setEditingId] = react.useState(null);
      const [probes, setProbes] = react.useState({});
      const [probingId, setProbingId] = react.useState(null);
      const formOpen = adding || editingId !== null;
      const actionsDisabled = busy || formOpen;
      const runProbe = async (id) => {
        setProbingId(id);
        try {
          const result = await onProbe(id);
          if (result !== undefined) setProbes((prev) => ({ ...prev, [id]: result }));
        } finally {
          setProbingId(null);
        }
      };
      const card = (server) => {
        if (server.id === editingId) {
          return h(McpServerForm, {
            key: server.id,
            t,
            initial: server,
            servers,
            busy,
            onCancel: () => setEditingId(null),
            onSave,
          });
        }
        const status = statusOf(server);
        const probe = probes[server.id];
        return h('div', { key: server.id, className: 'msm-server' },
          h('div', { className: 'msm-server-row' },
            h('span', {
              className: 'msm-status',
              'data-tone': status.tone,
            }, t(status.key, status.count !== undefined ? { count: status.count } : undefined)),
            h('span', { className: 'msm-server-name', title: server.serverName }, server.serverName || server.id),
            h('span', { className: 'msm-server-badge', 'data-source': server.userManaged ? 'user' : 'profile' },
              server.userManaged ? t('mcp.sourceUser') : t('mcp.sourceProfile')),
          ),
          h('div', { className: 'msm-server-target', title: targetOf(server) },
            targetOf(server) || server.transport),
          h('div', { className: 'msm-server-meta' },
            `${server.id} · ${server.transport} · ${t('mcp.tools', { count: server.toolCount })}`),
          probe !== undefined && h('div', {
            className: `msm-probe ${probe.ok ? 'msm-probe-ok' : 'msm-probe-bad'}`,
          }, probe.ok
            ? t('mcp.probeOk', { ms: probe.latencyMs, count: probe.toolCount ?? '?' })
            : t('mcp.probeFail', { error: probe.error ?? 'failed', ms: probe.latencyMs })),
          h('div', { className: 'msm-server-actions' },
            h('button', {
              type: 'button',
              role: 'switch',
              'aria-checked': server.enabled,
              className: 'msm-switch',
              'data-on': server.enabled || undefined,
              onClick: () => onToggle(server.id, !server.enabled),
              'aria-label': t(server.enabled ? 'mcp.disable' : 'mcp.enable', { name: server.serverName }),
              title: t(server.enabled ? 'mcp.disable' : 'mcp.enable', { name: server.serverName }),
              disabled: actionsDisabled,
            }),
            h('button', {
              type: 'button',
              className: 'msm-button msm-button-mini',
              disabled: actionsDisabled || probingId !== null,
              onClick: () => { void runProbe(server.id); },
            }, probingId === server.id ? '…' : t('mcp.test')),
            h('button', {
              type: 'button',
              className: 'msm-icon-button',
              onClick: () => { setAdding(false); setEditingId(server.id); },
              'aria-label': t('mcp.edit', { name: server.serverName }),
              title: t('mcp.edit', { name: server.serverName }),
              disabled: actionsDisabled,
            }, h(PencilIcon, { size: 12 })),
            h('button', {
              type: 'button',
              className: 'msm-icon-button msm-danger',
              onClick: () => onRemove(server),
              'aria-label': t('mcp.remove', { name: server.serverName }),
              title: t('mcp.remove', { name: server.serverName }),
              disabled: actionsDisabled,
            }, h(XIcon, { size: 12 })),
          ),
        );
      };
      return h('div', { className: 'msm-section' },
        servers.length === 0
          ? h('div', { className: 'msm-empty' }, t('mcp.empty'), h('br'), t('mcp.emptyHint'))
          : h('div', { className: 'msm-server-list' }, servers.map(card)),
        adding
          ? h(McpServerForm, {
              t,
              initial: undefined,
              servers,
              busy,
              onCancel: () => setAdding(false),
              onSave,
            })
          : h('button', {
              type: 'button',
              className: 'msm-button',
              disabled: actionsDisabled,
              onClick: () => { setEditingId(null); setAdding(true); },
            }, t('mcp.addTitle')),
      );
    }

    // ── manager data hook (shared by the two settings sections) ──────────
    // Loads groups/skills/MCP servers over the RPC route and exposes the
    // optimistic-mutate machinery; each settings section mounts its own
    // instance (root scope, one settings page visible at a time).
    function useManagerData() {
      const [status, setStatus] = react.useState('loading');
      const [loadError, setLoadError] = react.useState(null);
      const [state, setState] = react.useState({ groups: [] });
      const [skills, setSkills] = react.useState([]);
      const [servers, setServers] = react.useState([]);
      const [opError, setOpError] = react.useState(null);
      const [busy, setBusy] = react.useState(false);

      const load = react.useCallback(async (silent) => {
        if (!silent) { setStatus('loading'); setLoadError(null); }
        try {
          const [stateValue, skillsValue, serversValue] = await Promise.all([
            rpc('manager.state.get', {}),
            rpc('manager.skills.list', {}),
            rpc('manager.mcp.list', {}),
          ]);
          setState(stateValue);
          setSkills(skillsValue.skills ?? []);
          setServers(serversValue.servers ?? []);
          if (!silent) setStatus('ready');
        } catch (error) {
          const message = errorMessage(error);
          if (silent) setOpError(message);
          else { setLoadError(message); setStatus('error'); }
        }
      }, []);

      /** Optimistic mutate: apply locally, call RPC, re-align; roll back on failure. */
      const mutate = async (method, args, optimistic) => {
        setOpError(null);
        setBusy(true);
        const prev = { state, skills, servers };
        if (optimistic !== undefined) optimistic();
        try {
          await rpc(method, args);
          await load(true);
        } catch (error) {
          setState(prev.state);
          setSkills(prev.skills);
          setServers(prev.servers);
          setOpError(errorMessage(error));
        } finally {
          setBusy(false);
        }
      };

      // initial load
      react.useEffect(() => { load(false); }, [load]);

      return {
        status, loadError, state, skills, servers, opError, busy,
        load, mutate, setOpError, setBusy, setState, setSkills, setServers,
      };
    }

    /** Loading / load-error gate shared by both settings sections. */
    function settingsGate(t, data, content) {
      if (data.status === 'loading') return h('div', { className: 'msm-loading' }, t('state.loading'));
      if (data.status === 'error') {
        return h('div', { className: 'msm-error' },
          h('div', { className: 'msm-error-text' }, data.loadError),
          h('button', { type: 'button', className: 'msm-button', onClick: () => data.load(false) }, t('state.retry')));
      }
      return h(react.Fragment, null,
        data.opError !== null && h('div', { className: 'msm-op-error' }, data.opError),
        content);
    }

    // ── settings section: skill groups (settings.section entry) ──────────
    function SkillGroupsSection(props) {
      const t = makeT(props.t);
      const data = useManagerData();
      const { state, skills, busy, mutate } = data;

      const createGroup = (name) => mutate('manager.groups.create', { name });
      const deleteGroup = (id) => {
        if (!window.confirm(t('group.deleteConfirm'))) return;
        mutate('manager.groups.delete', { id }, () => {
          data.setState((prev) => ({ ...prev, groups: prev.groups.filter((group) => group.id !== id) }));
        });
      };
      const renameGroup = (id, name) => mutate('manager.groups.rename', { id, name }, () => {
        data.setState((prev) => ({ ...prev, groups: prev.groups.map((group) => (group.id === id ? { ...group, name } : group)) }));
      });
      const setGroupEnabled = (id, enabled) => mutate('manager.groups.setEnabled', { id, enabled }, () => {
        data.setState((prev) => ({ ...prev, groups: prev.groups.map((group) => (group.id === id ? { ...group, enabled } : group)) }));
      });
      // Batch add/remove: ONE RPC with all names (N sequential RPCs were slow).
      const addSkills = (id, names) => mutate('manager.groups.addSkill', { id, skills: names });
      const removeSkills = (id, names) => mutate('manager.groups.removeSkill', { id, skills: names });

      return h('div', { className: 'msm-settings' },
        settingsGate(t, data, h(GroupSection, {
          t,
          state,
          skills,
          busy,
          onCreate: createGroup,
          onDelete: deleteGroup,
          onRename: renameGroup,
          onSetEnabled: setGroupEnabled,
          onAddSkills: addSkills,
          onRemoveSkills: removeSkills,
        })));
    }

    // ── settings section: MCP servers (settings.section entry) ───────────
    function McpSectionPage(props) {
      const t = makeT(props.t);
      const data = useManagerData();
      const { servers, busy } = data;

      // MCP mutations edit cordis.patch.yml and the harness hot-reloads the
      // tree asynchronously, so after the immediate re-read the section polls
      // twice more (800/2400ms) while the reload settles — the status badge
      // and tool count only flip once the new fiber is up.
      const refreshMcpSettled = () => {
        window.setTimeout(() => { void data.load(true); }, 800);
        window.setTimeout(() => { void data.load(true); }, 2400);
      };
      const mutateMcp = async (method, args, optimistic) => {
        await data.mutate(method, args, optimistic);
        refreshMcpSettled();
      };
      const toggleMcp = (id, enabled) => mutateMcp('manager.mcp.toggle', { id, enabled }, () => {
        data.setServers((prev) => prev.map((server) => (server.id === id ? { ...server, enabled } : server)));
      });
      const removeMcp = (server) => {
        if (!window.confirm(t('mcp.removeConfirm', { name: server.serverName, id: server.id }))) return;
        mutateMcp('manager.mcp.remove', { id: server.id }, () => {
          data.setServers((prev) => prev.filter((entry) => entry.id !== server.id));
        });
      };
      /** Add/update go through the form: field errors must reach the caller. */
      const saveMcp = async (editing, payload) => {
        data.setOpError(null);
        data.setBusy(true);
        try {
          await rpc(editing ? 'manager.mcp.update' : 'manager.mcp.add', payload);
          await data.load(true);
          refreshMcpSettled();
          return undefined;
        } catch (error) {
          return error;
        } finally {
          data.setBusy(false);
        }
      };
      /** Probe is RPC-only; the result object (or undefined on RPC error). */
      const probeMcp = async (id) => {
        data.setOpError(null);
        try {
          return await rpc('manager.mcp.probe', { id });
        } catch (error) {
          data.setOpError(errorMessage(error));
          return undefined;
        }
      };

      return h('div', { className: 'msm-settings' },
        settingsGate(t, data, h(McpSection, {
          t, servers, busy, onToggle: toggleMcp, onRemove: removeMcp, onSave: saveMcp, onProbe: probeMcp,
        })));
    }

    // ── header session-groups button (conversation.session.header.actions) ─
    // The slot is session scope: props carry `sessionId` and the entry
    // remounts on session switch, so no per-session state cleanup is needed.
    // The popover edits ONLY this session's group selection (override ?? the
    // global toggles) and can create a new group in place; global management
    // (groups + MCP) lives in the two `settings.section` pages.
    function SessionGroupsButton(props) {
      const t = makeT(props.t);
      const sessionId = props.sessionId;
      const [open, setOpen] = react.useState(false);
      const [groups, setGroups] = react.useState([]);
      const [override, setOverride] = react.useState(null); // null = follow global; Set of ids otherwise
      const [effective, setEffective] = react.useState([]);
      const [busy, setBusy] = react.useState(false);
      const [error, setError] = react.useState(null);
      const [newName, setNewName] = react.useState('');
      const rootRef = react.useRef(null);

      // Load the session selection each time the popover opens.
      react.useEffect(() => {
        if (!open) return;
        let cancelled = false;
        (async () => {
          try {
            const [stateValue, sessionValue] = await Promise.all([
              rpc('manager.state.get', {}),
              rpc('manager.session.get', { sessionId }),
            ]);
            if (cancelled) return;
            setGroups(stateValue.groups ?? []);
            setOverride(sessionValue.override === null ? null : new Set(sessionValue.override.enabledGroupIds));
            setEffective(sessionValue.effectiveGroupIds ?? []);
            setError(null);
          } catch (loadError) {
            if (!cancelled) setError(errorMessage(loadError));
          }
        })();
        return () => { cancelled = true; };
      }, [open, sessionId]);

      // Click outside closes the popover.
      react.useEffect(() => {
        if (!open) return;
        const onPointerDown = (event) => {
          if (rootRef.current !== null && !rootRef.current.contains(event.target)) setOpen(false);
        };
        document.addEventListener('mousedown', onPointerDown);
        return () => document.removeEventListener('mousedown', onPointerDown);
      }, [open]);

      /** Persist a new selection; local state re-aligns with the host reply. */
      const save = async (next) => { // next: null (follow global) | Set of group ids
        setBusy(true);
        setError(null);
        try {
          const value = await rpc('manager.session.set', {
            sessionId,
            enabledGroupIds: next === null ? null : [...next],
          });
          setOverride(value.override === null ? null : new Set(value.override.enabledGroupIds));
          setEffective(value.effectiveGroupIds ?? []);
        } catch (saveError) {
          setError(errorMessage(saveError));
        } finally {
          setBusy(false);
        }
      };

      const toggleGroup = (id) => {
        // Leaving follow-global starts from the current effective selection,
        // so flipping one group never disturbs the others.
        const next = override === null ? new Set(effective) : new Set(override);
        if (next.has(id)) next.delete(id); else next.add(id);
        void save(next);
      };

      const isChecked = (id) => (override === null ? effective.includes(id) : override.has(id));

      /** Create a group in place; the popover stays open and the list refreshes. */
      const createGroup = async () => {
        const name = newName.trim();
        if (name.length === 0) return;
        setBusy(true);
        setError(null);
        try {
          await rpc('manager.groups.create', { name });
          const stateValue = await rpc('manager.state.get', {});
          setGroups(stateValue.groups ?? []);
          setNewName('');
        } catch (createError) {
          setError(errorMessage(createError));
        } finally {
          setBusy(false);
        }
      };

      // Without a sessionId the slot cannot scope the popover and there is
      // nothing per-session to edit — render nothing (global management lives
      // in the settings sections).
      if (typeof sessionId !== 'string' || sessionId.length === 0) return null;

      return h('span', { className: 'msm-session-root', ref: rootRef },
        h('button', {
          type: 'button',
          className: 'msm-toggle',
          'aria-label': t('session.aria'),
          title: t('session.title'),
          'aria-expanded': open,
          onClick: () => setOpen((current) => !current),
        }, h(GearIcon, { size: 14 }), h('span', { className: 'msm-toggle-label' }, t('toggle.label'))),
        open && h('div', { className: 'msm-session-popover', role: 'dialog', 'aria-label': t('session.aria') },
          h('div', { className: 'msm-detail-label' }, t('session.popoverTitle')),
          groups.length === 0
            ? h('div', { className: 'msm-empty' }, t('session.empty'))
            : h(react.Fragment, null,
                h('label', { className: 'msm-check' },
                  h('input', {
                    type: 'checkbox',
                    checked: override === null,
                    disabled: busy,
                    onChange: (event) => { void save(event.target.checked ? null : new Set(effective)); },
                  }),
                  t('session.followGlobal'),
                ),
                h('div', { className: 'msm-list msm-session-groups' },
                  groups.map((group) => h('label', { key: group.id, className: 'msm-list-row' },
                    h('input', {
                      type: 'checkbox',
                      className: 'msm-row-check',
                      checked: isChecked(group.id),
                      disabled: busy || override === null,
                      onChange: () => toggleGroup(group.id),
                    }),
                    h('span', { className: 'msm-list-name', title: group.name }, group.name),
                  )),
                ),
              ),
          error !== null && h('div', { className: 'msm-op-error' }, error),
          h('div', { className: 'msm-create-row' },
            h('input', {
              className: 'msm-input',
              value: newName,
              placeholder: t('group.createPlaceholder'),
              disabled: busy,
              onChange: (event) => setNewName(event.target.value),
              onKeyDown: (event) => { if (event.key === 'Enter') void createGroup(); },
            }),
            h('button', {
              type: 'button',
              className: 'msm-button msm-button-mini msm-button-primary',
              disabled: busy || newName.trim().length === 0,
              onClick: () => { void createGroup(); },
            }, t('group.create')),
          ),
        ),
      );
    }

    // ── stylesheet (fiber-scoped) ───────────────────────────────────────────
    const PANEL_CSS = [
      '.msm-settings{box-sizing:border-box;display:flex;flex-direction:column;gap:10px;width:100%;max-width:720px;margin:0 auto;padding:8px 0 24px;color:var(--dsw-alias-label-primary,#1f2329);font-size:13px;line-height:18px}',
      '@keyframes msm-pop-in{from{opacity:0}to{opacity:1}}',
      '.msm-icon-button{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;padding:0;color:var(--dsw-alias-label-tertiary,#8a919c);background:transparent;border:0;border-radius:7px;cursor:pointer;transition:background-color .12s,color .12s}',
      '.msm-icon-button:hover{background:var(--dsw-alias-bg-fill-neutral,#eef0f4);color:var(--dsw-alias-label-primary,#1f2329)}',
      '.msm-icon-button:disabled{opacity:.45;cursor:default}',
      '.msm-icon-button.msm-danger:hover{color:var(--dsw-alias-state-danger,#e5484d);background:color-mix(in srgb,var(--dsw-alias-state-danger,#e5484d) 10%,transparent)}',
      '.msm-section{display:flex;flex-direction:column;gap:10px}',
      '.msm-loading,.msm-error{display:flex;flex-direction:column;align-items:center;gap:8px;padding:24px 0;color:var(--dsw-alias-label-tertiary,#8a919c);font-size:12px}',
      '.msm-error-text{color:var(--dsw-alias-state-danger,#e5484d);text-align:center}',
      '.msm-op-error{color:var(--dsw-alias-state-danger,#e5484d);font-size:12px;line-height:16px}',
      '.msm-empty{color:var(--dsw-alias-label-tertiary,#8a919c);font-size:12px;line-height:16px;padding:6px 0}',
      '.msm-create-row{display:flex;gap:6px}',
      '.msm-input{box-sizing:border-box;flex:1;min-width:0;height:30px;padding:0 8px;color:var(--dsw-alias-label-primary,#1f2329);background:var(--dsw-alias-bg-module-platform,#f7f8fa);border:1px solid var(--dsw-alias-line-normal,#e7e9ee);border-radius:8px;font-size:12px;font-family:inherit}',
      '.msm-input:focus{outline:2px solid var(--dsw-alias-state-business-primary,#4d6bfe);outline-offset:1px;border-color:transparent}',
      '.msm-button{flex:none;height:30px;padding:0 12px;color:var(--dsw-alias-label-secondary,#5c6470);background:var(--dsw-alias-bg-module-platform,#f7f8fa);border:1px solid var(--dsw-alias-line-normal,#e7e9ee);border-radius:8px;font-size:12px;font-weight:600;cursor:pointer}',
      '.msm-button:hover{background:var(--dsw-alias-bg-fill-neutral,#eef0f4)}',
      '.msm-button:disabled{opacity:.5;cursor:default}',
      '.msm-button-primary{color:var(--dsw-alias-label-on-fill,#fff);background:var(--dsw-alias-state-business-primary,#4d6bfe);border-color:transparent}',
      // Same specificity as .msm-button:hover (0,2,0) but declared later, so
      // this wins: without an explicit background here, .msm-button:hover's
      // light fill would replace the primary blue on hover and the white
      // label would land on it, making the button visually disappear.
      '.msm-button-primary:hover{background:var(--dsw-alias-state-business-primary,#4d6bfe);filter:brightness(1.06)}',
      '.msm-button-mini{height:22px;padding:0 8px;font-size:11px;border-radius:6px}',
      '.msm-button-danger{color:var(--dsw-alias-state-danger,#e5484d)}',
      '.msm-button-danger:not(:disabled):hover{background:color-mix(in srgb,var(--dsw-alias-state-danger,#e5484d) 10%,transparent)}',
      '.msm-group-list{display:flex;flex-direction:column;gap:6px}',
      '.msm-group{border:1px solid var(--dsw-alias-line-normal,#e7e9ee);border-radius:10px;padding:7px 8px}',
      '.msm-group[data-expanded]{border-color:var(--dsw-alias-state-business-primary,#4d6bfe);background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#4d6bfe) 5%,transparent)}',
      '.msm-group-row{display:flex;align-items:center;gap:8px;min-width:0}',
      '.msm-group-caret{display:inline-flex;align-items:center;justify-content:center;flex:none;width:20px;height:20px;padding:0;color:var(--dsw-alias-label-tertiary,#8a919c);background:transparent;border:0;border-radius:5px;cursor:pointer}',
      '.msm-group-caret:hover{color:var(--dsw-alias-label-primary,#1f2329);background:var(--dsw-alias-bg-fill-neutral,#eef0f4)}',
      '.msm-group-check{flex:none;accent-color:var(--dsw-alias-state-business-primary,#4d6bfe);cursor:pointer}',
      '.msm-group-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12.5px;font-weight:600;color:var(--dsw-alias-label-primary,#1f2329);cursor:pointer}',
      '.msm-group-name:hover{color:var(--dsw-alias-state-business-primary,#4d6bfe)}',
      '.msm-group-edit{flex:1;height:26px}',
      '.msm-group-count{flex:none;color:var(--dsw-alias-label-tertiary,#8a919c);font-size:10.5px}',
      '.msm-group-actions{display:inline-flex;gap:2px;flex:none}',
      '.msm-detail{display:flex;flex-direction:column;gap:8px;border-top:1px solid var(--dsw-alias-line-normal,#e7e9ee);padding-top:10px}',
      '.msm-detail-head{display:flex;align-items:center;justify-content:space-between;gap:8px;min-width:0}',
      '.msm-detail-label{font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary,#5c6470)}',
      '.msm-bulk-actions{display:inline-flex;gap:4px;flex:none}',
      '.msm-list{display:flex;flex-direction:column;gap:2px;max-height:200px;overflow-y:auto}',
      '.msm-list-row{display:flex;align-items:center;gap:6px;padding:3px 6px;border-radius:6px;cursor:pointer}',
      '.msm-list-row:hover{background:var(--dsw-alias-bg-fill-neutral,#eef0f4)}',
      '.msm-row-check{flex:none;accent-color:var(--dsw-alias-state-business-primary,#4d6bfe);cursor:pointer}',
      '.msm-list-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:var(--dsw-alias-label-primary,#1f2329)}',
      '.msm-server-list{display:flex;flex-direction:column;gap:6px}',
      '.msm-server{display:flex;flex-direction:column;gap:5px;min-width:0;padding:7px 8px;border:1px solid var(--dsw-alias-line-normal,#e7e9ee);border-radius:10px}',
      '.msm-server-row{display:flex;align-items:center;gap:8px;min-width:0}',
      '.msm-server-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12.5px;font-weight:600;color:var(--dsw-alias-label-primary,#1f2329)}',
      '.msm-server-badge{flex:none;padding:0 6px;border-radius:4px;font-size:10px;font-weight:600;line-height:16px;background:var(--dsw-alias-bg-fill-neutral,#eef0f4);color:var(--dsw-alias-label-tertiary,#8a919c)}',
      '.msm-server-badge[data-source=user]{background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#4d6bfe) 12%,transparent);color:var(--dsw-alias-state-business-primary,#4d6bfe)}',
      '.msm-server-target{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary,#5c6470);font-size:11px}',
      '.msm-server-meta{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary,#8a919c);font-size:10.5px}',
      '.msm-server-actions{display:flex;align-items:center;gap:4px}',
      '.msm-server-actions .msm-button-mini{flex:none}',
      '.msm-status{flex:none;display:inline-flex;align-items:center;font-size:10.5px;font-weight:600;color:var(--dsw-alias-label-tertiary,#8a919c)}',
      '.msm-status[data-tone=ok]{color:var(--dsw-alias-state-success-primary,#12a150)}',
      '.msm-status[data-tone=warn]{color:var(--dsw-alias-state-warning,#e8a33d)}',
      '.msm-status[data-tone=bad]{color:var(--dsw-alias-state-danger,#e5484d)}',
      '.msm-probe{font-size:11px;line-height:15px;word-break:break-all}',
      '.msm-probe-ok{color:var(--dsw-alias-state-success-primary,#12a150)}',
      '.msm-probe-bad{color:var(--dsw-alias-state-danger,#e5484d)}',
      '.msm-field{display:flex;flex-direction:column;gap:3px;min-width:0}',
      '.msm-label{font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary,#5c6470)}',
      '.msm-hint{margin:0;font-size:10.5px;line-height:14px;color:var(--dsw-alias-state-danger,#e5484d)}',
      '.msm-input-invalid{border-color:var(--dsw-alias-state-danger,#e5484d)}',
      '.msm-textarea{box-sizing:border-box;width:100%;padding:6px 8px;color:var(--dsw-alias-label-primary,#1f2329);background:var(--dsw-alias-bg-module-platform,#f7f8fa);border:1px solid var(--dsw-alias-line-normal,#e7e9ee);border-radius:8px;font-size:12px;font-family:inherit;resize:vertical}',
      '.msm-textarea:focus{outline:2px solid var(--dsw-alias-state-business-primary,#4d6bfe);outline-offset:1px;border-color:transparent}',
      '.msm-select{box-sizing:border-box;width:100%;height:30px;padding:0 8px;color:var(--dsw-alias-label-primary,#1f2329);background:var(--dsw-alias-bg-module-platform,#f7f8fa);border:1px solid var(--dsw-alias-line-normal,#e7e9ee);border-radius:8px;font-size:12px;font-family:inherit}',
      '.msm-check{display:inline-flex;align-items:center;gap:4px;font-size:12px;color:var(--dsw-alias-label-secondary,#5c6470);cursor:pointer}',
      '.msm-check input{accent-color:var(--dsw-alias-state-business-primary,#4d6bfe)}',
      '.msm-form-actions{display:flex;justify-content:flex-end;gap:6px}',
      '.msm-switch{position:relative;flex:none;width:32px;height:18px;padding:0;border:1px solid var(--dsw-alias-line-normal,#e7e9ee);border-radius:999px;background:var(--dsw-alias-bg-fill-neutral,#eef0f4);cursor:pointer;transition:background-color .12s,border-color .12s}',
      '.msm-switch::after{content:"";position:absolute;top:2px;left:2px;width:12px;height:12px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.2);transition:transform .12s}',
      '.msm-switch[data-on]{background:var(--dsw-alias-state-success-primary,#12a150);border-color:transparent}',
      '.msm-switch[data-on]::after{transform:translateX(14px)}',
      '.msm-switch:disabled{opacity:.5;cursor:default}',
      '.msm-form{display:flex;flex-direction:column;gap:6px;border-top:1px solid var(--dsw-alias-line-normal,#e7e9ee);padding-top:10px}',
      '.msm-form-row{display:flex;gap:10px}',
      '.msm-radio{display:inline-flex;align-items:center;gap:4px;font-size:12px;color:var(--dsw-alias-label-secondary,#5c6470);cursor:pointer}',
      '.msm-radio input{accent-color:var(--dsw-alias-state-business-primary,#4d6bfe)}',
      '.msm-toggle{display:inline-flex;align-items:center;justify-content:center;gap:5px;min-height:28px;padding:3px 8px;color:var(--dsw-alias-label-tertiary,#8a919c);background:transparent;border:0;border-radius:6px;cursor:pointer}',
      '.msm-toggle:hover,.msm-toggle:focus-visible{color:var(--dsw-alias-label-secondary,#5c6470)}',
      '.msm-toggle-label{font-size:12px;font-weight:600;white-space:nowrap}',
      '.msm-session-root{position:relative;display:inline-flex}',
      '.msm-session-popover{position:absolute;top:calc(100% + 6px);right:0;z-index:60;display:flex;flex-direction:column;gap:8px;width:220px;padding:10px 12px;border:1px solid color-mix(in srgb,var(--dsw-alias-line-strong,#cfd3d6) 58%,transparent);border-radius:12px;background:color-mix(in srgb,var(--dsw-alias-bg-module,#fff) 97%,transparent);backdrop-filter:blur(20px) saturate(1.08);box-shadow:0 12px 32px color-mix(in srgb,var(--dsw-alias-label-primary,#1f2329) 12%,transparent);color:var(--dsw-alias-label-primary,#1f2329);font-size:12px;line-height:16px;animation:msm-pop-in .16s ease-out}',
      '.msm-session-groups{max-height:220px}',
      '@media (prefers-reduced-motion:reduce){.msm-session-popover{animation:none;transition:none}}',
    ].join('');

    // ── plugin face ─────────────────────────────────────────────────────────
    const inject = ['slots', 'locale'];

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register('mcp-skill-manager', { zh, en }), 'mcp-skill-manager: dictionaries');
      ctx.effect(() => {
        if (typeof document === 'undefined') return;
        const tag = document.createElement('style');
        tag.dataset.plugin = 'dsh-skills-mcp-group-manager';
        tag.dataset.pluginCss = 'dsh-skills-mcp-group-manager/panel.css';
        tag.textContent = PANEL_CSS;
        document.head.appendChild(tag);
        return () => { tag.remove(); };
      }, 'mcp-skill-manager: styles');
      // Nav labels read through the bound translator at render time, so they
      // follow the active locale without re-registration.
      const labelT = ctx.locale.bind('mcp-skill-manager');
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'skill-groups',
        order: 17,
        label: () => labelT('navGroups'),
        locale: 'mcp-skill-manager',
      }, SkillGroupsSection));
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        // Unique section id: "mcp" is taken by other MCP-manager plugins
        // (e.g. @js2hou/dsh-mcp-manager) and slot entries conflict on
        // id + priority.
        id: 'skills-mcp-manager',
        order: 18,
        label: () => labelT('navMcp'),
        locale: 'mcp-skill-manager',
      }, McpSectionPage));
      ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
        name: 'conversation.session.header.actions',
        id: 'mcp-skill-manager-toggle',
        order: 10,
        label: 'MCP & Skills manager',
        locale: 'mcp-skill-manager',
      }, SessionGroupsButton));
    }

    exports.apply = apply;
    exports.inject = inject;
    // Pure selection logic, exported for unit tests (the browser runtime
    // ignores this extra export).
    exports.__logic = {
      filterCandidates,
      filterMembers,
      toggleInSet,
      selectAllFiltered,
      clearAllFiltered,
      toggleAllMembers,
      addSelectedToGroup,
      removeSelectedFromGroup,
    };
    return module.exports;
  },
});
