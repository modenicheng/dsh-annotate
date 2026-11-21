# dsh-marker

批注在浏览器里产生，上下文在 Harness 里被消费。

## 它做什么

在 Firefox / Zen 里按 `Alt+Shift+A`，页面进入批注态：划词、点元素、拖框三种手势随便用，写完评论回车即可；评论可留空，留空就只把标记本身发过去。批注连同**裁剪截图**、DOM 选择器、计算样式和页面状态一起进入 DSH 队列，Agent 用 `annotate_*` 工具读取。

反过来也行：Agent 说不清「哪个按钮」时调用 `annotate_pick`，浏览器顶部弹出它写的问题，你点一下，Agent 立即拿到结果继续干活。

## 端点

- `ws://127.0.0.1:3080/ext/anno` —— 唯一通道，挂在 DSH 宿主 webserver 上，随 `dsh web` 同生共死。
- `http://127.0.0.1:3080/ext/anno/health` —— 健康检查与协议版本；带 `instanceId`（本进程的十六进制短 id）。
- `http://127.0.0.1:30810-30812/ext/anno/locate` —— 发现端口：只在宿主端口不是 `3080` 时监听（Desktop、`--port 0`、自定义端口），只答一个 `GET`，内容是当前 `origin`、`wsUrl`、`instanceId` 和时间戳；不含任何批注、会话或令牌。`POST`/`HEAD` 返回 `405`，`Host` 不是 `127.0.0.1`/`localhost` 返回 `403`，不发 CORS 头。
- `GET /ext/anno/sessions` —— 目标选择器的会话目录，`defaultSessionId` 跟随网页里正在看的会话。桥接 token 走 `Authorization: Bearer` 或 `x-anno-token` header，不接受查询串（避免落入访问日志）。
- `POST /ext/anno/session-create` —— 把一条批注投进新开的会话（默认 / 指定 / 新建工作区三种模式），token 同样只走 header；网页端「发送到新会话」用它。
- 下面五条只服务宿主自己的页面（要求 `sec-fetch-site: same-origin`），扩展永远看不到它们：
  - `POST /ext/anno/focus` —— 网页汇报它当前显示的会话。
  - `GET /ext/anno/queue?session=…` / `POST /ext/anno/queue/ack` —— 待插入编辑框的引用。
  - `GET /ext/anno/events` —— 服务端事件流（SSE）：告诉页面「这个会话有新东西了」，只带会话 id，不带正文；页面据此立刻去读队列，读不到也不会丢。
  - `GET /ext/anno/item?id=…` —— 一条批注的展示投影（chip hover 卡片用）。
  - `GET /ext/anno/image?id=…` —— 那条批注的裁剪截图 PNG。

## 工具

| 工具 | 用途 |
|---|---|
| `annotate_list` | 列出待处理批注（默认只看 open） |
| `annotate_get` | 读一条：裁剪图 + 完整锚点 JSON |
| `annotate_resolve` | 标记已处理，备注即时显示在页面角标 |
| `annotate_pick` | 让用户在浏览器里点一下，阻塞等待结果 |
| `annotate_delete` | 直接删除批注（记录、裁剪图、角标一起消失），用于清理测试痕迹 |
| `annotate_clear` | 批量清理历史 |

## 数据落在哪

- 元数据：`$DSH_HOME/annotations/queue.jsonl`（append-only，事件溯源，自动压缩）
- 图片：交给 DSH 原生 attachment 服务，日志里只存引用
- 待插入引用：`$DSH_HOME/annotations/pending-mentions.json`
- 当前显示的会话：`$DSH_HOME/annotations/focus.json`（六小时后失效）
- 桥接令牌：`$DSH_HOME/ext-bridge-token`（首次生成，0600）
- 当前地址：`$DSH_HOME/ext-bridge-endpoint.json`（每次启动写到实际端口，0600/用户配置目录 ACL；**只有地址**，令牌不进来——它永远只在上一条里）

## 边界

不替代浏览器自动化（导航、填表还是 `dsh-browser-firefox` 的活），不写 DSH 的 todo/日程，不起独立后台进程（除宿主进程内的发现端口外没有额外监听，默认 `3080` 上连它也不开），不上云。
