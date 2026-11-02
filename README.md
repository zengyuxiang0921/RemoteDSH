# RemoteDSH

给 DSH 增加「远程会话桥接」：一台机器作为 **server** 只读暴露本机会话记录，另一台作为 **client** 连上去，把远端会话**直接镜像成本机工作区里的会话**——不写任何自定义界面，侧边栏、会话列表、对话视图全部复用本地原生实现。

## 配置入口

**图形界面（推荐）**：侧边栏「插件」→「已安装插件」→「查看 dsh-remote-bridge」→ **「配置 dsh-remote-bridge」**。

页面里可以直接改：运行模式、服务端开关/监听地址/端口/机器名/Token/密码/可见会话/限定工作目录，以及客户端开关和远程机器列表（增删改 id、显示名、地址、Token）。保存后写入 `$DSH_HOME/profiles/web/cordis.patch.yml`，提示「重启 DSH 或在插件页关闭再启用本插件后生效」。

**文件**：`$DSH_HOME/profiles/web/cordis.patch.yml` 里 `remote-bridge` 这一行的 `config`，字段与表单一一对应。

> 表单只投影插件声明为 `.volatile()` 的字段，本插件的 `Config` 已全部标注，所以 `mode`、`server`、`client` 三棵子树都可编辑。
> 若某个更高优先级层（`--patch` 命令行 overlay 或 home patch）覆盖了同一行，保存会被拒绝并提示 `overridden by a home patch or command-line overlay`——此时请改那个覆盖层。

| 要配的东西 | 字段 | 说明 |
| --- | --- | --- |
| 服务端监听地址 | `server.host` | `0.0.0.0` 允许局域网访问；只本机用 `127.0.0.1` |
| 服务端监听端口 | `server.port` | 默认 `4590` |
| 服务端对外显示的名字 | `server.name` | 客户端侧边栏显示「在那台机器：<名字>」，默认 hostname |
| 服务端鉴权 | `server.auth.token` / `server.auth.password` | 留空则不校验（会告警） |
| 客户端要连的远端 | `client.remotes[].url` | `http://<ip>:<port>`、`ws://<ip>:<port>` 或 `<host>:<port>` 均可 |
| 客户端凭据 | `client.remotes[].token` / `password` | 与服务端一致 |
| 客户端显示名 | `client.remotes[].label` | 工作区标题前缀，如「办公室」 |

修改后重载插件（或重启 DSH）生效。

## 连接管理面板（服务端）

在同一个配置页的顶部，有一块 **「连接管理」**，每 5 秒自动刷新，用来查看所有连接中的 DSH：

- **连入本机的 DSH**：每个已连接对端的机器名、来源 IP:端口、鉴权身份、客户端版本与协议版本、可见会话数、连接时间、连接时长、最近活动、历史读取次数，以及一个 **「断开」** 按钮。
- **本机连出的 DSH**：每条远程连接的显示名、地址、状态（在线 / 连接中 / 离线 / 鉴权失败）、远端机器名、可见会话数、连接时间与最近活动，失败时显示错误原因。
- **本机状态**：机器名、平台、当前监听状态与 `host:port`。

数据通过 DSH 自身的 **owner-only Fetch 路由**（`/api/remoteBridge/status`、`/api/remoteBridge/disconnect`）读取，沿用页面的 cookie 鉴权：非 owner 的调用方在到达处理函数前就被 403 拒绝，因此**不会**在 4590 这个局域网桥接端口上开任何管理接口。断开是软下线——对端若配置了自动重连会再次连上。

## 客户端之间的转发（relay）

一台客户端共享的会话，可以让其他客户端**经服务器转发**读取——两端互相不直连。

三个开关缺一不可：

| 位置 | 字段 | 作用 |
| --- | --- | --- |
| 服务端 | `server.relay.enabled` | 本站是否允许客户端之间互相转发 |
| 共享方 | `client.share.enabled` | 是否把本机会话共享出去 |
| 读取方 | `client.relay.enabled` | 是否读取别人共享的会话 |

