# Kernel patch pipeline

How a change to the browser gets from "a page can see X" to "a signed Windows
build with X fixed". This is the process we are adopting for our own kernel
patches; the reference implementation of the first half of it is the vendored
series in `vendor/aliasmode-chromium/`, which we can read, copy and re-verify.

## The one rule that shapes everything else

A full Chromium checkout is roughly 100 GB (source, `third_party` dependencies,
build output), and one link is hours, not minutes. Therefore:

- **We never track a branch.** Every patch is written against a pinned tag, and
  the tag changes only as a deliberate event: bump, re-apply the whole series,
  measure, ship.
- **We never re-fetch to test a patch.** A 10-line change is reviewed by
  compiling the translation units it touches (minutes), not by building the
  browser.
- **The series is the product.** The source tree is disposable and reproducible:
  tag + series = build. Anything that is not in the series does not exist.

Current pin: **155.0.8059.85** (`kernel/pinned.json`; `pinned.json` is the
authoritative list of the series). The runtime we ship today is upstream's
prebuilt binary for that tag (`vendor/aliasmode/aliasmode-chromium.ts`, pinned by
archive and executable SHA-256). Our own series has three entries against
existing upstream files (WebGL vendor/renderer strings, seeded client-rects
jitter, TLS server padding); CI proves they apply and reverse, **none has been
compiled or measured**. That is the gap the rest of this process closes.

## Layout

```
kernel/
  verify-patches.sh          the only entry: applies the series and checks its promises
  apply-patches.sh           three-line shim to it, kept for the frozen CI workflow
  pinned.json                pinned tag/commit and the authoritative series order
  patches/
    series                   ordered list, kept identical to pinned.json
    0001-....patch           one change, one file, one number
    README.md                format, lifecycle, and what is in examples/
    examples/                illustrations and inert headers, never applied
docs/kernel/
  patch-pipeline.md          this file
  patch-inventory.md         what exists today, verified vs claimed
```

Both live in our repo, not in the Chromium checkout. The checkout stays pristine
apart from what `git apply` puts there, so a rebuild is `git checkout -- .` plus
the series.

## Naming

`NNNN-area-topic.patch`

- `NNNN` is four digits, ascending, unique forever. **A dropped patch leaves a
  gap.** Never renumber to fill it: numbers appear in changelogs, bug reports and
  build logs, and reuse makes two different changes answer to the same name.
- `area` is the Chromium component or the surface, one word: `blink`, `net`,
  `display`, `quota`, `font`, `webrtc`, `speech`, `compose`.
- `topic` is what it does, hyphens, no filler: `screen-geometry-from-profile`,
  not `fix-screen-bug`.

Real examples from the reference series: `0010-display-screen-geometry-from-profile.patch`,
`0074-webrtc-spoof-ice-candidate-ip.patch`, `0120-opt-in-profile-seeded-readback-noise.patch`.

## The series file

`kernel/patches/series` is a list, one file name per line. Blank lines and
lines starting with `#` are ignored. Entries apply top to bottom and a patch
sees the tree as the entries above it left it.

Rules:

1. Every `patches/NNNN-*.patch` is listed exactly once; every listed file exists.
2. A patch that edits or deletes a file comes after the patch that creates it.
3. No two patches create the same file.
4. Entries ascend by number, except inside a dependency group that a `#` comment
   introduces, where the group is contiguous with the comment.
5. `examples/` and anything ending in `.stub` is never listed.

## Where a patch sits in the source tree

A patch is applied with `git apply` from the checkout root, so its paths are
relative to `src/`. The areas we are likely to touch, and the file that decides
whether the change is reachable at all:

| Surface | Typical paths | Wiring |
| --- | --- | --- |
| UA, UA-CH, `navigator.platform` | `third_party/blink/renderer/core/frame/`, `components/embedder_support/` | `//components/embedder_support` |
| Canvas / text / audio readback | `third_party/blink/renderer/platform/graphics/`, `.../modules/webaudio/` | `//third_party/blink/renderer/platform` |
| WebGL / WebGPU | `third_party/blink/renderer/modules/webgl/`, `third_party/dawn/`, `gpu/command_buffer/` | nested repos: `third_party/dawn` |
| Screen, DPR, colour | `ui/display/`, `content/browser/renderer_host/` | `//ui/display` |
| Fonts | `third_party/blink/renderer/platform/fonts/`, `ui/gfx/` | `//third_party/blink/renderer/platform` |
| Timezone, locale, calendars | `base/i18n/`, `third_party/icu/` | `//base` |
| Storage quota | `storage/browser/quota/` | `//storage/browser` |
| WebRTC candidates | `third_party/webrtc/`, `content/browser/renderer_host/` | nested repo: `third_party/webrtc` |
| Automation tells | `content/child/runtime_features.cc`, `content/browser/devtools/` | `//content` |
| Branding, product strings | `chrome/app/`, `components/version_info/` | `//chrome` |

