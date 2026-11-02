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
        monitor: '连接管理',
        monitorSummary: '实时查看连入和连出的 DSH',
        refreshStatus: '刷新状态',
        inbound: '连入本机的 DSH',
        outbound: '本机连出的 DSH',
        noPeers: '当前没有 DSH 连接',
        noLinks: '没有配置远程连接',
        listening: '监听中',
        notListening: '未监听',
        online: '在线',
        handshaking: '握手中',
        connecting: '连接中',
        offline: '离线',
        denied: '鉴权失败',
        idle: '待连接',
        errorState: '错误',
        unknownState: '未知',
        address: '来源',
        identity: '身份',
        version: '版本',
        connectedAt: '连接时间',
        duration: '连接时长',
        lastActive: '最近活动',
        visibleSessions: '可见会话',
        historyReads: '历史读取',
        disconnect: '断开',
        disconnecting: '断开中…',
        disconnectHint: '断开后，客户端可能按自身策略自动重连',
        statusFailed: '状态读取失败',
        noStatus: '管理接口暂不可用，请重启 DSH 以加载新版本',
        localMachine: '本机',
        protocol: '协议',
        serverRelay: '允许客户端之间转发会话',
        serverRelayHint: '开启后，一台客户端共享的会话可以由其他客户端经本机读取；是否共享、共享给谁由共享方自己决定',
        shareSection: '会话共享（经服务器转发）',
        shareEnabled: '把本机会话共享给其他客户端',
        shareHint: '需要服务端开启「允许客户端之间转发会话」，且双方握手都协商到 relay 能力',
        shareSessions: '共享的会话',
        shareCwdPrefixes: '共享的工作目录',
        shareConsumers: '允许哪些客户端查看',
        shareConsumersHint: '每行一个客户端机器名；留空表示任何已通过鉴权的客户端都能看',
        clientRelay: '查看其他客户端共享的会话',
        clientRelayHint: '开启后，本机会把对方共享的会话镜像成工作区里的会话（只读）',
        features: '能力',
        publishedSessions: '共享会话',
        relayServed: '转发服务',
        relayPeers: '转发源',
        relayNone: '没有客户端共享会话',
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
        monitor: 'Connections',
        monitorSummary: 'Live inbound and outbound DSH connections',
        refreshStatus: 'Refresh status',
        inbound: 'Connected to this machine',
        outbound: 'Outbound remote machines',
        noPeers: 'No DSH is connected',
        noLinks: 'No remote connection configured',
        listening: 'Listening',
        notListening: 'Not listening',
        online: 'Online',
        handshaking: 'Handshaking',
        connecting: 'Connecting',
        offline: 'Offline',
        denied: 'Authentication failed',
        idle: 'Idle',
        errorState: 'Error',
        unknownState: 'Unknown',
        address: 'Address',
        identity: 'Identity',
        version: 'Version',
        connectedAt: 'Connected',
        duration: 'Duration',
        lastActive: 'Last activity',
        visibleSessions: 'Visible sessions',
        historyReads: 'History reads',
        disconnect: 'Disconnect',
        disconnecting: 'Disconnecting…',
        disconnectHint: 'The client may reconnect automatically',
        statusFailed: 'Could not read connection status',
        noStatus: 'The management API is unavailable; restart DSH to load the new version',
        localMachine: 'This machine',
        protocol: 'Protocol',
        serverRelay: 'Allow clients to relay sessions to each other',
        serverRelayHint: 'When on, a session one client shares can be read by other clients through this machine; what is shared and with whom stays under the sharing client’s control',
        shareSection: 'Session sharing (relayed through the server)',
        shareEnabled: 'Share this machine’s sessions with other clients',
        shareHint: 'The server must allow relaying, and both handshakes must negotiate the relay capabilities',
        shareSessions: 'Sessions to share',
        shareCwdPrefixes: 'Working directories to share',
        shareConsumers: 'Clients allowed to read them',
        shareConsumersHint: 'One client machine name per line; empty lets any authenticated client read them',
        clientRelay: 'Read sessions other clients share',
        clientRelayHint: 'Mirrors their shared sessions into this workspace, read-only',
        features: 'Capabilities',
        publishedSessions: 'Shared',
        relayServed: 'Relayed reads',
        relayPeers: 'Relay sources',
        relayNone: 'No client shares sessions',
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
.rdcfg-monitor-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
.rdcfg-monitor-summary{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px;color:var(--dsw-alias-label-secondary)}
.rdcfg-badge{display:inline-flex;align-items:center;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;padding:2px 8px;font-size:11px;white-space:nowrap}
.rdcfg-badge.online{color:var(--dsw-alias-state-success-primary)}
.rdcfg-badge.error{color:var(--dsw-alias-state-error-primary)}
.rdcfg-peer{border-top:1px solid var(--dsw-alias-border-l1);padding-top:10px;display:flex;flex-direction:column;gap:8px}
.rdcfg-peer-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
.rdcfg-peer-title{font-weight:600;min-width:0;overflow-wrap:anywhere}
.rdcfg-peer-meta{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px 14px;font-size:11.5px;color:var(--dsw-alias-label-secondary)}
.rdcfg-peer-meta span{overflow-wrap:anywhere}
.rdcfg-subsection{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary);margin-top:2px}
@media(max-width:480px){.rdcfg-peer-meta{grid-template-columns:1fr}}
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

    function formatTime(value) {
      return Number(value) > 0 ? new Date(Number(value)).toLocaleString() : '—'
    }

    function formatDuration(from, at) {
      if (!Number(from) || !Number(at)) return '—'
      const seconds = Math.max(0, Math.floor((at - from) / 1000))
      if (seconds < 60) return `${seconds}s`
      if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
      return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`
    }

    /** Live bridge connections; this is independent of form draft state. */
    function MonitorPanel({ t, resolveAdmin }) {
      const [snapshot, setSnapshot] = useState(null)
      const [error, setError] = useState(null)
      const [busy, setBusy] = useState(null)
      const loadStatus = useCallback(async () => {
        try {
          const admin = resolveAdmin?.()
          if (admin === undefined) throw new Error(t('noStatus'))
          setSnapshot(await admin.status())
          setError(null)
        } catch (failure) {
          setError(String(failure?.message ?? failure))
        }
      }, [resolveAdmin, t])
      useEffect(() => {
        loadStatus()
        const timer = setInterval(loadStatus, 5000)
        return () => clearInterval(timer)
      }, [loadStatus])
      const disconnect = async (id) => {
        setBusy(id)
        try {
          const admin = resolveAdmin?.()
          if (admin === undefined) throw new Error(t('noStatus'))
          const result = await admin.disconnect(id)
          if (result?.ok !== true) throw new Error(result?.error ?? 'disconnect failed')
          await loadStatus()
        } catch (failure) {
          setError(String(failure?.message ?? failure))
        } finally {
          setBusy(null)
        }
      }
      const stateLabel = (state) => t(state === 'error' ? 'errorState' : state)
      const peerRow = (peer) =>
        h(
          'div',
          { className: 'rdcfg-peer', key: peer.id },
          h(
            'div',
            { className: 'rdcfg-peer-head' },
            h('span', { className: 'rdcfg-peer-title' }, peer.name || peer.identity || peer.id),
            h('span', { className: `rdcfg-badge ${peer.state === 'online' ? 'online' : ''}` }, stateLabel(peer.state)),
          ),
          h(
            'div',
            { className: 'rdcfg-peer-meta' },
            h('span', null, `${t('address')}：${peer.address}${peer.port ? `:${peer.port}` : ''}`),
            h('span', null, `${t('identity')}：${peer.identity || '—'}`),
            h('span', null, `${t('version')}：${peer.version || '—'} · ${t('protocol')} ${peer.protocol || '—'}`),
            h('span', null, `${t('visibleSessions')}：${peer.visibleSessions}`),
            h('span', null, `${t('connectedAt')}：${formatTime(peer.connectedAt)}`),
            h('span', null, `${t('duration')}：${formatDuration(peer.connectedAt, snapshot.at)}`),
            h('span', null, `${t('lastActive')}：${formatTime(peer.lastActiveAt)}`),
            h('span', null, `${t('historyReads')}：${peer.historyReads}`),
            h('span', null, `${t('features')}：${(peer.features ?? []).join(', ') || '—'}`),
            h('span', null, `${t('publishedSessions')}：${peer.publishedSessions ?? 0}`),
            h('span', null, `${t('relayServed')}：${peer.relayServed ?? 0}`),
          ),
          h(
            'div',
            { className: 'rdcfg-actions' },
            h(
              'button',
              { type: 'button', className: 'rdcfg-btn danger', disabled: busy !== null, onClick: () => disconnect(peer.id) },
              busy === peer.id ? t('disconnecting') : t('disconnect'),
            ),
            h('span', { className: 'rdcfg-hint' }, t('disconnectHint')),
          ),
        )
      return h(
        'div',
        { className: 'rdcfg-section' },
        h(
          'div',
          { className: 'rdcfg-monitor-head' },
          h('div', { className: 'rdcfg-section-title' }, t('monitor')),
          h('button', { type: 'button', className: 'rdcfg-btn', onClick: loadStatus }, t('refreshStatus')),
        ),
        h('div', { className: 'rdcfg-hint' }, t('monitorSummary')),
        error ? h('div', { className: 'rdcfg-status err' }, `${t('statusFailed')}：${error}`) : null,
        snapshot === null
          ? h('div', { className: 'rdcfg-empty' }, t('loading'))
          : [
              h(
                'div',
                { className: 'rdcfg-monitor-summary', key: 'summary' },
                h('span', null, `${t('localMachine')}：${snapshot.machine?.hostname || '—'}`),
                h('span', null, `${snapshot.machine?.platform || ''} ${snapshot.machine?.arch || ''}`),
                h(
                  'span',
                  { className: `rdcfg-badge ${snapshot.server?.listening ? 'online' : 'error'}` },
                  snapshot.server?.listening ? t('listening') : t('notListening'),
                ),
                snapshot.server?.enabled ? h('span', null, `${snapshot.server.host}:${snapshot.server.port}`) : null,
                snapshot.server?.enabled
                  ? h(
                      'span',
                      { className: `rdcfg-badge ${snapshot.server.relay?.enabled ? 'online' : ''}` },
                      `${t('serverRelay')}：${snapshot.server.relay?.enabled ? '开' : '关'}`,
                    )
                  : null,
                snapshot.server?.relay?.enabled
                  ? h(
                      'span',
                      null,
                      `${t('relayPeers')}：${snapshot.server.relay.publishers} · ${t('publishedSessions')}：${snapshot.server.relay.publishedSessions}`,
                    )
                  : null,
              ),
              h('div', { className: 'rdcfg-subsection', key: 'in-title' }, `${t('inbound')}（${snapshot.server?.peers?.length ?? 0}）`),
              ...(snapshot.server?.peers?.length ? snapshot.server.peers.map(peerRow) : [h('div', { className: 'rdcfg-empty', key: 'no-peers' }, t('noPeers'))]),
              h('div', { className: 'rdcfg-subsection', key: 'out-title' }, `${t('outbound')}（${snapshot.client?.links?.length ?? 0}）`),
              ...(snapshot.client?.links?.length
                ? snapshot.client.links.map((link) =>
                    h(
                      'div',
                      { className: 'rdcfg-peer', key: link.id },
                      h(
                        'div',
                        { className: 'rdcfg-peer-head' },
                        h('span', { className: 'rdcfg-peer-title' }, link.serverName || link.label),
                        h('span', { className: `rdcfg-badge ${link.status === 'online' ? 'online' : link.status === 'denied' || link.status === 'error' ? 'error' : ''}` }, stateLabel(link.status)),
                      ),
                      h(
                        'div',
                        { className: 'rdcfg-peer-meta' },
                        h('span', null, `${t('address')}：${link.url}`),
                        h('span', null, `${t('visibleSessions')}：${link.sessions}`),
                        h('span', null, `${t('connectedAt')}：${formatTime(link.connectedAt)}`),
                        h('span', null, `${t('lastActive')}：${formatTime(link.lastActiveAt)}`),
                        h('span', null, `${t('features')}：${(link.features ?? []).join(', ') || '—'}`),
                        h('span', null, `${t('publishedSessions')}：${link.publishing ?? 0}`),
                        h(
                          'span',
                          null,
                          `${t('relayPeers')}：${(link.relays ?? []).length === 0 ? t('relayNone') : (link.relays ?? []).map((entry) => `${entry.name}(${entry.sessions})`).join('、')}`,
                        ),
                      ),
                      link.error ? h('div', { className: 'rdcfg-status err' }, link.error) : null,
                    ),
                  )
                : [h('div', { className: 'rdcfg-empty', key: 'no-links' }, t('noLinks'))]),
            ],
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
          const edits = [
            ['mode'],
            ['server', 'enabled'],
            ['server', 'host'],
            ['server', 'port'],
            ['server', 'name'],
            ['server', 'allow', 'sessions'],
            ['server', 'allow', 'cwdPrefixes'],
            ['server', 'relay', 'enabled'],
            ['client', 'enabled'],
            ['client', 'share', 'enabled'],
            ['client', 'share', 'sessions'],
            ['client', 'share', 'cwdPrefixes'],
            ['client', 'share', 'consumers'],
            ['client', 'relay', 'enabled'],
            ['client', 'remotes'],
          ]
          for (const path of edits) {
            const next = pick(draft, path, undefined)
            if (next === undefined) continue
            if (same(next, pick(original, path, undefined))) continue
            ops.push({ op: 'set', path, value: next })
          }
          for (const key of ['token', 'password']) {
            const next = pick(draft, ['server', 'auth', key], '')
            if (typeof next === 'string' && next !== '') ops.push({ op: 'set', path: ['server', 'auth', key], value: next })
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
            h(CheckField, {
              label: t('serverRelay'),
              checked: pick(draft, ['server', 'relay', 'enabled'], false),
              disabled,
              onChange: (next) => update(['server', 'relay', 'enabled'], next),
            }),
            h('span', { className: 'rdcfg-hint' }, t('serverRelayHint')),
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
            h('div', { className: 'rdcfg-section-title', style: { marginTop: '6px' } }, t('shareSection')),
            h(CheckField, {
              label: t('shareEnabled'),
              checked: pick(draft, ['client', 'share', 'enabled'], false),
              disabled,
              onChange: (next) => update(['client', 'share', 'enabled'], next),
            }),
            h('span', { className: 'rdcfg-hint' }, t('shareHint')),
            h(TextField, {
              label: t('shareSessions'),
              value: pick(draft, ['client', 'share', 'sessions'], '*'),
              hint: t('sessionsHint'),
              disabled,
              onChange: (next) => update(['client', 'share', 'sessions'], next),
            }),
            h(
              'label',
              { className: 'rdcfg-field' },
              h('span', { className: 'rdcfg-label' }, t('shareCwdPrefixes')),
              h('textarea', {
                className: 'rdcfg-textarea',
                disabled,
                value: (pick(draft, ['client', 'share', 'cwdPrefixes'], []) ?? []).join('\n'),
                onChange: (event) =>
                  update(
                    ['client', 'share', 'cwdPrefixes'],
                    event.target.value
                      .split('\n')
                      .map((line) => line.trim())
                      .filter((line) => line !== ''),
                  ),
              }),
              h('span', { className: 'rdcfg-hint' }, t('cwdPrefixesHint')),
            ),
            h(
              'label',
              { className: 'rdcfg-field' },
              h('span', { className: 'rdcfg-label' }, t('shareConsumers')),
              h('textarea', {
                className: 'rdcfg-textarea',
                disabled,
                value: (pick(draft, ['client', 'share', 'consumers'], []) ?? []).join('\n'),
                onChange: (event) =>
                  update(
                    ['client', 'share', 'consumers'],
                    event.target.value
                      .split('\n')
                      .map((line) => line.trim())
                      .filter((line) => line !== ''),
                  ),
              }),
              h('span', { className: 'rdcfg-hint' }, t('shareConsumersHint')),
            ),
            h(CheckField, {
              label: t('clientRelay'),
              checked: pick(draft, ['client', 'relay', 'enabled'], false),
              disabled,
              onChange: (next) => update(['client', 'relay', 'enabled'], next),
            }),
            h('span', { className: 'rdcfg-hint' }, t('clientRelayHint')),
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

      return h('div', { className: 'rdcfg-root' }, style, h(MonitorPanel, { t, resolveAdmin: props.resolveAdmin }), ...body)
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

    /**
     * Lazy access to the Host management routes.
     *
     * They are exact owner-only Fetch routes on the Connection carrier, so a
     * same-origin request carrying the page cookie is already authorised; the
     * reader stays lazy so rendering never touches the network layer.
     * @param {import('@deepseek-ai/cordis').Context} ctx - client context.
     * @returns {{ status: () => Promise<object>, disconnect: (id: string) => Promise<object> } | undefined} client.
     */
    function resolveAdmin(ctx) {
      let origin = ''
      try {
        origin = globalThis.location?.origin ?? ''
      } catch {
        origin = ''
      }
      if (origin === '' || typeof globalThis.fetch !== 'function') return undefined
      const call = async (path, init) => {
        const response = await globalThis.fetch(`${origin}${path}`, {
          credentials: 'same-origin',
          cache: 'no-store',
          ...init,
        })
        const text = await response.text()
        let body
        try {
          body = text === '' ? null : JSON.parse(text)
        } catch {
          throw new Error(`管理接口返回了非 JSON 响应（HTTP ${response.status}）`)
        }
        if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`)
        return body
      }
      return {
        status: () => call('/api/remoteBridge/status', { headers: { accept: 'application/json' } }),
        disconnect: (peerId) =>
          call('/api/remoteBridge/disconnect', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ peerId }),
          }),
      }
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, DICTIONARIES), 'remote-bridge: config dictionaries')
        const t = ctx.locale.bind(NS)
        const resolve = () => resolveSettings(ctx)
        const resolveManagement = () => resolveAdmin(ctx)
        ctx.slots.inject('plugins.row.config', () =>
          ctx.slots.register(
            { name: 'plugins.row.config', key: ROW_KEY, locale: NS },
            (props) => h(ConfigPage, { t, view: props?.view, resolve, resolveAdmin: resolveManagement }),
          ),
        )
      },
    }
  },
})
