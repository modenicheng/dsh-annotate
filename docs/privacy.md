# Privacy policy

**dsh-marker** — browser extension for Microsoft Edge, Chrome, Firefox (and Zen), and other Chromium-based browsers. Last updated: 2026-11-21.

dsh-marker marks text, an element, or a region of a page and hands it to a DeepSeek Harness (DSH)
instance running on your own computer. No account, no developer server, no service behind it. This
page states what it reads, where that goes, what it stores, and what it never does.

## What it reads

- **Page address and title**, on every page, so a mark is stored against its document and re-found
  after a reload.
- **Page content, only when a mark needs it.** Annotation mode (default `Alt+Shift+A`) plus a
  selection, an element click, or a dragged region reads just that mark: the selected text (up to
  4,000 characters) with 32 characters either side, CSS/XPath selectors, an element text excerpt, its
  attributes (each value cut to 200 characters; `value`, `on*`, `style` and `srcset` skipped), a few
  computed styles, or the 2–3 elements a region overlaps. On a page with saved marks the same limited
  data is read again to keep the numbered badges in place.
- **One screenshot of the visible tab, when you send a mark**, cropped to it; if the crop fails or
  the mark is under 4 CSS px, the whole viewport is sent instead.
- **Uncaught page errors** — the last 10, truncated, kept in memory, sent only with a mark.
- **Your browser's user-agent string**, in the connection handshake.

Not read: form values, `on*` attributes, cookies. On `about:`, extension pages, the PDF viewer,
`view-source:` and `data:` pages the overlay stands down; only the URL and title are read.

## Where it goes

All traffic goes to the DSH host you point the extension at — `127.0.0.1:3080` by default, or the
address you type in the popup:

- `ws(s)://<host>/ext/anno` — the annotation socket: marks, comments, crops, connection frames.
- `http(s)://<host>/ext/anno/health` — asks whether to use `ws://` or `wss://` — and
  `http(s)://<host>/ext/anno/sessions`, the Session list behind the "insert into" picker.
- With automatic discovery on and a port other than 3080, one `GET` to each of
  `http://127.0.0.1:30810–30812/ext/anno/locate`, answering with the host's origin and instance id —
  never a token, never page data.

No other destination exists in the code: no telemetry, analytics, crash reporter, ad, CDN, update
server, or fallback URL. `manifest.json` grants host access to `127.0.0.1` and `localhost` only; any
other origin would take a manifest change.

The host is a separate program on your machine: it stores annotations under `$DSH_HOME` and offers
them to the model in the session you are using, like any other tool output. That storage is the
host's, not the extension's; the [README](../README.md#where-data-lives) lists it.

## What is stored in the browser

`browser.storage.local` only, in this browser profile. Uninstalling the extension deletes all of it.

| Key | Contents | Kept until |
|---|---|---|
| `anno.token` | the bridge token you pasted | you clear or replace it |
| `anno.prefs` | host, port, scheme, discovery mode, preferred host, hidden state | you change it |
| `anno.outbox` | unsent marks, at most 40, with crops (about 6 MB of base64) | the host acknowledges them; oldest dropped past the cap |
| `anno.status` | last connection status, for the popup's first paint | overwritten on every change |
| `anno.endpoint` | scheme and URL the host advertised last | 10 minutes, or a failed connection |
| `anno.address` | last host that answered: origin and instance id | 12 hours, or a fresh scan |
| `anno.clientId` | a random id so the host can attribute reconnects | you clear extension data |

## What it does not do

- No telemetry, analytics, usage statistics, or error reporting to the developer.
- No third-party requests: no fonts, images, scripts or beacons from anyone but your own host.
- No remote code: every script and injected snippet ships in the package, the CSP is
  `script-src 'self'`, and nothing is fetched at runtime.
- No selling, sharing, or transfer of data; no ads; no "improve the product" collection.
- No browsing history, bookmarks, or downloads. The `tabs` permission warns about browsing history;
  what is read is the open tab list — URLs and titles — to route annotations to their pages, choose
  which tab shows an agent's pick, and label the popup.

## The all-sites permission

`<all_urls>` exists for one reason: you decide which page to mark, so the overlay has to be available
on whatever page you are reading.

## Contact and changes

Questions and reports: https://github.com/modenicheng/dsh-annotate/issues. This file is canonical: a
release that changes what is read or where it goes updates this page in the same change, and the date
above moves with it. Source: https://github.com/modenicheng/dsh-annotate — no build step, so the code
that reads a page is the code that is running.

## 中文

**dsh-marker** — Microsoft Edge、Chrome、Firefox（含 Zen）等浏览器的扩展。最后更新：2026-11-21。

dsh-marker 把网页上的一段文字、一个元素或一块区域变成批注，交给本机的 DeepSeek Harness（DSH）。
没有账号，没有开发者服务器，也没有任何后台服务。下面是它读什么、发到哪里、存什么、不做什么。

**读什么**：页面地址与标题；进入批注模式（默认 `Alt+Shift+A`）划词、点元素或拖框时，只读这次标记
需要的内容 —— 选中文字（最多 4,000 字符）及前后各 32 个字符、CSS/XPath 选择器、元素文本片段、元素
属性（每个值截到 200 字符，跳过 `value`、内联 `on*`、`style`、`srcset`）和少量计算样式；已有批注的
页面会重读同样有限的内容，把编号标记放回原位。表单值、密码、Cookie、浏览历史一律不读；`about:`、
扩展页、PDF 阅读器、`view-source:`、`data:` 页面上浮层不启动。

**发到哪里**：只发给弹窗里指向的 DSH 宿主（默认 `127.0.0.1:3080`），路径为 `/ext/anno`（批注）、
`/ext/anno/health`（决定用 `ws://` 还是 `wss://`）、`/ext/anno/sessions`（会话列表）；开启自动发现
且端口不是 3080 时，向 `127.0.0.1:30810–30812` 各发一次 `/ext/anno/locate`，只回地址和实例 id。截图
只在你点发送时截取可见标签页；最近 10 条页面报错和浏览器 User-Agent（仅握手）随批注发出。代码里没有
别的目的地：无遥测、统计、崩溃上报、广告、CDN、更新服务器或备用地址；清单只授予 `127.0.0.1` 与
`localhost` 的访问权限。

**本地存什么**：只存在 `browser.storage.local`，卸载扩展即删除。`anno.token` 是你粘贴的令牌；
`anno.prefs` 是地址与界面偏好；`anno.outbox` 是未发出的批注，最多 40 条、截图合计约 6 MB，宿主确认
后删除、超出上限丢弃最旧的；`anno.status` 是最近一次连接状态，随变随覆盖；`anno.endpoint` 保留 10
分钟，`anno.address` 保留 12 小时，`anno.clientId` 是供宿主区分重连的随机 id。批注本身由宿主存在
`$DSH_HOME` 下，那份存储属于宿主（见 [README](../README.md#where-data-lives)）。

**不做什么**：不收集、不回传、不出售、不共享任何数据；不请求任何第三方资源；不加载远程代码（CSP 为
`script-src 'self'`）；不读浏览历史、书签、下载记录；打开的标签页只读 URL 与标题，用于把批注送到对应
页面、给弹窗显示当前页。

**全站访问权限**：申请 `<all_urls>` 只有一个原因 —— 由你决定标注哪一页，批注浮层就必须能出现在你正在
读的那一页上。

**联系与变更**：https://github.com/modenicheng/dsh-annotate/issues。本文件是唯一正式版本；哪次发布改
变了读取范围或发送目的地，同一次改动就更新本页，上面的日期随之更新。源码：
https://github.com/modenicheng/dsh-annotate。
