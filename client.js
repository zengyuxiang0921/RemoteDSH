/**
 * Remote bridge — browser half: the row's configuration page.
 *
 * The Plugins view renders a row's page from the `plugins.row.config` slot, so
 * this module contributes the form that reads and writes this bundle's
 * `config` through the `settings` Remote namespace (Config-derived, redacted).
 */
window.__ModuleLoader__.load({
  id: 'dsh-remote-bridge',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const NS = 'remote-bridge.config'
    const ROW_KEY = 'dsh-remote-bridge#remote-bridge'
    const { useCallback, useEffect, useMemo, useState } = React

    const DICTIONARIES = {
      zh: {
        title: '远程桥接配置',
        summary: '监听地址、鉴权与要连接的远程机器',
        loading: '正在读取配置…',
        loadFailed: '读取配置失败',
        save: '保存',
        saving: '保存中…',
        saved: '已保存，重启 DSH 或在插件页关闭再启用本插件后生效',
        saveFailed: '保存失败',
        reload: '重新读取',
        mode: '运行模式',
        modeBoth: '同时作为服务端和客户端',
        modeServer: '仅服务端',
        modeClient: '仅客户端',
        modeOff: '关闭',
        serverSection: '服务端',
        serverEnabled: '启用服务端',
        host: '监听地址',
        hostHint: '0.0.0.0 允许局域网访问；只本机用 127.0.0.1',
        port: '端口',
        name: '机器名',
        nameHint: '客户端里显示为「在那台机器：<名字>」，留空用 hostname',
        token: 'Token',
        password: '密码',
        authHint: '留空表示不校验（不建议）',
        sessions: '可见会话',
        sessionsHint: '* 表示全部，也可填逗号分隔的会话 id',
        cwdPrefixes: '限定工作目录',
        cwdPrefixesHint: '每行一个前缀，例如 D:\\work；留空表示不限制',
        clientSection: '客户端',
        clientEnabled: '启用客户端',
        remotes: '远程机器',
        remotesEmpty: '还没有添加远程机器',
        addRemote: '添加远程机器',
        remove: '删除',
        remoteId: '标识',
        remoteLabel: '显示名',
        remoteUrl: '地址',
        remoteUrlHint: 'http://192.168.1.20:4590、ws://… 或 host:port',
        noConfig: '这个 profile 没有暴露本插件的配置',
        readOnly: '当前部署不允许写入配置',
      },
      en: {
        title: 'Remote bridge configuration',
        summary: 'Listener, authentication, and the machines to connect',
        loading: 'Reading configuration…',
        loadFailed: 'Could not read the configuration',
        save: 'Save',
        saving: 'Saving…',
        saved: 'Saved. Restart DSH, or toggle this plugin off and on, to apply.',
        saveFailed: 'Save failed',
        reload: 'Reload',
        mode: 'Mode',
        modeBoth: 'Server and client',
        modeServer: 'Server only',
        modeClient: 'Client only',
        modeOff: 'Off',
        serverSection: 'Server',
        serverEnabled: 'Enable the server',
        host: 'Listen address',
        hostHint: '0.0.0.0 exposes the LAN; 127.0.0.1 keeps it local',
        port: 'Port',
        name: 'Machine name',
        nameHint: 'Shown as “on <name>” in the client; empty uses hostname',
        token: 'Token',
        password: 'Password',
        authHint: 'Empty disables the check (not recommended)',
        sessions: 'Visible sessions',
        sessionsHint: '* for all, or comma-separated session ids',
        cwdPrefixes: 'Working directories',
        cwdPrefixesHint: 'One prefix per line, e.g. D:\\work; empty allows everything',
        clientSection: 'Client',
        clientEnabled: 'Enable the client',
        remotes: 'Remote machines',
        remotesEmpty: 'No remote machine yet',
        addRemote: 'Add remote machine',
        remove: 'Remove',
        remoteId: 'Id',
        remoteLabel: 'Label',
        remoteUrl: 'Address',
        remoteUrlHint: 'http://192.168.1.20:4590, ws://…, or host:port',
        noConfig: 'This profile does not expose this plugin’s configuration',
        readOnly: 'This deployment does not allow configuration writes',
      },
    }

    const CSS = `
.rdcfg-root{display:flex;flex-direction:column;gap:14px;padding:4px 0 8px;color:var(--dsw-alias-label-primary);font-size:13px;max-width:640px}
.rdcfg-head{display:flex;align-items:center;gap:10px}
.rdcfg-title{font-weight:600;font-size:14px}
.rdcfg-summary{color:var(--dsw-alias-label-secondary);font-size:12px}
.rdcfg-section{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:12px 14px;display:flex;flex-direction:column;gap:10px;background:var(--dsw-alias-bg-layer-1)}
.rdcfg-section-title{font-weight:600;font-size:12.5px;color:var(--dsw-alias-label-secondary);text-transform:uppercase;letter-spacing:.04em}
.rdcfg-field{display:flex;flex-direction:column;gap:4px}
.rdcfg-label{font-size:12.5px}
.rdcfg-hint{color:var(--dsw-alias-label-secondary);font-size:11.5px}
.rdcfg-input,.rdcfg-select,.rdcfg-textarea{width:100%;box-sizing:border-box;background:var(--dsw-alias-bg-base);color:inherit;border:1px solid var(--dsw-alias-border-l1);border-radius:7px;padding:6px 9px;font:inherit;font-size:12.5px}
.rdcfg-input:focus,.rdcfg-select:focus,.rdcfg-textarea:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}
.rdcfg-textarea{min-height:64px;resize:vertical;font-family:inherit}
.rdcfg-row{display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap}
.rdcfg-row>.rdcfg-field{flex:1;min-width:120px}
.rdcfg-check{display:flex;align-items:center;gap:7px;font-size:12.5px}
.rdcfg-remote{border:1px dashed var(--dsw-alias-border-l1);border-radius:9px;padding:10px;display:flex;flex-direction:column;gap:8px}
.rdcfg-remote-head{display:flex;align-items:center;justify-content:space-between;color:var(--dsw-alias-label-secondary);font-size:11.5px}
.rdcfg-actions{display:flex;align-items:center;gap:10px}
.rdcfg-btn{border:1px solid var(--dsw-alias-border-l1);background:transparent;color:inherit;border-radius:7px;padding:5px 12px;font:inherit;font-size:12.5px;cursor:pointer}
.rdcfg-btn:hover{border-color:var(--dsw-alias-border-l2)}
.rdcfg-btn.primary{background:var(--dsw-alias-brand-primary);border-color:transparent;color:#fff}
.rdcfg-btn:disabled{opacity:.5;cursor:default}
.rdcfg-btn.danger{color:var(--dsw-alias-state-error-primary)}
.rdcfg-status{font-size:12px}
.rdcfg-status.ok{color:var(--dsw-alias-state-success-primary)}
.rdcfg-status.err{color:var(--dsw-alias-state-error-primary)}
.rdcfg-empty{color:var(--dsw-alias-label-secondary);font-size:12px}
`

    /** Read a nested value with a fallback. */
    function pick(value, path, fallback) {
      let current = value
      for (const key of path) {
        if (current === null || typeof current !== 'object') return fallback
        current = current[key]
      }
      return current === undefined ? fallback : current
    }

    /** Write a nested value into a draft copy. */
    function put(draft, path, next) {
      let current = draft
      for (let index = 0; index < path.length - 1; index += 1) {
        const key = path[index]
        if (current[key] === null || typeof current[key] !== 'object') current[key] = {}
        current = current[key]
      }
      current[path[path.length - 1]] = next
    }

    /** Deep equality for the plain JSON the form edits. */
    function same(left, right) {
      return JSON.stringify(left) === JSON.stringify(right)
    }

    /** A labelled text input. */
    function TextField(props) {
      return h(
        'label',
        { className: 'rdcfg-field' },
        h('span', { className: 'rdcfg-label' }, props.label),
        h('input', {
          className: 'rdcfg-input',
          type: props.type ?? 'text',
          value: props.value ?? '',
          placeholder: props.placeholder ?? '',
          disabled: props.disabled === true,
          onChange: (event) => props.onChange(event.target.value),
        }),
        props.hint ? h('span', { className: 'rdcfg-hint' }, props.hint) : null,
      )
    }

    /** A checkbox row. */
    function CheckField(props) {
      return h(
        'label',
        { className: 'rdcfg-check' },
        h('input', {
          type: 'checkbox',
          checked: props.checked === true,
          disabled: props.disabled === true,
          onChange: (event) => props.onChange(event.target.checked),
        }),
        h('span', null, props.label),
      )
    }

    /** A select over fixed options. */
    function SelectField(props) {
      return h(
        'label',
        { className: 'rdcfg-field' },
        h('span', { className: 'rdcfg-label' }, props.label),
        h(
          'select',
          {
            className: 'rdcfg-select',
            value: props.value,
            disabled: props.disabled === true,
            onChange: (event) => props.onChange(event.target.value),
          },
          props.options.map((option) => h('option', { key: option.value, value: option.value }, option.label)),
        ),
      )
    }

    /**
     * The row's configuration form.
     * @param {{ t: (key: string) => string, view?: string, resolve: () => object | undefined }} props - slot props plus a lazy Remote resolver.
     */
    function ConfigPage(props) {
      const t = props.t
      const [phase, setPhase] = useState('loading')
      const [error, setError] = useState(null)
      const [namespace, setNamespace] = useState(null)
      const [original, setOriginal] = useState(null)
      const [draft, setDraft] = useState(null)
      const [revision, setRevision] = useState(0)
      const [writable, setWritable] = useState(true)
      const [status, setStatus] = useState(null)

      const load = useCallback(async () => {
        setPhase('loading')
        setError(null)
        try {
          const remote = props.resolve()
          if (remote === undefined || typeof remote.describe !== 'function') {
            setError(t('noConfig'))
            setPhase('error')
            return
          }
          const described = await remote.describe()
          setWritable(described?.writable !== false)
          const namespaces = Array.isArray(described?.namespaces) ? described.namespaces : []
          const match =
            namespaces.find((entry) => String(entry.ns).includes('remote-bridge')) ??
            namespaces.find((entry) => entry.value && typeof entry.value === 'object' && 'server' in entry.value && 'client' in entry.value)
          if (match === undefined) {
            setPhase('missing')
            return
          }
          const value = match.value ?? {}
          setNamespace(match.ns)
          setOriginal(value)
          setDraft(JSON.parse(JSON.stringify(value)))
          setRevision(Number(match.revision) || 0)
          setPhase('ready')
        } catch (failure) {
          setError(String(failure?.message ?? failure))
          setPhase('error')
        }
      }, [props])

      useEffect(() => {
        load()
      }, [load])

      const update = useCallback((path, next) => {
        setDraft((previous) => {
          if (previous === null) return previous
          const copy = JSON.parse(JSON.stringify(previous))
          put(copy, path, next)
          return copy
        })
        setStatus(null)
      }, [])

      const save = useCallback(async () => {
        if (draft === null || namespace === null) return
        setPhase('saving')
        setStatus(null)
        try {
          const ops = []
          for (const path of [['mode'], ['server', 'enabled'], ['server', 'host'], ['server', 'port'], ['server', 'name']]) {
            const next = pick(draft, path, undefined)
            if (next !== undefined && !same(next, pick(original, path, undefined))) ops.push({ op: 'set', path, value: next })
          }
          for (const key of ['token', 'password']) {
            const next = pick(draft, ['server', 'auth', key], '')
            if (typeof next === 'string' && next !== '') ops.push({ op: 'set', path: ['server', 'auth', key], value: next })
          }
          if (!same(pick(draft, ['server', 'allow', 'sessions'], '*'), pick(original, ['server', 'allow', 'sessions'], '*'))) {
            ops.push({ op: 'set', path: ['server', 'allow', 'sessions'], value: pick(draft, ['server', 'allow', 'sessions'], '*') })
          }
          const prefixes = pick(draft, ['server', 'allow', 'cwdPrefixes'], [])
          if (!same(prefixes, pick(original, ['server', 'allow', 'cwdPrefixes'], []))) {
            ops.push({ op: 'set', path: ['server', 'allow', 'cwdPrefixes'], value: prefixes })
          }
          if (!same(pick(draft, ['client', 'enabled'], true), pick(original, ['client', 'enabled'], true))) {
            ops.push({ op: 'set', path: ['client', 'enabled'], value: pick(draft, ['client', 'enabled'], true) })
          }
          const remotes = pick(draft, ['client', 'remotes'], [])
          if (!same(remotes, pick(original, ['client', 'remotes'], []))) {
            ops.push({ op: 'set', path: ['client', 'remotes'], value: remotes })
          }
          if (ops.length === 0) {
            setPhase('ready')
            setStatus({ kind: 'ok', text: t('saved') })
            return
          }
          const remote = props.resolve()
          if (remote === undefined || typeof remote.mutate !== 'function') {
            throw new Error('settings Remote namespace is unavailable')
          }
          const view = await remote.mutate(namespace, ops, revision)
          const value = view?.value ?? draft
          setOriginal(value)
          setDraft(JSON.parse(JSON.stringify(value)))
          setRevision(Number(view?.revision) || revision + 1)
          setPhase('ready')
          setStatus({ kind: 'ok', text: t('saved') })
        } catch (failure) {
          setPhase('ready')
          setStatus({ kind: 'err', text: `${t('saveFailed')}：${String(failure?.message ?? failure)}` })
        }
      }, [draft, namespace, original, revision, props, t])

      const modeOptions = useMemo(
        () => [
          { value: 'both', label: t('modeBoth') },
          { value: 'server', label: t('modeServer') },
          { value: 'client', label: t('modeClient') },
          { value: 'off', label: t('modeOff') },
        ],
        [t],
      )

      if (props.view === 'summary') return h('span', null, t('summary'))

      const style = h('style', { key: 'style' }, CSS)
      const body = []

      if (phase === 'loading') body.push(h('div', { className: 'rdcfg-empty', key: 'loading' }, t('loading')))
      else if (phase === 'missing') body.push(h('div', { className: 'rdcfg-empty', key: 'missing' }, t('noConfig')))
      else if (phase === 'error') body.push(h('div', { className: 'rdcfg-status err', key: 'error' }, `${t('loadFailed')}：${error}`))
      else if (draft !== null) {
        const disabled = !writable || phase === 'saving'
        const remotes = pick(draft, ['client', 'remotes'], [])
        body.push(
          h(
            'div',
            { className: 'rdcfg-section', key: 'general' },
            h('div', { className: 'rdcfg-section-title' }, t('mode')),
            h(SelectField, {
              label: t('mode'),
              value: pick(draft, ['mode'], 'both'),
              options: modeOptions,
              disabled,
              onChange: (next) => update(['mode'], next),
            }),
          ),
          h(
            'div',
            { className: 'rdcfg-section', key: 'server' },
            h('div', { className: 'rdcfg-section-title' }, t('serverSection')),
            h(CheckField, {
              label: t('serverEnabled'),
              checked: pick(draft, ['server', 'enabled'], true),
              disabled,
              onChange: (next) => update(['server', 'enabled'], next),
            }),
            h(
              'div',
              { className: 'rdcfg-row' },
              h(TextField, {
                label: t('host'),
                value: pick(draft, ['server', 'host'], '0.0.0.0'),
                hint: t('hostHint'),
                disabled,
                onChange: (next) => update(['server', 'host'], next),
              }),
              h(TextField, {
                label: t('port'),
                type: 'number',
                value: String(pick(draft, ['server', 'port'], 4590)),
                disabled,
                onChange: (next) => update(['server', 'port'], Number(next) || 0),
              }),
            ),
            h(TextField, {
              label: t('name'),
              value: pick(draft, ['server', 'name'], ''),
              hint: t('nameHint'),
              disabled,
              onChange: (next) => update(['server', 'name'], next),
            }),
            h(
              'div',
              { className: 'rdcfg-row' },
              h(TextField, {
                label: t('token'),
                type: 'password',
                value: pick(draft, ['server', 'auth', 'token'], ''),
                hint: t('authHint'),
                disabled,
                onChange: (next) => update(['server', 'auth', 'token'], next),
              }),
              h(TextField, {
                label: t('password'),
                type: 'password',
                value: pick(draft, ['server', 'auth', 'password'], ''),
                disabled,
                onChange: (next) => update(['server', 'auth', 'password'], next),
              }),
            ),
            h(TextField, {
              label: t('sessions'),
              value: pick(draft, ['server', 'allow', 'sessions'], '*'),
              hint: t('sessionsHint'),
              disabled,
              onChange: (next) => update(['server', 'allow', 'sessions'], next),
            }),
            h(
              'label',
              { className: 'rdcfg-field' },
              h('span', { className: 'rdcfg-label' }, t('cwdPrefixes')),
              h('textarea', {
                className: 'rdcfg-textarea',
                disabled,
                value: (pick(draft, ['server', 'allow', 'cwdPrefixes'], []) ?? []).join('\n'),
                onChange: (event) =>
                  update(
                    ['server', 'allow', 'cwdPrefixes'],
                    event.target.value
                      .split('\n')
                      .map((line) => line.trim())
                      .filter((line) => line !== ''),
                  ),
              }),
              h('span', { className: 'rdcfg-hint' }, t('cwdPrefixesHint')),
            ),
          ),
          h(
            'div',
            { className: 'rdcfg-section', key: 'client' },
            h('div', { className: 'rdcfg-section-title' }, t('clientSection')),
            h(CheckField, {
              label: t('clientEnabled'),
              checked: pick(draft, ['client', 'enabled'], true),
              disabled,
              onChange: (next) => update(['client', 'enabled'], next),
            }),
            h('div', { className: 'rdcfg-label' }, t('remotes')),
            remotes.length === 0 ? h('div', { className: 'rdcfg-empty' }, t('remotesEmpty')) : null,
            ...remotes.map((remote, index) =>
              h(
                'div',
                { className: 'rdcfg-remote', key: `remote-${index}` },
                h(
                  'div',
                  { className: 'rdcfg-remote-head' },
                  h('span', null, `${index + 1}`),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'rdcfg-btn danger',
                      disabled,
                      onClick: () => update(['client', 'remotes'], remotes.filter((_, at) => at !== index)),
                    },
                    t('remove'),
                  ),
                ),
                h(
                  'div',
                  { className: 'rdcfg-row' },
                  h(TextField, {
                    label: t('remoteId'),
                    value: remote?.id ?? '',
                    disabled,
                    onChange: (next) => update(['client', 'remotes'], remotes.map((item, at) => (at === index ? { ...item, id: next } : item))),
                  }),
                  h(TextField, {
                    label: t('remoteLabel'),
                    value: remote?.label ?? '',
                    disabled,
                    onChange: (next) => update(['client', 'remotes'], remotes.map((item, at) => (at === index ? { ...item, label: next } : item))),
                  }),
                ),
                h(TextField, {
                  label: t('remoteUrl'),
                  value: remote?.url ?? '',
                  hint: t('remoteUrlHint'),
                  disabled,
                  onChange: (next) => update(['client', 'remotes'], remotes.map((item, at) => (at === index ? { ...item, url: next } : item))),
                }),
                h(TextField, {
                  label: t('token'),
                  type: 'password',
                  value: remote?.token ?? '',
                  disabled,
                  onChange: (next) => update(['client', 'remotes'], remotes.map((item, at) => (at === index ? { ...item, token: next } : item))),
                }),
              ),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'rdcfg-btn',
                disabled,
                onClick: () => update(['client', 'remotes'], [...remotes, { id: '', label: '', url: '', token: '', password: '' }]),
              },
              t('addRemote'),
            ),
          ),
          h(
            'div',
            { className: 'rdcfg-actions', key: 'actions' },
            h(
              'button',
              { type: 'button', className: 'rdcfg-btn primary', disabled: disabled, onClick: save },
              phase === 'saving' ? t('saving') : t('save'),
            ),
            h('button', { type: 'button', className: 'rdcfg-btn', disabled: phase === 'saving', onClick: load }, t('reload')),
            status === null
              ? null
              : h('span', { className: `rdcfg-status ${status.kind === 'ok' ? 'ok' : 'err'}` }, status.text),
            writable ? null : h('span', { className: 'rdcfg-hint' }, t('readOnly')),
          ),
        )
      }

      return h('div', { className: 'rdcfg-root' }, style, ...body)
    }

    /**
     * Resolve a settings client lazily.
     *
     * The typed Remote namespace is preferred; when the application assembly
     * does not expose it to this plugin, the shared RPC channel answers the same
     * two endpoints. Both are read at call time so render never touches them.
     * @returns {object | undefined} `{ describe, mutate }`.
     */
    function resolveSettings(ctx) {
      try {
        const typed = ctx.remote?.settings
        if (typed !== undefined && typeof typed.describe === 'function') return typed
      } catch {
        // fall through to the RPC channel
      }
      try {
        const rpc = ctx.get('connection')?.rpc
        if (rpc === undefined || typeof rpc.call !== 'function') return undefined
        const call = (endpoint, args) =>
          Promise.resolve(rpc.call('/api', endpoint, { args })).then((result) => {
            if (result !== null && typeof result === 'object' && result.ok === true) return result.value
            const failure = result?.error
            throw new Error(failure?.message ?? failure?.code ?? 'remote call failed')
          })
        return {
          describe: () => call('settings/describe', {}),
          mutate: (ns, ops, expectedRevision) => call('settings/mutate', { ns, ops, expectedRevision }),
        }
      } catch {
        return undefined
      }
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, DICTIONARIES), 'remote-bridge: config dictionaries')
        const t = ctx.locale.bind(NS)
        const resolve = () => resolveSettings(ctx)
        ctx.slots.inject('plugins.row.config', () =>
          ctx.slots.register(
            { name: 'plugins.row.config', key: ROW_KEY, locale: NS },
            (props) => h(ConfigPage, { t, view: props?.view, resolve }),
          ),
        )
      },
    }
  },
})