**共享方决定权限**（在配置页「会话共享（经服务器转发）」里改）：

- `client.share.sessions`：`*` 或逗号分隔的会话 id
- `client.share.cwdPrefixes`：只共享这些目录下的会话（每行一个前缀）
- `client.share.consumers`：允许哪些客户端看（每行一个机器名）；留空表示任何已通过鉴权的客户端都能看

共享方的会话范围在**本地**先过滤，服务端只收到它同意共享的那部分；服务端再用同一份范围复核一次，所以任何一侧算错都不会漏数据。子智能体会话与已经镜像来的会话（`session-rb-*`）永不外发——后者会把第三台机器的记录绕过它自己的授权。

读取方看到的是只读镜像，落在独立工作区里，标题形如 `对端机器名 · 经 远程标签`。转发会话的历史请求与实时事件都经服务端中转，服务端只做路由，不落盘、不缓存事件内容。

## 协议与能力协商

握手时会报出双方各自支持的能力，服务端只启用**两边都支持**的子集：

```json
{ "t": "hello", "v": 2, "client": { "name": "laptop", "version": "0.5.0" },
  "features": ["sessions.read", "history.read", "relay.publish", "relay.subscribe"],
  "share": { "enabled": true, "sessions": "*", "cwdPrefixes": [], "consumers": ["desktop"] } }
```

`welcome` 回同样的结构：`features`（协商结果）、`featuresSupported`（服务端全集）、`relays`（可读取的共享源及其会话列表）。

| 能力 | 含义 |
| --- | --- |
| `sessions.read` / `history.read` | 基础读取（始终存在，声明出来便于将来收紧） |
| `relay.publish` | 允许本端作为共享方发布会话 |
| `relay.subscribe` | 允许本端读取别人共享的会话 |

版本校验：服务端接受 v1–v2。版本不符时回 `protocol-mismatch` 并附上自身支持的能力清单，客户端也能识别服务端版本过低。v1 客户端没有 `features` 字段，协商结果为空集，因此拿不到转发能力，但基础会话读取不受影响。

`GET /` 的健康检查也会回报 `protocol`、`minProtocol`、`features` 与 `relay` 状态。

## 完整配置示例

```yaml
- id: remote-bridge
  name: dsh-remote-bridge
  config:
    mode: both            # both | server | client | off
    server:
      enabled: true
      host: 0.0.0.0
      port: 4590
      name: office-pc
      auth:
        token: 'shared-secret'
        password: ''      # 可选，与 token 同时配置时需要两者都对
      allow:
        sessions: '*'     # 或 'id1,id2'
        cwdPrefixes: []   # 例如 ['D:\\work']，只暴露这些目录下的会话
      clients: []         # 可选：按客户端授权，填了就以它为准
      relay:
        enabled: false    # 允许客户端之间互相转发会话
    client:
      enabled: true
      remotes:
        - id: office
          label: 办公室
          url: http://192.168.1.20:4590
          token: 'shared-secret'
      share:              # 把本机会话共享给其他客户端
        enabled: false
        sessions: '*'
        cwdPrefixes: []
        consumers: []     # 允许的客户端机器名；留空 = 任何已鉴权客户端
      relay:
        enabled: false    # 读取其他客户端共享的会话
```

按客户端授权：

```yaml
      clients:
        - name: laptop
          token: laptop-token
          allow:
            sessions: '*'
            cwdPrefixes: ['D:\\work']
```

服务端未配置任何 token / password 时会告警：任何能访问该端口的人都能读取会话记录。

## 工作机制

