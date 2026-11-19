# dsh-marker

Marks made in your everyday browser, as first-class context for
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH).

Point at a paragraph, an element, or a region in Firefox or Zen, add one line of
intent, and the mark lands in the running DSH Session with a cropped screenshot,
DOM selectors, and page context. The model can also ask you to point at
something (`annotate_pick`) when a request is ambiguous.

This package is the **host half**: the DSH bundle that serves the bridge, stores
marks, and registers the `annotate_*` tools. The browser half is the `dsh-marker`
extension in the same repository — without it the tools have nothing to read.

## Install

```sh
dsh plugin add dsh-marker
```

Add `--profile <name>` to install into a profile other than the one `dsh` boots.
The bundle's one runtime dependency (`ws`) is installed with it, so the machine
needs the npm registry reachable once. If the plugin row is inactive, enable
`dsh-marker` on the **Plugins** page of the DSH Web UI.

Requirements: DSH 0.2 or newer (declared as `engines.dsh`, checked before
install) and Node.js 22+. The bridge binds to loopback only; there is no extra
daemon and no extra port beyond the DSH webserver it attaches to.

## The browser half

The extension has no build step and is loaded from `packages/extension` in the
repository, then paired with the host through the bridge token in
`$DSH_HOME/ext-bridge-token`. Signed distribution is tracked as a milestone; see
the repository for the current state.

## Links

- Source, docs, and the extension: <https://github.com/modenicheng/dsh-annotate>
- Design decisions, including why the wire keeps its `anno` vocabulary:
  [docs/DECISIONS.md](https://github.com/modenicheng/dsh-annotate/blob/main/docs/DECISIONS.md)

## License

MIT
