# Privacy policy — dsh-marker for Microsoft Edge

**dsh-marker** — extension for Microsoft Edge. Last updated: 2026-11-21.

This page is the privacy policy for the Microsoft Edge Add-ons listing of dsh-marker. The extension
reads, sends, and stores the same data in every browser target; the project-wide policy at
[privacy.md](privacy.md) is the canonical full text, and this page is its Edge edition. A change to
what the extension reads or where it sends it updates both pages in the same commit.

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
other origin would take a manifest change. The DSH host stores annotations under `$DSH_HOME`; that
storage belongs to the host program you run, not to Microsoft or to the extension's developer.

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

Questions and reports: https://github.com/modenicheng/dsh-annotate/issues. Source:
https://github.com/modenicheng/dsh-annotate — no build step, so the code that reads a page is the code
that is running. A release that changes what is read or where it goes updates this page, its canonical
counterpart, and the date above in the same change.

## 中文

本页是 dsh-marker 在 Microsoft Edge 加载项商店的隐私政策，与项目主政策
[privacy.md](privacy.md) 内容一致；任何一份改动读取范围或发送目的地，同一次提交内同步更新。

读取：页面地址与标题；仅在制作标记时读取选中文字（最多 4,000 字符及前后各 32 字符）、CSS/XPath
选择器、元素文本与属性（跳过 `value`、内联 `on*`、`style`、`srcset`）、少量计算样式，或区域重叠的
2–3 个元素；发送时截取一次可见标签页；最近 10 条页面报错随标记发送；握手时发送 User-Agent。不读
表单值、Cookie、浏览历史。

发送：只发给你指定的本机 DSH 宿主（默认 `127.0.0.1:3080`），不发开发者、不发第三方；无遥测、
无广告、无远程代码、无第三方资源。

本地：只存 `browser.storage.local`（令牌、偏好、最多 40 条未发送批注、连接状态与短期地址缓存），
卸载即删除。批注本身由宿主存在 `$DSH_HOME` 下，那份存储属于宿主。

联系与变更：https://github.com/modenicheng/dsh-annotate/issues。
