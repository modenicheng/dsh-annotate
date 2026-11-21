# Changelog

## [1.0.0](https://github.com/modenicheng/dsh-annotate/compare/v0.1.4...v1.0.0) (2026-11-21)


### ⚠ BREAKING CHANGES

* **bridge:** stop accepting the bridge token in URL query strings

### Bug Fixes

* B-group audit follow-ups (scroll/IME/marquee, backoff persistence, dedup, CI hardening, tests, docs) ([472a1f0](https://github.com/modenicheng/dsh-annotate/commit/472a1f0ede3a24618c67f84cb240607f7b11f317))
* **background:** restore the retry backoff across event-page restarts ([cb17586](https://github.com/modenicheng/dsh-annotate/commit/cb175861728476be9a72f8b13be689839c1032db))
* **bridge:** stop accepting the bridge token in URL query strings ([c48a541](https://github.com/modenicheng/dsh-annotate/commit/c48a541dc75fbda623a8688182da55dfd7f79e10))
* **ci:** keep release PRs green and split fmt out of the test matrix ([4e5c9ad](https://github.com/modenicheng/dsh-annotate/commit/4e5c9ad3b2f660a212f7c0572f823a7f7ffcf777))
* **ci:** stop format-checking the bot-rewritten extension manifest ([dcf468d](https://github.com/modenicheng/dsh-annotate/commit/dcf468da0c50057e415b84f96d298552e7f777bb))
* **extension:** compensate the marquee start for mid-drag scrolling ([1a2eb73](https://github.com/modenicheng/dsh-annotate/commit/1a2eb737468cc8e3f41932156da86ad86b1468e3))
* **extension:** keep composer with its target on scroll and guard IME Enter ([4d4835a](https://github.com/modenicheng/dsh-annotate/commit/4d4835ac8c2d4d442b0ac2c9663e16d4916f5dfa))
* **extension:** keep the annotation layer out of screenshots ([cafc11b](https://github.com/modenicheng/dsh-annotate/commit/cafc11b4d4712b815ad6d4f6bf7f9a083e5ff05e))
* **extension:** keep the annotation layer out of screenshots ([eec5e83](https://github.com/modenicheng/dsh-annotate/commit/eec5e83fca43a0e474b5e6051afbdb5703611c45))
* **extension:** refresh annotations on SPA route changes ([ee928df](https://github.com/modenicheng/dsh-annotate/commit/ee928dfcc5efb041bd782ab00665c9e5156a5449))
* **extension:** refresh annotations on SPA route changes ([63536f8](https://github.com/modenicheng/dsh-annotate/commit/63536f85da7949bd69413673878a2d892cba59c0))
* **extension:** reject a remembered address stamped in the future ([d080cbc](https://github.com/modenicheng/dsh-annotate/commit/d080cbcae4e4a0dee82491423a0e7d225706f8db))
* **extension:** restore the scheduler stop contract ([e79d8bf](https://github.com/modenicheng/dsh-annotate/commit/e79d8bf287d46daeaa6635a1e6c300424d2b0f73))
* **hooks:** pass biome the include roots so the check works in worktrees ([a9ca7d8](https://github.com/modenicheng/dsh-annotate/commit/a9ca7d888cb61a534e2bfd7da2ff2892cac95664))
* **plugin:** keep serialized saves writing after a failure ([352fe95](https://github.com/modenicheng/dsh-annotate/commit/352fe959a2985daacbe969c6d26ef9a70235ab08))
* **plugin:** refuse unknown mutate actions at the switch default ([e209aaa](https://github.com/modenicheng/dsh-annotate/commit/e209aaaba12f7c520c8bd9685fcc3ebf967e56be))
* **plugin:** scan the full store in annotate_clear, not the 200-row list window ([338b21a](https://github.com/modenicheng/dsh-annotate/commit/338b21aad1f100742cd64ae4dca1cdad66ea3a25))
* **plugin:** scan the full store in annotate_clear, not the 200-row list window ([bd99f4f](https://github.com/modenicheng/dsh-annotate/commit/bd99f4f394f2f9f83165efcc4842147b19b1fa5e))
* **scripts:** keep .tmp- scratch out of the syntax gate ([933a3ef](https://github.com/modenicheng/dsh-annotate/commit/933a3efdb6c255aa175a7a82f4c47acd15f1bcd8))
* **store:** put amo-metadata.json in the AMO v5 wire format ([cc6a9bd](https://github.com/modenicheng/dsh-annotate/commit/cc6a9bd4b0da36ad239afd30d81eafe934dbf9ff))


### Documentation

* align private package versions and state the Chromium QA reality ([3d592b6](https://github.com/modenicheng/dsh-annotate/commit/3d592b682dbc81311998fb0855fef972042115b3))
* describe the dev integration branch and main-only-release model ([c01bf4c](https://github.com/modenicheng/dsh-annotate/commit/c01bf4c34203024218fdb3f45a863eb8d43b0a14))
* **distribution:** describe the parallel lanes and the v5 metadata ([2520437](https://github.com/modenicheng/dsh-annotate/commit/2520437400c2dcba26b3e4d94599363044d34e0a))
* **distribution:** describe the release-please release path ([7de13be](https://github.com/modenicheng/dsh-annotate/commit/7de13be71f319a9ef78183478117a42368c2930a))
* **distribution:** document the community catalog listing ([#14](https://github.com/modenicheng/dsh-annotate/issues/14)) ([fd348fb](https://github.com/modenicheng/dsh-annotate/commit/fd348fb73cd8ba02c8c8adec1fe5e3ce04ffe9c9))
* document annotate_delete and correct toolchain facts ([0acdf86](https://github.com/modenicheng/dsh-annotate/commit/0acdf86dbb3ca22c213e0bf559d7e84e203798d9))
* reorder READMEs for users and add release-based manual install ([9a2ec16](https://github.com/modenicheng/dsh-annotate/commit/9a2ec160a90ad5f8bf3e4916d5cd14711d6fa392))
* rewrite AGENTS.md for the protected main ([3bc3c23](https://github.com/modenicheng/dsh-annotate/commit/3bc3c230a235c60be36222a0f1a0801e41bb729b))
* **store:** add the Edge privacy paste sheet ([be24395](https://github.com/modenicheng/dsh-annotate/commit/be243954b8c8df47685a7dcb767b14c43d4b563a))
* **store:** unwrap listing fields to single lines ([#16](https://github.com/modenicheng/dsh-annotate/issues/16)) ([e62914e](https://github.com/modenicheng/dsh-annotate/commit/e62914edd1645a81ea74ca122c3789a0808297fd))
* user-first READMEs with release-based manual install; fix pre-commit in worktrees ([21797e9](https://github.com/modenicheng/dsh-annotate/commit/21797e9bd85cbd13082ed48ff6345decbf2b844f))


### CI

* **dev:** add sync-dev workflow to fast-forward main back into dev ([1370e09](https://github.com/modenicheng/dsh-annotate/commit/1370e09a56cdfa3d9dc77cc6e74e6a179bf8f15c))
* **dev:** dev integration branch and sync-dev workflow ([3297cbc](https://github.com/modenicheng/dsh-annotate/commit/3297cbc0a834c5b51c627c695ae64dee22f072b2))
* **dev:** skip sync when main is already contained in dev ([b62986e](https://github.com/modenicheng/dsh-annotate/commit/b62986e5f93aa48c2799a2c2311f630c81b850e8))
* pin third-party actions to commit SHAs ([2901479](https://github.com/modenicheng/dsh-annotate/commit/2901479d21becc1a24949e5e23a041d28e537905))
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
* **extension:** cover the anchor and hydrator core ([f920d98](https://github.com/modenicheng/dsh-annotate/commit/f920d981d0d37ef74e133af3e6b3d071d8250586))
* **extension:** cover the anchor and hydrator core ([c5d10eb](https://github.com/modenicheng/dsh-annotate/commit/c5d10eb67228e81597d8e9ab48be3a34eba4b16f))
* **extension:** drop an unused parameter in the composer harness ([283fa3a](https://github.com/modenicheng/dsh-annotate/commit/283fa3aaf89eacf451a2497a8a61ebea7260c539))
* **extension:** drop dead code (ui.badgeLabel, offscreen strings, scheduler.stop) ([1cdd729](https://github.com/modenicheng/dsh-annotate/commit/1cdd7298c2f2df627b67c1f5d673c173f652eb0d))
* **extension:** drop two more unused destructures in the composer harness ([ac0b8c1](https://github.com/modenicheng/dsh-annotate/commit/ac0b8c12a9cff78f5ff9de0f53e6bbf9b0edaa7f))
* **extension:** generate the content-script list in one shared place ([c655721](https://github.com/modenicheng/dsh-annotate/commit/c655721d1cbd81f34be6af5b815b019c75dc0a85))
* **extension:** pin the outbox queue invariants ([6074632](https://github.com/modenicheng/dsh-annotate/commit/607463287dcc97d498d995adf3adc9c1fa787c1c))
* **extension:** remove the payload fallback and a dead read ([61d9690](https://github.com/modenicheng/dsh-annotate/commit/61d9690ddd5ced7ca395793295f6f948918bf2d5))
* **extension:** share clampOffset and the whitespace normalizer ([7c1174f](https://github.com/modenicheng/dsh-annotate/commit/7c1174f339289298a2538b8a897b37443cef541b))
* **extension:** silence two unused bindings in the outbox harness ([e11d909](https://github.com/modenicheng/dsh-annotate/commit/e11d909d492d25d04d3c64571eda883db34341c3))
* fold main into a4-token-header (DETAIL endpoint list) ([d12bc07](https://github.com/modenicheng/dsh-annotate/commit/d12bc0786770c2893a947c600b0db9eb2198972c))
* fold main into b-followups before landing ([13bdd3b](https://github.com/modenicheng/dsh-annotate/commit/13bdd3b9a678bd298379fec646cc7cabe9c134e9))
* **scripts:** check the client mention regex against the protocol parser ([5484fc7](https://github.com/modenicheng/dsh-annotate/commit/5484fc70dcf3075e001d6731137673efb0da9f37))