1. 客户端连远端 `/ws`，发送 `hello`（协议版本 + token/password + 能力集 + 共享意图）。
2. 服务端校验后返回 `welcome`（机器名、协商后的能力、可用共享源、会话摘要列表），之后推送 `sessions` 与 `event`。
3. 客户端为每台机器建目录 `$DSH_HOME/remote-bridge/<id>` 并注册工作区，标题形如 `办公室（在那台机器：PC-01）`。
4. 每个远端会话物化为一个本地会话（id 形如 `session-rb-<hash>`，cwd 指向该目录），完整日志写入本地并挂到该工作区。
5. 镜像以 **live Session** 承载：事件进入内存会话，原生 `session/follow` 实时推送给已打开的页面，投影（标题、元数据）由原生注册表折叠，因此侧边栏标题与实时更新都不需要插件自己实现。
6. 插件同时持有该会话的持久化写句柄，所以本机**无法续聊**——`session/prompt`、`session/rename` 等返回 `session/writer-held`，镜像天然只读。
7. 远端新事件到达后追加到本地日志与内存会话；重连后按游标补齐。
8. 开了转发时：共享方在连上后推送 `publish`（自己过滤过的会话目录），服务端复核范围后广播 `relay/sessions`；读取方发 `history`（带 `peer`）时由服务端转发给共享方，共享方回 `history`（带 `events`），服务端再送回读取方；实时事件走 `publish/event` → `relay/event`。

## 已知限制

- **只读**：插件持有写句柄，本机不能续聊或改名（返回 `session/writer-held`）。
- **空会话不显示**：远端尚未开始的空会话被原生列表隐藏（与本地行为一致）。
- **fork/seed 会话降级**：无法用 live 方式重放的日志退回纯持久化镜像，标题依赖投影缓存回填。
- **两端版本需兼容**：协议与本地会话格式强相关；转换发能力时两端都必须 ≥ 0.5.0。
- **镜像落盘**：镜像会话写入本机会话存储，会占用磁盘。
- **单写者**：同一远端会话只应由一台客户端镜像；多台同时镜像同一 id 会因写锁冲突失败。
- **转发依赖共享方在线**：共享方断开后其会话立即从读取方列表消失（服务端会推 `gone`），历史请求返回 `relay-offline`。
- **转发是只读的**：读取方拿到的是镜像，不能续聊，也不会把读取方的事件回传给共享方。

## 排障

- **升级到 0.4.0 之前保存的配置其实从未生效**：`.volatile()` 字段在 schemastery 里解析为 cosmokit 的 volatile 引用，旧代码没解包就直接读，于是永远读到默认值（端口 4590、`0.0.0.0`、hostname）。0.4.0 在 `normalizeConfig` 里先解包再读，配置才真正落地——升级后请重启 DSH，并确认面板里的「监听中 `host:port`」与机器名符合预期。
- 面板显示「状态读取失败：管理接口暂不可用」：插件行还没重载，重启 DSH 或关闭再启用插件即可。
- 服务端自检：`curl http://<host>:4590/` 返回 `{ok, name, protocol, features, relay, sessions, diag}`。
- 转发不通时按这个顺序查：服务端 `server.relay.enabled` → 共享方 `client.share.enabled` 且双方握手都协商到 relay 能力（面板「能力」一行会列出）→ 共享方 `consumers` 是否包含读取方的机器名 → 共享会话是否落在 `share.sessions` / `share.cwdPrefixes` 范围内。
- 单测：`node test/relay-e2e.mjs`（一个服务端 + 一个真实发布端 + 允许/拒绝两个订阅端，覆盖能力协商、权限、实时事件与版本校验）。
- 客户端日志：`dsh` 输出里的 `已连接远程 DSH` 一行，或 `远程桥接` 前缀的告警。
- 若侧边栏整个为空，通常是镜像会话 header 与持久化 header 不一致导致 `session/list` 整体失败（已修）；删除 `$DSH_HOME/sessions/*remote-bridge*` 与 `$DSH_HOME/storages/session_projcache/sessions/session-rb-*` 后重启可恢复。
