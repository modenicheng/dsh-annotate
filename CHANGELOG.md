# Changelog

## [1.0.1](https://github.com/modenicheng/dsh-annotate/compare/v1.0.0...v1.0.1) (2026-11-22)


### Bug Fixes

* **release:** check out the run ref before the npm lane's local action ([9b20a43](https://github.com/modenicheng/dsh-annotate/commit/9b20a435b8d680f0787d52b0774aef6287d5ba78))
* **release:** check out the run ref before the npm lane's local action ([626ed43](https://github.com/modenicheng/dsh-annotate/commit/626ed433e0b06b9d5cf95031908bdaa4a379e73c))
* **release:** each publish lane verifies itself ([d1f471b](https://github.com/modenicheng/dsh-annotate/commit/d1f471b6fc5552a38e1aa7fc2e82b8a499901269))
* **release:** each publish lane verifies itself ([49a5812](https://github.com/modenicheng/dsh-annotate/commit/49a58127c86a1cd53261395a87640b1f676b79fc))
* **release:** read the Edge publish opt-in through the channels job ([37d7f2c](https://github.com/modenicheng/dsh-annotate/commit/37d7f2ca6e438038833fe10b1e405d835cc1220b))
* **release:** read the Edge publish opt-in through the channels job ([4d44814](https://github.com/modenicheng/dsh-annotate/commit/4d44814bfa7799649ff2a72a6a1e30641411ac6a))
* **release:** split the asset pattern list before handing it to gh ([45048c9](https://github.com/modenicheng/dsh-annotate/commit/45048c9ffad73e2f8c2cf49e757a36c0059fae20))
* **release:** split the asset pattern list before handing it to gh ([ec6f375](https://github.com/modenicheng/dsh-annotate/commit/ec6f3756dc82b68e82d1218b526df0b98ae883aa))
* **release:** treat AMO's approval timeout as an accepted submission ([95859ec](https://github.com/modenicheng/dsh-annotate/commit/95859ec035885a368586793380a42a8db5f94c0e))
* **release:** treat AMO's approval timeout as an accepted submission ([c8a340f](https://github.com/modenicheng/dsh-annotate/commit/c8a340f6b86e640be1db5e4feafd47105ccc56e4))
* **release:** verify inline and refresh the AMO lane actions from the run ref ([ce1365f](https://github.com/modenicheng/dsh-annotate/commit/ce1365f5c6c875053496ebdaba4e920a2110ffc7))
* **release:** verify inline and refresh the AMO lane actions from the run ref ([ff26995](https://github.com/modenicheng/dsh-annotate/commit/ff26995d51a4909a36d77af0e3a6a6cd4fcec4b1))


### Documentation

* post-1.0.0 documentation batch ([2258adb](https://github.com/modenicheng/dsh-annotate/commit/2258adb6a304a5a5f51a87690129d0d481f091e6))
* post-1.0.0 documentation batch ([#44](https://github.com/modenicheng/dsh-annotate/issues/44)) ([4a00cff](https://github.com/modenicheng/dsh-annotate/commit/4a00cff669325ea97574c1254a1eb2a78cfd12f1))


### CI

* **release:** gate the draft build on an explicit input, not event_name ([bc686a3](https://github.com/modenicheng/dsh-annotate/commit/bc686a3fa7247b97d419774b18849f1ff0543238))
* **release:** gate the draft build on an explicit input, not event_name ([d4cddd5](https://github.com/modenicheng/dsh-annotate/commit/d4cddd5f1d3e72662a5d203902ba520649f6949d))


### Internal

* merge dev into main with the AMO approval-timeout fix ([82b934f](https://github.com/modenicheng/dsh-annotate/commit/82b934f2138928bb9e089d23d372dd6c0fe91e18))
* merge dev into main with the draft-build gate fix ([1fa3d61](https://github.com/modenicheng/dsh-annotate/commit/1fa3d61141438334573ad817b54374eb0471568f))
* merge dev into main with the Edge publish-gate fix ([e7423ce](https://github.com/modenicheng/dsh-annotate/commit/e7423ce71f6e59fafdad4692a9aece8350c4b411))
* merge dev into main with the npm-lane checkout fix ([2b45a78](https://github.com/modenicheng/dsh-annotate/commit/2b45a780272f21f564391d86fc9a7a0b0e59eb1b))
* merge dev into main with the release verification fixes ([f2ef784](https://github.com/modenicheng/dsh-annotate/commit/f2ef78486171c3a53e44b0e23582ac7eefc127fc))

## [1.0.0](https://github.com/modenicheng/dsh-annotate/compare/v0.1.4...v1.0.0) (2026-11-21)

First public release. Beyond the commit log:

- **Breaking — bridge token:** the `/ext/anno/sessions` and `/ext/anno/session-create` routes accept the bridge token only via `Authorization: Bearer` or the `x-anno-token` header, never in the URL query string (tokens in URLs leak into host and reverse-proxy access logs). Update the extension and the plugin together.
- **Protocol:** hello now negotiates a version window (`MIN_PROTOCOL_VERSION..PROTOCOL_VERSION`) instead of one exact version. Both bounds are 1 in this release, so the wire format is unchanged; the window exists so the next wire change does not disconnect every installed extension at once.
- **DSH requirement:** the plugin needs DeepSeek Harness ≥ 0.2.0 (`engines.dsh` floor).
- **Stores:** submitted to Firefox (AMO) and the Chrome Web Store at launch; the Edge Add-ons listing follows later — Edge browsers can also install the Chrome Web Store build.


### ⚠ BREAKING CHANGES

* **bridge:** stop accepting the bridge token in URL query strings

### Features

* **extension:** add right-click and post-send exit gestures ([e22ab8f](https://github.com/modenicheng/dsh-annotate/commit/e22ab8f8950071302bbdab22cef4021454be7578))
* **extension:** annotate the current page from the popup ([4935172](https://github.com/modenicheng/dsh-annotate/commit/4935172ce60ccfe8237c4a68f5c1047691df3965))
* **extension:** make the annotate shortcut configurable ([11fba1a](https://github.com/modenicheng/dsh-annotate/commit/11fba1ab3c79dd43f754f12da83b6eda8c863e27))
* **extension:** record the activation path in a diagnostics panel ([1f85f32](https://github.com/modenicheng/dsh-annotate/commit/1f85f329639819021431e9a00a86990709f61f59))
* **extension:** rewrite the popup for users and rework the annotate block ([3126f6a](https://github.com/modenicheng/dsh-annotate/commit/3126f6a52a050c0c48e9e8c72a98328eecbc6a83))
* **extension:** translate the popup into the browser language ([6e97a3d](https://github.com/modenicheng/dsh-annotate/commit/6e97a3d24248224ad03c7c9b9d0e1520f43af846))
* **extension:** widen or narrow the element pick with Tab ([9616457](https://github.com/modenicheng/dsh-annotate/commit/961645777815466938605202e1b501e0e5701d88))
* **protocol:** negotiate a version window instead of one exact protocol ([a293b61](https://github.com/modenicheng/dsh-annotate/commit/a293b611ce18a07f521f60516eee2b75ce6f9473))


### Bug Fixes

* B-group audit follow-ups (scroll/IME/marquee, backoff persistence, dedup, CI hardening, tests, docs) ([472a1f0](https://github.com/modenicheng/dsh-annotate/commit/472a1f0ede3a24618c67f84cb240607f7b11f317))
* **background:** only reconnect the bridge when connection prefs change ([814d03e](https://github.com/modenicheng/dsh-annotate/commit/814d03e2c10aeba9526f3f5f7e2db0c28b236355))
* **background:** restore the retry backoff across event-page restarts ([cb17586](https://github.com/modenicheng/dsh-annotate/commit/cb175861728476be9a72f8b13be689839c1032db))
* **bridge:** stop accepting the bridge token in URL query strings ([c48a541](https://github.com/modenicheng/dsh-annotate/commit/c48a541dc75fbda623a8688182da55dfd7f79e10))
* **ci:** keep release PRs green and split fmt out of the test matrix ([4e5c9ad](https://github.com/modenicheng/dsh-annotate/commit/4e5c9ad3b2f660a212f7c0572f823a7f7ffcf777))
* **ci:** stop format-checking the bot-rewritten extension manifest ([dcf468d](https://github.com/modenicheng/dsh-annotate/commit/dcf468da0c50057e415b84f96d298552e7f777bb))
* **extension:** anchor a cross-block selection over all of its blocks ([5b52510](https://github.com/modenicheng/dsh-annotate/commit/5b52510a95807157d62f097ff9f0991647946dea))
* **extension:** compensate the marquee start for mid-drag scrolling ([1a2eb73](https://github.com/modenicheng/dsh-annotate/commit/1a2eb737468cc8e3f41932156da86ad86b1468e3))
* **extension:** install the console hook as a MAIN-world content script ([b1b712a](https://github.com/modenicheng/dsh-annotate/commit/b1b712a5d98756875146da886923324d56b4468e))
* **extension:** keep composer with its target on scroll and guard IME Enter ([4d4835a](https://github.com/modenicheng/dsh-annotate/commit/4d4835ac8c2d4d442b0ac2c9663e16d4916f5dfa))
* **extension:** keep the annotation layer out of screenshots ([eec5e83](https://github.com/modenicheng/dsh-annotate/commit/eec5e83fca43a0e474b5e6051afbdb5703611c45))
* **extension:** one-row status bar and a collapsing feedback line ([28a3d6a](https://github.com/modenicheng/dsh-annotate/commit/28a3d6adfc103c01519ce9fa8302923e67f954a0))
* **extension:** pin the status bar to the popup's bottom edge ([0cdb3df](https://github.com/modenicheng/dsh-annotate/commit/0cdb3df95fe286b4b3dd5d4d3b49f178d73f9c59))
* **extension:** refresh annotations on SPA route changes ([63536f8](https://github.com/modenicheng/dsh-annotate/commit/63536f85da7949bd69413673878a2d892cba59c0))
* **extension:** reject a remembered address stamped in the future ([d080cbc](https://github.com/modenicheng/dsh-annotate/commit/d080cbcae4e4a0dee82491423a0e7d225706f8db))
* **extension:** replace the stale shadow host after a re-injection ([cb7dd8a](https://github.com/modenicheng/dsh-annotate/commit/cb7dd8a122a01b619a65ef032a744f9bc27f91f9))
* **extension:** restore the scheduler stop contract ([e79d8bf](https://github.com/modenicheng/dsh-annotate/commit/e79d8bf287d46daeaa6635a1e6c300424d2b0f73))
* **extension:** scope a selection's geometry to its anchor block ([5ae4eb1](https://github.com/modenicheng/dsh-annotate/commit/5ae4eb18d218e040208436607ba0a9f09f5da9c5))
* **hooks:** pass biome the include roots so the check works in worktrees ([a9ca7d8](https://github.com/modenicheng/dsh-annotate/commit/a9ca7d888cb61a534e2bfd7da2ff2892cac95664))
* **plugin:** gate the GUI routes with the host Connection fence ([#25](https://github.com/modenicheng/dsh-annotate/issues/25)) ([e4a3996](https://github.com/modenicheng/dsh-annotate/commit/e4a39960c407f5be2f57e394b44a0c3a1c36a903))
* **plugin:** keep serialized saves writing after a failure ([352fe95](https://github.com/modenicheng/dsh-annotate/commit/352fe959a2985daacbe969c6d26ef9a70235ab08))
* **plugin:** refuse unknown mutate actions at the switch default ([e209aaa](https://github.com/modenicheng/dsh-annotate/commit/e209aaaba12f7c520c8bd9685fcc3ebf967e56be))
* **plugin:** scan the full store in annotate_clear, not the 200-row list window ([bd99f4f](https://github.com/modenicheng/dsh-annotate/commit/bd99f4f394f2f9f83165efcc4842147b19b1fa5e))
* **scripts:** keep .tmp- scratch out of the syntax gate ([933a3ef](https://github.com/modenicheng/dsh-annotate/commit/933a3efdb6c255aa175a7a82f4c47acd15f1bcd8))
* **store:** put amo-metadata.json in the AMO v5 wire format ([cc6a9bd](https://github.com/modenicheng/dsh-annotate/commit/cc6a9bd4b0da36ad239afd30d81eafe934dbf9ff))


### Documentation

* add README banner images ([841d54b](https://github.com/modenicheng/dsh-annotate/commit/841d54bd7202aee9b89b634cdb86b7aeaf0a5a3f))
* align private package versions and state the Chromium QA reality ([3d592b6](https://github.com/modenicheng/dsh-annotate/commit/3d592b682dbc81311998fb0855fef972042115b3))
* describe the dev integration branch and main-only-release model ([c01bf4c](https://github.com/modenicheng/dsh-annotate/commit/c01bf4c34203024218fdb3f45a863eb8d43b0a14))
* describe the Tab hierarchy walk in the gesture docs ([1c02000](https://github.com/modenicheng/dsh-annotate/commit/1c02000048cf05e7a68af3a6764a3571b4af1e90))
* **distribution:** describe the parallel lanes and the v5 metadata ([2520437](https://github.com/modenicheng/dsh-annotate/commit/2520437400c2dcba26b3e4d94599363044d34e0a))
* **distribution:** describe the release-please release path ([7de13be](https://github.com/modenicheng/dsh-annotate/commit/7de13be71f319a9ef78183478117a42368c2930a))
* **distribution:** document the community catalog listing ([#14](https://github.com/modenicheng/dsh-annotate/issues/14)) ([fd348fb](https://github.com/modenicheng/dsh-annotate/commit/fd348fb73cd8ba02c8c8adec1fe5e3ce04ffe9c9))
* document annotate_delete and correct toolchain facts ([0acdf86](https://github.com/modenicheng/dsh-annotate/commit/0acdf86dbb3ca22c213e0bf559d7e84e203798d9))
* document the annotation controls, exits, and diagnostics ([f2e7ebd](https://github.com/modenicheng/dsh-annotate/commit/f2e7ebd3d774e19af11d0d0db7c4b668b96c2c6e))
* reorder READMEs for users and add release-based manual install ([9a2ec16](https://github.com/modenicheng/dsh-annotate/commit/9a2ec160a90ad5f8bf3e4916d5cd14711d6fa392))
* rewrite AGENTS.md for the protected main ([3bc3c23](https://github.com/modenicheng/dsh-annotate/commit/3bc3c230a235c60be36222a0f1a0801e41bb729b))
* spell out the Chromium shortcut setup in the install guides ([af4d564](https://github.com/modenicheng/dsh-annotate/commit/af4d5641a413ca745cd83e53d11b5fa0caee655c))
* **store:** add the Edge privacy paste sheet ([be24395](https://github.com/modenicheng/dsh-annotate/commit/be243954b8c8df47685a7dcb767b14c43d4b563a))
* **store:** unwrap listing fields to single lines ([#16](https://github.com/modenicheng/dsh-annotate/issues/16)) ([e62914e](https://github.com/modenicheng/dsh-annotate/commit/e62914edd1645a81ea74ca122c3789a0808297fd))
* sync the popup description with the rewrite ([f598687](https://github.com/modenicheng/dsh-annotate/commit/f5986876b15565f98306bfc2c07f5e96b347eecc))
* user-first READMEs with release-based manual install; fix pre-commit in worktrees ([21797e9](https://github.com/modenicheng/dsh-annotate/commit/21797e9bd85cbd13082ed48ff6345decbf2b844f))


### CI

* **dev:** add sync-dev workflow to fast-forward main back into dev ([1370e09](https://github.com/modenicheng/dsh-annotate/commit/1370e09a56cdfa3d9dc77cc6e74e6a179bf8f15c))
* **dev:** skip sync when main is already contained in dev ([b62986e](https://github.com/modenicheng/dsh-annotate/commit/b62986e5f93aa48c2799a2c2311f630c81b850e8))
* pin third-party actions to commit SHAs ([039532e](https://github.com/modenicheng/dsh-annotate/commit/039532e5de32a93c10eb6432d354bb55edb7f57b))
* **release:** draft the release with git-cliff conventional notes ([3bd3e07](https://github.com/modenicheng/dsh-annotate/commit/3bd3e07d6c403c012df16ceec7c040d7a6eab8fb))
* **release:** drop the hand-pushed tag path; release-please is the only way in ([94b816e](https://github.com/modenicheng/dsh-annotate/commit/94b816ea4039e18fed6c62bc403ec432242a763c))
* **release:** fix the AMO submission and split the release CD into parallel per-store lanes ([e1d3d98](https://github.com/modenicheng/dsh-annotate/commit/e1d3d98f415f70036d10911f096dd2d3b7a011a5))
* **release:** grant the caller the permissions the called workflow declares ([2dd006c](https://github.com/modenicheng/dsh-annotate/commit/2dd006c64ca96a3147b65015789b5c7a978931e0))
* **release:** let release-please own the version bump and the draft release ([fd11a97](https://github.com/modenicheng/dsh-annotate/commit/fd11a97cee9d1796e524c421752e663f44003f58))
* **release:** reconcile the parallel lanes with the release-please draft path ([4ed02d3](https://github.com/modenicheng/dsh-annotate/commit/4ed02d34c2a4fb81f6af3756453bee8ae83c9b90))
* **release:** repeat the caller grant at job level for the reusable call ([0ed3f36](https://github.com/modenicheng/dsh-annotate/commit/0ed3f36bc4fb6c04e2c2354250605ef4f5824f3c))
* **release:** split the pipeline into parallel per-store lanes ([042efdd](https://github.com/modenicheng/dsh-annotate/commit/042efdd8e35ae8739db8ca600e8ae7e13dda7d65))
* **release:** submit the released Chromium zip to Edge Add-ons ([7902c48](https://github.com/modenicheng/dsh-annotate/commit/7902c48cc856ec3adcbf9860b8ad9548b0e0f6cd))
* share the verified-asset download and tighten the release pipelines ([61760bc](https://github.com/modenicheng/dsh-annotate/commit/61760bc9e85d69201872ca8045a256ef1ea7a5c8))
* split the format check out of the node test matrix ([36ce7b1](https://github.com/modenicheng/dsh-annotate/commit/36ce7b1150269a1ea54f774c6caa020b8bc30c4d))


### Internal

* **background:** unify the address probe and carry instanceId through the scheme cache ([9c21a63](https://github.com/modenicheng/dsh-annotate/commit/9c21a6314e3c2934e7f0581b2d1f24a3d1e6310c))
* **extension:** cover the anchor and hydrator core ([c5d10eb](https://github.com/modenicheng/dsh-annotate/commit/c5d10eb67228e81597d8e9ab48be3a34eba4b16f))
* **extension:** drop an unused parameter in the composer harness ([283fa3a](https://github.com/modenicheng/dsh-annotate/commit/283fa3aaf89eacf451a2497a8a61ebea7260c539))
* **extension:** drop dead code (ui.badgeLabel, offscreen strings, scheduler.stop) ([1cdd729](https://github.com/modenicheng/dsh-annotate/commit/1cdd7298c2f2df627b67c1f5d673c173f652eb0d))
* **extension:** drop two more unused destructures in the composer harness ([ac0b8c1](https://github.com/modenicheng/dsh-annotate/commit/ac0b8c12a9cff78f5ff9de0f53e6bbf9b0edaa7f))
* **extension:** generate the content-script list in one shared place ([c655721](https://github.com/modenicheng/dsh-annotate/commit/c655721d1cbd81f34be6af5b815b019c75dc0a85))
* **extension:** pin the outbox queue invariants ([6074632](https://github.com/modenicheng/dsh-annotate/commit/607463287dcc97d498d995adf3adc9c1fa787c1c))
* **extension:** remove the diagnostics ring and its content feed ([9e7768d](https://github.com/modenicheng/dsh-annotate/commit/9e7768d468e14aaeac6994cc2c42058d67c044c5))
* **extension:** remove the payload fallback and a dead read ([61d9690](https://github.com/modenicheng/dsh-annotate/commit/61d9690ddd5ced7ca395793295f6f948918bf2d5))
* **extension:** share clampOffset and the whitespace normalizer ([7c1174f](https://github.com/modenicheng/dsh-annotate/commit/7c1174f339289298a2538b8a897b37443cef541b))
* **extension:** silence two unused bindings in the outbox harness ([e11d909](https://github.com/modenicheng/dsh-annotate/commit/e11d909d492d25d04d3c64571eda883db34341c3))
* fold main into a4-token-header (DETAIL endpoint list) ([d12bc07](https://github.com/modenicheng/dsh-annotate/commit/d12bc0786770c2893a947c600b0db9eb2198972c))
* fold main into b-followups before landing ([13bdd3b](https://github.com/modenicheng/dsh-annotate/commit/13bdd3b9a678bd298379fec646cc7cabe9c134e9))
* merge origin/dev (docs/chrome-shortcut-guide) into popup-polish ([7cae67b](https://github.com/modenicheng/dsh-annotate/commit/7cae67b1e92cb8e3965e2d296c7b7c917ad80b8f))
* **plugin:** relax engines.dsh to a floor of 0.2.0 ([f59f52e](https://github.com/modenicheng/dsh-annotate/commit/f59f52e39d9910b15bc8f1966df9ceae79ef79bb))
* **scripts:** check the client mention regex against the protocol parser ([5484fc7](https://github.com/modenicheng/dsh-annotate/commit/5484fc70dcf3075e001d6731137673efb0da9f37))
