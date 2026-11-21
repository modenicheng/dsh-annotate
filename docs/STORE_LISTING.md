# Store listing copy

Copy for the three listings: Mozilla Add-ons (AMO), Chrome Web Store (CWS), and Microsoft Edge
Add-ons. Every block below is meant to be pasted as-is. Character limits are the ones each dashboard
shows for the field; the measured lengths are in [§6](#6-measured-lengths) and every block is under
its limit.

Scope, stated once and repeated in the copy: **supported browsers are Firefox (and Zen) and
Chromium-based browsers.** Safari is a documented non-goal ([DECISIONS.md](DECISIONS.md) D14), not a
pending target. Every block names those two engines and no more.

Each store also asks for a privacy-policy URL, which must be a public page rather than a file path.
[privacy.md](privacy.md) is the text to host; no domain is invented here, so paste the URL it ends up
at.

One maintainer note before the paste blocks: the checked-in manifest is the Firefox target.
`node scripts/build-extension.mjs --target chromium` produces the Chromium target from the same
tree — a service worker instead of `background.scripts`, no `ws://`/`wss://` host permissions (match
patterns reject them), and the `platform.js` engine shim. Read the CWS and Edge blocks against that
target, or against the CI-built zip for the tag, and never against `packages/extension`; uploads use
the CI zip, not a local build (§7.2, §8.2). The product name is `dsh-marker` everywhere a user types
it (D23); the `anno` wire vocabulary stays internal.

## 1. Mozilla Add-ons (AMO)

### Name — limit 50 characters

```
dsh-marker
```

### Summary — limit 250 characters (English)

```
Mark text, an element, or a region on a page and send it, with a cropped screenshot and its page context, to DeepSeek Harness on your machine.
```

### Summary — limit 250 characters (Chinese)

```
标记网页上的文字、元素或区域，把批注连同裁剪截图和页面信息一起交给本机的 DeepSeek Harness。
```

### Description — free text, both variants

English:

```
dsh-marker hands part of a web page to DeepSeek Harness (DSH) on your own computer, as context for
your conversation.

Mark text, an element, or a region, and the mark arrives in the DSH session you are using, with a
cropped screenshot and the page context around it. When a request is ambiguous, the model can ask
you to point at something.

HOW IT WORKS
- Press Alt+Shift+A to enter annotation mode. Select text with Shift+drag, click an element, or drag
  a region.
- A numbered marker stays pinned to what you marked, and is re-anchored as the page re-renders.
- The comment is optional; the button then reads "Send mark".
- Pick the DSH Session that should receive it. The annotation is inserted into that Session's
  composer as a chip you can remove; nothing reaches the model until you send the message.
- The model may call annotate_pick; a banner appears on the page and waits for your click until it
  times out.

WHAT YOU NEED
- DeepSeek Harness with the dsh-marker bundle enabled, on the same machine. The extension connects
  over loopback (127.0.0.1:3080 by default) after you paste the bridge token from
  $DSH_HOME/ext-bridge-token into the popup once.
- Supported browsers: Firefox (and Zen) and Chromium-based browsers. Firefox needs 128 or newer.
  Safari is not supported.

WHAT IT DOES NOT DO
- No account, no developer server, no telemetry, no analytics.
- Nothing leaves your machine: annotations go to your local DSH host, which stores them under
  $DSH_HOME.
- No remote code, no third-party requests, no ads.

PRIVACY
See docs/privacy.md in the repository for what is read, where it goes, and what is stored:
https://github.com/modenicheng/dsh-annotate.

FEEDBACK
https://github.com/modenicheng/dsh-annotate/issues
```

Chinese:

```
dsh-marker 把网页上标记的内容发给本机的 DeepSeek Harness（DSH），作为对话的上下文。

划词、点元素，或拖框选一块区域；标记连同裁剪截图和周边页面信息，送进你正在用的 DSH 会话。
请求含糊时，模型也可以请你指一下。

怎么用
- 按 Alt+Shift+A 进入批注模式：Shift+划词选文字，点一下选元素，拖动选框选区域。
- 标记以编号钉在选区或元素上，页面重绘后会重新找位置。
- 评论可以不写，留空即只发送标记；未连接宿主时发送按钮禁用，框下有提示。
- 选择送给哪个会话：批注以引用的形式插进那个会话的输入框，随时可以删掉；消息发不发，由你决定。
- 模型可以调用 annotate_pick 请你指一个位置，页面上会出现提示条等你的点击。

需要什么
- 本机装了 DeepSeek Harness 并启用了 dsh-marker 插件；在扩展弹窗里粘贴一次
  $DSH_HOME/ext-bridge-token 里的令牌。
- 支持的浏览器：Firefox（含 Zen）与 Chromium 内核浏览器；Firefox 需 128 或更高版本。不支持 Safari。

不做什么
- 没有账号，没有开发者服务器，没有遥测和统计。
- 数据不出本机：批注只发给本机的 DSH 宿主，存在 $DSH_HOME 下。
- 不加载远程代码，不请求第三方资源，没有广告。

隐私
读什么、发到哪里、存什么，见仓库 docs/privacy.md：https://github.com/modenicheng/dsh-annotate

反馈
https://github.com/modenicheng/dsh-annotate/issues
```

### Category

**Developer Tools.** AMO accepts one category per add-on; this is it. The homepage and support URLs
are the ones in §2.

## 2. Chrome Web Store

### Name — limit 45 characters

```
dsh-marker
```

### Short description — limit 132 characters

English (105 characters):

```
Mark text, an element, or a region of a page and send it, with a cropped screenshot, to DeepSeek Harness.
```

Chinese:

```
标记网页上的文字、元素或区域，把批注连同裁剪截图一起交给本机的 DeepSeek Harness。
```

### Detailed description — limit 16,000 characters

The AMO English description in §1 is the CWS detailed description verbatim; paste the same block.
It is 1,726 characters. For a localised listing, paste the AMO Chinese description instead (724
characters); both stay in the same §1 section.

### Category

**Developer Tools.**

### Single purpose — limit 1,000 characters

```
dsh-marker has one purpose: turn a text selection, an element, or a region of the current page into a
structured annotation with a cropped screenshot, and deliver it to a DeepSeek Harness instance the
user runs on the same computer.
```

### Permission justifications — limit 1,000 characters each

#### `storage`

```
Stores the bridge token the user pastes once, the host address and connection preferences, the queue
of unsent annotations, and the last connection status, in browser.storage.local. The queue holds at
most 40 marks with their crops; it is written before sending and cleared only when the DSH host
acknowledges the mark, so an annotation written before a tab closes or the background page is
suspended is not lost. No other storage area is used.
```

Source: `src/shared/messages.js:71` (keys), `src/background/outbox.js:33` (cap),
`src/popup/popup.js:301` (the token write).

#### `alarms`

```
Creates exactly one repeating alarm. On Firefox it fires every 20 seconds and is the keepalive: it
sends a ping on the bridge socket, retries a dropped connection, and flushes queued annotations. On
Chromium the platform floor is 30 seconds, so the same alarm fires once a minute and only reconnects
and refreshes; a 20-second WebSocket ping is what keeps the service worker alive there. No other
alarm is created, and nothing is scheduled or tracked for any other purpose.
```

Source: `src/background/main.js:36` (period per engine), `main.js:43` (Chromium heartbeat),
`main.js:140` (`ensureAlarm`), `main.js:206-226` (one alarm pass).

#### `tabs`

```
Reads the URL and title of open tabs to deliver each annotation event to the tab whose document owns
it, to refresh the numbered badges on the right pages, to choose which tab shows a pick request from
the agent, and to show the current page in the popup. A mark's screenshot calls tabs.get and
tabs.captureVisibleTab on the tab the user is on. Page content is never read through this
permission; text and DOM come from the content script.
```

Source: `src/background/routing.js:257-267`, `routing.js:301-313`, `routing.js:320-341`,
`routing.js:630-649`, `routing.js:1008-1015`, `src/background/capture.js:356`, `capture.js:374`.

> **Audit concluded 2026-11-20: the permission stays.** [DISTRIBUTION.md](DISTRIBUTION.md) §3.1
> originally called `tabs` "probably redundant" on the assumption that `<all_urls>` content scripts
> grant URL access; in MV3 they do not, and an extension receives `tab.url` / `tab.title` only with
> `tabs` or `<all_urls>` host access — which this extension deliberately does not request, since its
> host permissions are loopback-only. The code proves it is load-bearing: `routing.js` filters tabs by
> `tab.url` and reads `tab.title`. §3.1 has been corrected. If a later release drops the permission,
> this justification block is replaced by a one-line statement that no tab metadata is read — not
> deleted silently.

#### `activeTab`

```
Grants access to the tab the user is looking at after they invoke the extension: the Alt+Shift+A
shortcut, the toolbar button, or the popup. That grant is what makes the captureVisibleTab call that
produces a mark's screenshot legal, and what lets the popup inject the annotation overlay into a page
that has no content script yet. No screenshot is taken except for a mark, and no page is captured
without the user's own invocation.
```

Source: `src/background/capture.js:12-15`, `capture.js:374`, `src/popup/popup.js:601-620`.

#### `scripting`

```
Injects the extension's own content-script files into the tab the user invoked, when that tab was
already open before the extension was installed or updated and therefore has no annotation overlay.
The file list comes from the manifest's content_scripts array; there is no remote code and no
user-supplied script. Injection is attempted only after a message to that tab found no content
script, and at most once a minute per tab.
```

Source: `src/background/routing.js:196-211` (file list from the manifest, 60 s cooldown),
`routing.js:223-245` (inject only after a missing receiver).

#### `<all_urls>` host access

```
The content script is declared for <all_urls> so the annotation overlay is available on any page the
user chooses to mark; it reads page text only for the mark being made, or to keep marks already
stored for that page in place. It does not run on about:, extension pages, the PDF viewer,
view-source: or data: URLs. The overlay and the numbered marks are DOM nodes the extension adds to
the page, which is the "change" half of the permission.
```

Source: `manifest.json` `content_scripts[0].matches`, `src/content/main.js:166-187` (restricted
documents), `src/content/hydrator.js:520-521` and `hydrator.js:559` (the `<mark>` elements the
extension adds to the page).

### Data usage answers

```
Does this item collect user data?   No
Data types collected:               none
Does it use remote code?            No
Transmission:                       page content, a cropped screenshot of the visible tab, and the
                                    bridge token go only to a DeepSeek Harness host on the same machine
                                    (127.0.0.1/localhost by default). Nothing is sent to the developer,
                                    to analytics, or to any third party.
```

The answer is "No" because the only destination in the manifest's host permissions is loopback. If a
reviewer asks for evidence: `manifest.json` lists `127.0.0.1` and `localhost` only, the CSP is
`script-src 'self'`, and there is no analytics or update endpoint anywhere in `src/`.

### Support and home pages

```
Homepage URL:   https://github.com/modenicheng/dsh-annotate
Support URL:    https://github.com/modenicheng/dsh-annotate/issues
```

## 3. Microsoft Edge Add-ons

The first store this project can actually ship to: registration is free, a Microsoft account is
enough, and the package is the same Chromium zip the CWS listing takes. Edge also installs CWS items,
so once CWS exists this listing is additive rather than the only Chromium route.

Two fields are **not** pasted in the dashboard. Edge reads `name` and `description` from the
manifest — `__MSG_extName__` / `__MSG_extDescription__` in `_locales/` — and shows them read-only.
Changing either needs a new package, not a listing edit.

### Name — limit 45 characters

```
dsh-marker
```

### Short description — limit 132 characters

Comes from the manifest, read-only: `_locales/en/messages.json` (`extDescription`) and
`_locales/zh_CN/messages.json`. Edit the locale files and rebuild, not the dashboard.

### Description — 250 to 10,000 characters

Do **not** paste the CWS description here: Edge policy 1.1.2 says a listing "must not reference other
browsers", and the CWS block names Firefox. Use the block below, which names Microsoft Edge,
discloses the DSH dependency that policy 1.2.3 requires, and stays above the 250-character floor.

English:

```
dsh-marker hands part of a web page to DeepSeek Harness (DSH), the assistant you run on your own computer, as context for your conversation.

Mark text, an element, or a region in Microsoft Edge, and the mark arrives in the DSH session you are using, with a cropped screenshot and the page context around it. When a request is ambiguous, the model can ask you to point at something.

HOW IT WORKS
- Press Alt+Shift+A to enter annotation mode. Select text with Shift+drag, click an element, or drag a region.
- A numbered marker stays pinned to what you marked, and is re-anchored as the page re-renders.
- The comment is optional; leaving it empty sends the mark alone, and the send button is disabled with a hint while the host is not connected.
- Pick the DSH Session that should receive it. The annotation is inserted into that Session's composer as a chip you can remove; nothing reaches the model until you send the message.
- The model may call annotate_pick; a banner appears on the page and waits for your click until it times out.

WHAT YOU NEED
- DeepSeek Harness with the dsh-marker bundle enabled, on the same computer. The extension connects over loopback (127.0.0.1:3080 by default) after you paste the bridge token from $DSH_HOME/ext-bridge-token into the popup once. This is the product's one non-integrated dependency, and it runs on your machine, not on a server of ours.
- Microsoft Edge 88 or newer on desktop. The extension is Manifest V3.

WHAT IT DOES NOT DO
- No account, no developer server, no telemetry, no analytics.
- Nothing leaves your machine: annotations go to your local DSH host, which stores them under $DSH_HOME.
- No remote code, no third-party requests, no ads.

PRIVACY
The privacy policy linked on this listing states what is read, where it goes, and what is stored: https://github.com/modenicheng/dsh-annotate/blob/main/docs/privacy.md

FEEDBACK
https://github.com/modenicheng/dsh-annotate/issues
```

Chinese:

```
dsh-marker 把网页上标记的内容发给本机的 DeepSeek Harness（DSH），作为对话的上下文。

在 Microsoft Edge 里划词、点元素或拖框选一块区域；标记连同裁剪截图和周边页面信息，送进你正在用的 DSH 会话。请求含糊时，模型也可以请你指一下。

怎么用
- 按 Alt+Shift+A 进入批注模式：Shift+划词选文字，点一下选元素，拖动选框选区域。
- 标记以编号钉在选区或元素上，页面重绘后会重新找位置。
- 评论可以不写，留空即只发送标记；未连接宿主时发送按钮禁用，框下有提示。
- 选择送给哪个会话：批注以引用的形式插进那个会话的输入框，随时可以删掉；消息发不发，由你决定。
- 模型可以调用 annotate_pick 请你指一个位置，页面上会出现提示条等你的点击。

需要什么
- 本机装了 DeepSeek Harness 并启用了 dsh-marker 插件；在扩展弹窗里粘贴一次 $DSH_HOME/ext-bridge-token 里的令牌。这是产品唯一的外部依赖，它跑在你的机器上，不在我们的服务器上。
- 桌面版 Microsoft Edge（Manifest V3）。

不做什么
- 没有账号，没有开发者服务器，没有遥测和统计。
- 数据不出本机：批注只发给本机的 DSH 宿主，存在 $DSH_HOME 下。
- 不加载远程代码，不请求第三方资源，没有广告。

隐私
读什么、发到哪里、存什么，见本 listing 链接的隐私政策：https://github.com/modenicheng/dsh-annotate/blob/main/docs/privacy.md

反馈
https://github.com/modenicheng/dsh-annotate/issues
```

### Category

**Developer tools.**

### Privacy policy

`https://github.com/modenicheng/dsh-annotate/blob/main/docs/privacy.md`. Edge policy 1.5.2 asks that
the policy primarily refer to Microsoft Edge rather than another browser; the policy's opening line
now names Edge first and the rest is engine-neutral.

## 4. What's new — overwritten per version

The store dashboards take release notes per uploaded version. The release workflow renders the commit
range since the previous tag and a human edits it before Publish (DISTRIBUTION.md §4.5); store text
cannot be regenerated after submission. This is the placeholder it replaces:

```
dsh-marker <version>

<one or two lines generated from the changelog for this release>

Full notes: https://github.com/modenicheng/dsh-annotate/releases/tag/v<version>
```

Rules for whoever edits it: one line per user-visible change, no commit hashes, no "misc fixes".

## 5. Screenshots — four 1280×800 shots

CWS wants 1280×800 (or 640×400) images; AMO accepts the same files. All of them must show the real
extension on a real page — no mockups, no annotations drawn in an image editor, no devtools panel, no
bookmarks bar, no token, no personal names in the Session picker.

Four were produced on 2026-11-20 from a live Firefox session and live-bridge annotations, into
`dist/store/` (gitignored, 1280×800 PNG, downscaled 1.25× from a 1600×1000 device-pixel capture):

| File | Shows | Ready to upload |
|---|---|---|
| `shot-1-targeting.png` | annotation mode armed, paragraph outlined, `p · 838×72` chip | yes |
| `shot-2-compose.png` | numbered mark + composer: element chip, intent chip, Session target, written comment | yes |
| `shot-3-arrival.png` | the annotation card in a DSH conversation: crop, page title, selector, comment, agent reply | **not yet** — a real transcript and a masked account name are visible; re-shoot in a fresh conversation first |
| `shot-4-popup.png` | the popup: connection status, Automatic/Manual, host and port, masked token | yes (the token field is dots) |

The UI in all four is Chinese because the browser locale is `zh-CN`; an English set for the English
listings would need a browser-locale change, not a new build.

### Shot 1 — annotation mode is armed

- A public documentation or blog article, scrolled so two full paragraphs are visible.
- `Alt+Shift+A` already pressed: the HUD is visible, reading **Annotation mode** (Chinese: 批注模式)
  with the hint `click element · drag region · Shift+drag text`.
- The pointer hovers one paragraph: its outline is drawn and the chip label shows the tag and size,
  for example `p · 640×220`.
- One existing numbered mark (a small `1` badge) on the article, so the numbered-marker claim is
  visible in the first shot.

### Shot 2 — select, write, choose a target

- The same page with a sentence selected; the composer's header says **Selected text** and the quote
  under it is the selected sentence.
- The composer is open, the textarea is empty, and the send button reads **Send mark** — the optional
  comment is the point of this shot.
- The **Send to** picker is open with two Session rows, none of them containing private material.
- The marked paragraph stays outlined behind the composer.

### Shot 3 — it arrived in DSH

- The DSH Web Client on the same conversation, with the annotation chip in the composer (or a
  transcript chip of a sent message) and its hover card open.
- The card shows the page title, the quoted sentence from shot 2, the comment if one was written, and
  the crop — the crop must be recognisable as the same paragraph.
- Nothing else in the conversation: one annotation, no model answer containing personal data.

### Shot 4 — connecting to the host

- The popup on its own, floating over an out-of-focus capture of the same page: nothing in the frame
  claims to be browser chrome, so no fake toolbar is implied.
- The status line reads **Connected to the host** with `Automatic · 127.0.0.1:3099 (anno) · token
  saved · advertised by the host` — the "it found the host itself" claim, visible.
- Host and port fields at their defaults, and the token field showing dots only.
- Crop the popup above the `Save and reconnect` row: the popup scrolls, and a half-cut button reads as
  a broken screenshot rather than a scrollable panel.

## 6. Measured lengths

Counted as characters, fences excluded. Re-measure after any edit; the limits are the ones quoted in
each heading above.

| Block | Measured | Limit |
|---|---|---|
| Name (all three stores) | 10 | 45 (CWS, Edge) / 50 (AMO) |
| AMO summary, English | 142 | 250 |
| AMO summary, Chinese | 54 | 250 |
| Description, English | 1,726 | 16,000 (CWS) |
| Description, Chinese | 724 | free text on AMO |
| Edge description, English | 1,938 | 10,000 (min 250) |
| Edge description, Chinese | 776 | 10,000 (min 250) |
| CWS short description, English | 105 | 132 |
| CWS short description, Chinese | 49 | 132 |
| Single purpose | 232 | 1,000 |
| Justification: `storage` | 444 | 1,000 |
| Justification: `alarms` | 473 | 1,000 |
| Justification: `tabs` | 439 | 1,000 |
| Justification: `activeTab` | 432 | 1,000 |
| Justification: `scripting` | 429 | 1,000 |
| Justification: `<all_urls>` | 442 | 1,000 |

## 7. First submission (Chrome Web Store)

Sections 1–6 are copy. This section is the order of operations for the one submission that cannot be
fully automated: the item has to exist in the dashboard before `release.yml` can upload to it, and a
store version cannot be withdrawn once submitted. Everything here happens once; later versions go
through the release workflow (§4.6 of [DISTRIBUTION.md](DISTRIBUTION.md)).

### 7.1 Account, before anything else

- A Google account with 2-step verification.
- Register at <https://chrome.google.com/webstore/devconsole> — US$5 once, developer name and contact
  email, identity verification (Google may take a day).
- Use a contact email that is actually read: policy questions and rejection reasons arrive there, and
  the reviewer's clock starts when the item is submitted, not when it is uploaded.

### 7.2 Pick the version, then verify the artifact

Submit a final only (D16): `MAJOR.MINOR.PATCH`, the number inside the zip's `manifest.json`, matching
its tag. The thing to upload is the release asset, not a local build:

```
dsh-marker-chromium-<version>.zip     on the GitHub Release for the tag
checksums.txt                         same release; compare the zip's SHA-256
```

Before uploading, unzip the asset and check it: `node scripts/check-manifest.mjs <unzipped-dir>`
must pass, `manifest.json` must sit at the archive root, and the version must be the release's. The
zip is the artifact the reviewer runs; a local `dist/chromium` proves nothing about the upload.

### 7.3 Create the item and upload

1. Developer Dashboard → **New item** → upload that zip.
2. The upload creates the **item ID**. The dashboard URL carries both IDs —
   `/devconsole/<publisher-id>/<item-id>/…` — and they are `vars.CWS_PUBLISHER_ID` and
   `vars.CWS_ITEM_ID` for the release workflow (§4.6).
3. Do not submit yet. The next two screens (listing, privacy) are part of the same review; an item
   submitted with empty fields comes back as a rejection, not a question.

### 7.4 Field map

Every paste block lives in §2 of this file. The dashboard's section names are the current ones; if a
label has moved, the content has not.

| Dashboard screen | Field | Paste |
|---|---|---|
| Store listing | Name | §2 Name |
| Store listing | Short description | §2 Short description |
| Store listing | Detailed description | §2 Detailed description |
| Store listing | Category | Developer Tools |
| Store listing | Language | English; a Chinese listing is optional |
| Store listing | Screenshots | `dist/store/shot-*.png` (§5) |
| Privacy practices | Single purpose | §2 Single purpose |
| Privacy practices | Justification — `storage`, `alarms`, `tabs`, `activeTab`, `scripting` | §2, one block each |
| Privacy practices | Host permission justification | §2 `<all_urls>` block |
| Privacy practices | Data usage | §2 Data usage answers |
| Privacy practices | Privacy policy URL | §7.5 |
| Privacy practices | Remote code | No |
| Distribution | Visibility, regions, pricing | Public, all regions, free |
| Test instructions | Reviewer instructions | §7.6 |

### 7.5 The privacy policy URL

`docs/privacy.md` is the policy; the dashboard needs a public URL, not a repository path. Two
workable choices, both zero-cost:

- **GitHub blob** — `https://github.com/modenicheng/dsh-annotate/blob/main/docs/privacy.md`.
  No setup, and the page is public. GitHub's chrome surrounds the text; reviewers accept that.
- **GitHub Pages** — Settings → Pages → Deploy from a branch, `main`, folder `/docs`, then
  `https://modenicheng.github.io/dsh-annotate/privacy`. A cleaner page; one repository setting, and
  its URL replaces the blob link in this file once it exists.

Either way the policy must stay true to the shipped code: any change to what the extension reads or
where it sends it updates `privacy.md` (and its date) in the same commit.

### 7.6 Test instructions (paste as-is)

The reviewer needs to know which half of the product is inside this item. The overlay works with no
host installed; sending needs one. Saying that plainly is the difference between a rejection for
"does not work" and a reviewed listing.

```
dsh-marker has two halves. This item is the browser half: the overlay that turns a text selection,
an element, or a dragged region into a numbered mark with a cropped screenshot. The other half is
DeepSeek Harness (DSH), an open-source program the user runs on the same computer; the extension
sends marks to it over loopback only. No host is needed to review everything this item does to a
page.

Review without the host:
1. Install the item. The popup opens with the connection settings: host 127.0.0.1, port 3080, an
   empty token field, and a connected/not-connected status. Nothing is preconfigured.
2. Open any http(s) page and press Alt+Shift+A (Option+Shift+A on macOS). A small "Annotation mode"
   bar appears at the top of the page.
3. Drag across a paragraph with Shift held; the words are marked and a numbered badge stays next to
   them. A click marks an element; a drag marks a region. Esc leaves annotation mode.
4. Zoom, scroll, or edit the page: the badge follows what it marks. Reload: it is re-found.
5. The toolbar icon reopens the popup; "Send mark" is disabled while no host is connected.

With the host, for the sending path:
- Node.js 22+ and DSH: `dsh plugin add dsh-marker`, then `dsh web`.
- Paste the token from $DSH_HOME/ext-bridge-token (%USERPROFILE%\.dsh\ext-bridge-token on Windows)
  into the popup and press "Save and reconnect".
- Mark a sentence, press "Send mark", pick a Session; the mark appears in that Session's composer.

The extension requests no account, contacts only 127.0.0.1 and localhost, loads no remote code, and
sends nothing to the developer. Source, issue tracker and the full privacy policy:
https://github.com/modenicheng/dsh-annotate
```

### 7.7 Submit, and what to expect

1. Review the four screens once more against §7.4, then **Submit for review**. The publish type
   (`DEFAULT_PUBLISH` / `STAGED_PUBLISH`) belongs to the API call for later versions; the dashboard
   asks only that you submit.
2. Review is days, not hours; `<all_urls>` and `tabs` are the permissions most likely to draw a
   question. A rejection names the policy and the field, and the answer is a corrected listing or a
   code change plus a new version — never the same version again (§4.2 of
   [DISTRIBUTION.md](DISTRIBUTION.md)).
3. Once published, the listing is live for all users at once unless a staged rollout is configured.
   Rollback to the previous published version is a dashboard action; a rollback is not an uninstall
   for anyone who already has the new version.
4. For later versions, add the CWS credentials to the protected `release` environment:
   a Google Cloud project with the Chrome Web Store API enabled, an OAuth **Desktop app** client,
   a refresh token for `https://www.googleapis.com/auth/chromewebstore`, then `CWS_CLIENT_ID`,
   `CWS_CLIENT_SECRET`, `CWS_REFRESH_TOKEN` as secrets and `CWS_PUBLISHER_ID`, `CWS_ITEM_ID`,
   `CWS_PUBLISH_TYPE` as variables. The workflow's `:publish` call submits for review; it does not
   publish immediately.

### 7.8 What the first submission still needs from a human

| Item | Why it cannot be automated |
|---|---|
| Account registration and identity verification | Tied to a person and a payment method |
| The item's creation | The dashboard is the only place an item ID is minted |
| Privacy policy URL choice | A repository setting (§7.5) |
| Screenshots | Real captures of the real UI, re-shot per version (§5) |
| Submit for review | The irreversible click |

## 8. First submission (Microsoft Edge Add-ons)

§3 is the copy; this is the order of operations. Everything here is one-time: once the product
exists, the Edge Publish API can take later versions (§8.9), but the first item cannot be created
through it.

### 8.1 Account

- A Microsoft account, then Partner Center: <https://partner.microsoft.com/dashboard/microsoftedge/public/login>.
- The Edge program is free — no card, no fee. An individual account is enough; the publisher name is
  public on the listing.
- Registration asks for a contact address. Chinese addresses work, but the province field wants the
  code (`GD`, `ZJ`, …) rather than the name; a Chinese province name is the most common reason the
  form refuses to submit.

### 8.2 The artifact

The package is the Chromium zip that CI built for the release tag — not a local `dist/` build
([AGENTS.md](../AGENTS.md): releases and packaging are CI-only). Take it from the release:

```
dsh-marker-chromium-<version>.zip     on the GitHub Release for the tag
checksums.txt                         same release; verify the zip's SHA-256
```

The tag build may still be a **draft**: its assets are attached and downloadable before the release
is published, so the first store submission does not have to publish the release (and npm) first.

Before uploading, unzip the asset and check it: `manifest.json` at the archive root, no `test/`, no
`package.json`, `node scripts/check-manifest.mjs <unzipped-dir>` passing, and the version inside
matching the tag. A local `node scripts/build-extension.mjs --target chromium` is QA only; never
upload its output.

### 8.3 Create the extension and upload

1. Partner Center → **Edge** workspace → **Create new extension**.
2. Upload the zip. The package is validated on the spot; a manifest error appears here, not at
   certification.
3. **Packages** → **Continue**.

### 8.4 Availability

`Public`, all markets. Edge's default covers all current and future markets; leave it.

### 8.5 Properties

| Field | Value |
|---|---|
| Category | Developer tools |
| Website | https://github.com/modenicheng/dsh-annotate |
| Support contact | https://github.com/modenicheng/dsh-annotate/issues |
| Mature content | No |

### 8.6 Privacy

| Section | Paste |
|---|---|
| Single Purpose | §2 Single purpose |
| Permission justification | §2, one block per permission Edge lists (`storage`, `alarms`, `tabs`, `activeTab`, `scripting`, and the `<all_urls>` host permission) |
| Are you using remote code? | No |
| Data usage | No data types selected; nothing is sent to the developer or a third party. Page content and the cropped screenshot go only to a host on the same machine. |
| Privacy policy URL | §7.5 |

The justifications are read from the uploaded manifest, so a permission that appears without a
justification is a form error, not a later review surprise.

### 8.7 Store listing, per language

The package declares `en` and `zh_CN`, so Partner Center shows one row per language and requires a
Description and a logo for **each**.

| Field | Value |
|---|---|
| Extension name | from the manifest, read-only |
| Short description | from the manifest, read-only |
| Description | §3 English / Chinese; the form requires at least 250 characters |
| Extension logo | `dist/store/edge-logo-300.png` (300×300, 1:1) |
| Screenshots | `dist/store/shot-*.png`, 1280×800, at most 6 |
| Search terms | `annotation`, `deepseek`, `dsh`, `mark`, `screenshot`, `context` (max 7 terms, 21 words total) |

The logo is rendered from `packages/extension/icon/icon.svg` at 300×300 with transparent corners,
which is what the store card expects. Use **Duplicate** to copy the logo and screenshots to the
second language instead of uploading twice.

### 8.8 Notes for certification

Paste §7.6, with the first line changed to name this Edge listing. The point that decides the
review is that the overlay is testable without the host: install, open any page, press `Alt+Shift+A`,
mark a sentence. The DSH host is needed only for the sending path, and §3 discloses it, which is
the dependency disclosure Edge policy 1.2.3 asks for.

### 8.9 Submit, and after

**Publish** moves the item to certification; the docs cap it at seven business days. When it passes,
the listing is live and Partner Center shows **In the Store**.

For later versions, the Edge Publish API takes over: a client ID, an API key, and the product ID from
the extension's Publish API page. The first submission is manual because the product must exist
before the API can name it — the same bootstrap as CWS (§7.3), minus the fee.