Adding a `.cc` is not enough: a new file that no GN target lists never compiles,
so a patch that adds source also edits the `BUILD.gn` that should own it, and
that GN edit is a separate entry in the series (see the checklist).

`ninja -t query` and `compile_commands.json` answer "which targets build this
file" without guessing; `vendor/aliasmode-chromium/scripts/checkfile.sh` is a
working example of doing exactly that.

## Declaring which upstream versions a patch applies to

Every patch carries, in its header:

```
Nanfu-Patch-Applies-To: 155.0.8059.85
```

- Exact version: the patch is valid on that tag only. This is the default and
  the honest answer for anything that touches existing context.
- Glob (`155.0.8059.*`): the patch survived a patch-level bump unchanged. Only
  claim this after actually re-verifying on the new tag.
- Comma-separated list: a patch deliberately valid on two tags, e.g. during a
  migration window.

`kernel/verify-patches.sh` reads `chrome/VERSION` from the checkout and refuses
any entry whose declaration does not match. A tag bump therefore fails loudly on
the first incompatible patch instead of producing a plausible-looking build.

Each patch also declares what it promises:

```
Nanfu-Patch-Promise: base/nanfu/kernel_stamp.h::nanfu-kernel-series:1;upstream=155.0.8059.85
```

`path::text`, at least one per patch. After the patch applies, the file at `path`
must contain `text` verbatim. This is the difference between "the hunks landed"
and "the change is in the tree": `git apply` will happily apply a patch whose
hunk header undercounts its body and silently drop the tail, so the promise is
re-checked against the post-patch file, not trusted.

Optional: `Nanfu-Patch-Repo: third_party/dawn`. Chromium nests real git
repositories; a patch inside one applies and is verified in that repository.

## From idea to shipped build

0. **Decide it is a kernel change.** If an existing switch does it, or our
   manager can do it, it is not a patch. Check `docs/kernel/patch-inventory.md`
   and the upstream switch table first.
1. **Pin.** Check out the tag in a build container (not on a workstation):
   `depot_tools`, `fetch --nohooks chromium`, `gclient sync --revision <tag>`,
   then `gclient runhooks`. Record the `DEPOT_TOOLS_REVISION` and the tag.
2. **Apply the series.** `kernel/verify-patches.sh --src src --in-tree` on a
   clean tree. A red series stops here. (`kernel/apply-patches.sh` is a shim to
   the same verifier, kept only because the CI workflow calls that path.)
3. **Measure first.** Run `docs/fingerprint-probe.html` against the unpatched
   build of that tag and store the JSON. A patch with no "before" is a patch
   nobody can prove changed anything.
4. **Write the patch** on the checkout (procedure below), compile just the files
   it touches, add it to `series` after its dependencies.
5. **Verify.** `kernel/verify-patches.sh --src src` must pass, from a clean tree,
   with the entry named in the output.
6. **Measure after.** Same probe page, same seed, same host. Diff the two JSON
   documents: the keys that changed must be the keys the patch promised, and no
   others. An unexpected key change is a regression, not a bonus.
7. **Review.** The checklist below, on the patch file, not on a verbal
   description.
8. **Build.** Full build in CI on the pinned tag with the series applied, per
   target. Hours, so it is a scheduled job, not a per-commit one.
9. **Prove the binary carries it.** `strings -a chrome | grep <promise string>`
   on the produced binary, plus the probe JSON attached to the release record.
10. **Ship** with the series revision in the build metadata — once the stamp
    header from `kernel/patches/examples/0001-base-nanfu-kernel-stamp.patch` is
    wired into a compiled target (`base::nanfu::kSeriesRevision`) — so a binary
    names the exact series it came from.

### Write a patch on a checkout

```bash
src=~/chromium/src
f=third_party/blink/renderer/core/frame/navigator_base.cc
cp "$src/$f" /tmp/orig.cc
# edit "$src/$f"
{
  printf 'Subject: [PATCH] blink: hardware concurrency from the profile\n\n'
  printf 'navigator.hardwareConcurrency and the WorkerNavigator value come from\n'
  printf 'the composed profile; the host value stays when the profile has none.\n\n'
  printf 'Nanfu-Patch-Applies-To: 155.0.8059.85\n'
  printf 'Nanfu-Patch-Promise: %s::NanfuProfileHardwareConcurrency\n\n' "$f"
  diff -u --label "a/$f" --label "b/$f" /tmp/orig.cc "$src/$f"
} > kernel/patches/0003-blink-hardware-concurrency-from-profile.patch
```

`diff -u` writes correct hunk headers because it counted the lines itself. A
hand-edited hunk header is the single most common way a patch "applies" while
dropping half its body; the promise check catches it, but do not rely on that.

New files: `git -C "$src" diff --no-index -- /dev/null path/to/new.cc`.
Never run a patch through a text-mode converter: CRLF and trailing whitespace
are part of the diff.

## Review checklist

Reject the patch unless every line has an answer.

- [ ] **Number and name.** Next free number, `area-topic`, listed once in `series`, after its dependencies.
- [ ] **One change.** The patch does one thing. A behaviour change plus a rename plus a formatting fix is three patches.
- [ ] **Declared versions.** `Nanfu-Patch-Applies-To` is true; it was not widened to make CI pass.
- [ ] **Promises.** At least one `Nanfu-Patch-Promise` naming a string only this patch introduces, in a file the patch actually writes.
- [ ] **Surface named.** The description says which probe key (`docs/fingerprint-probe.html`) a page sees change, and what stays as stock.
- [ ] **Context only.** No hunk touches lines it does not need; no whitespace-only reflow; no reformatting of the surrounding file.
- [ ] **Build wiring.** If the patch adds a source file, the GN edit that compiles it is present, or the patch says explicitly that the file is inert.
- [ ] **Thread and process model.** The value is set where the page reads it *and* where workers, out-of-process iframes, the GPU process and the network service read it. A renderer does not inherit the browser command line; check whether the value has to be forwarded.
- [ ] **Header/JS agreement.** Anything exposed both as a header (Sec-CH-*) and as JavaScript is computed from one source, so they cannot disagree.
- [ ] **Falsifiability.** The description says how a page could disprove the claim, and the patch clamps to what the host can actually deliver where that applies.
- [ ] **No page-readable residue.** No new global, no string on `window`, no extra property on a prototype, no measurable timing change on a path a page can time.
- [ ] **No secrets, no user data, no absolute paths** from the authoring machine; synthetic fixtures only.
- [ ] **Line endings preserved**; no `core.autocrlf` damage.
- [ ] **Verified on a clean tree**, `verify-patches.sh` PASS naming this entry, and the probe diff shows only the promised keys.

## Dropping a patch when upstream absorbs it

Upstream will eventually implement some of this. The procedure is deliberate,
because the failure mode is a patch that silently does nothing.

1. **Find the upstream change.** The commit that implements it, and the first
   tag that contains it. Evidence, not a hunch.
2. **Diff the behaviour, not the code.** Apply the candidate tag without our
   patch and run the probe page. If the promised key already has the intended
   value, the patch is absorbed. If it is only partly absorbed, the patch
   becomes a *delta* patch against the new behaviour, with a new description —
   same number, because it is still the same intent.
3. **Delete the file** and its line in `series`. Do not renumber anything else.
4. **Move the promise into a regression check.** The promise string no longer
   exists in our tree; the equivalent assertion moves to the probe page's
   expected-value file or to a build-time smoke check, so the capability stays
   guarded after the patch is gone.
5. **Bump the series revision** (the stamp header in
   `kernel/patches/examples/0001-base-nanfu-kernel-stamp.patch`, once it is
   wired in) and note in the patch's changelog entry: which tag absorbed it,
   which commit, what the probe read before and after.
6. **Re-run the whole series** against the new tag. A removal changes line
   context for every later patch that touches the same file, so expect the
   neighbours to need regeneration — that is normal, and it is why removal is a
   separate change from the tag bump that caused it.

The same procedure applies when we drop a patch because it stopped being
worth its maintenance cost, except step 4 becomes "record why the capability is
gone" so nobody re-adds it by accident.

## Cost model, so the process stays honest

| Step | Time | Where |
| --- | --- | --- |
| `gclient sync` at a tag | 40-90 min, ~100 GB | build container, cached volume |
| Compile the files one patch touches | 2-15 min | build container |
| Full `chrome` build | 3-6 h (16-core, no GPU) | CI runner, not a workstation |
| Probe + diff | 2 min | any machine with the binary |

If a proposed process step cannot fit that table, it is the wrong process.
