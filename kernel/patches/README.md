# kernel/patches

The Nanfu kernel series: every change we make to Chromium lives here as a diff
against the pinned upstream tag, plus a `series` file that fixes the order.

Pinned tag: **155.0.8059.85** (`kernel/pinned.json`; the version the shipped
runtime is built from).

```
kernel/patches/
  series                                       order, and the only list that counts
  0001-add-webgl-vendor-renderer-switches.patch \
  0002-add-client-rects-jitter-seed.patch       > in series, apply to existing files
  0003-tls-enable-server-handshake-padding.patch /
  examples/0001-base-nanfu-kernel-stamp.patch    inert header, not in series
  examples/0002-base-nanfu-fingerprint-surface.patch
  examples/0003-example-context-patch.patch.stub format illustration, not a patch
```

`series` and `kernel/pinned.json` name the same three entries in the same
order. `pinned.json` is authoritative: if the two disagree, the series is wrong.

## What is in here right now, honestly

| Entry | Applies to the pinned tag? | Compiled and measured? |
| --- | --- | --- |
| `0001-add-webgl-vendor-renderer-switches.patch` | yes (CI, apply + reverse) | **no** |
| `0002-add-client-rects-jitter-seed.patch` | yes (CI, apply + reverse) | **no** |
| `0003-tls-enable-server-handshake-padding.patch` | yes (CI, apply + reverse) | **no** |
| `examples/0001-base-nanfu-kernel-stamp.patch` | yes, but adds a header nothing includes | no |
| `examples/0002-base-nanfu-fingerprint-surface.patch` | yes, but adds a header nothing includes | no |
| `examples/0003-example-context-patch.patch.stub` | **no, on purpose** | nothing |

CI proves the three series entries apply to, and reverse from, the real upstream
files at the pinned tag. It does not build Chromium. No row here has a runtime
measurement; `docs/kernel/patch-inventory.md` says so too.

### Why the two `examples/0001`/`0002` headers are not in the series

They came from a parallel branch and are kept byte for byte, as examples. They
create new files (`base/nanfu/*.h`) that nothing includes, so they do nothing.
They are not in the series for two concrete reasons:

- their numbers collide with the two behavioural patches that are in the series;
- the verification workflow fetches only files that already exist at the pinned
  tag, so a patch that creates a file cannot be checked by it (the fetch of a
  non-existent path fails before `git apply` ever runs).

Once one of them is wired into `base/BUILD.gn` it becomes a real candidate for
the series, under a free number, and needs a second mechanism for the workflow
to obtain the new file.

## Adding a patch

1. Start from a checkout at the pinned tag with the series applied
   (`vendor/aliasmode-chromium/scripts/apply-patches.sh` is the reference
   implementation of that step).
2. Edit the file, and keep a copy of the original.
3. Produce the diff **as bytes**, never through a text-mode tool:
   `git -C src diff --no-index -- /dev/null path` for a new file,
   `diff -u --label a/PATH --label b/PATH orig new` for an edited one.
4. Assemble the patch in the format below and add it to `series` after every
   entry it depends on.
5. Run `kernel/verify-patches.sh --src <checkout>` and get a PASS that names
   every entry.

## Format

```
Subject: [PATCH] area: what it does in one line

What a page sees after this, in plain sentences, wrapped near 72 columns.
Say what stays as in stock Chromium, and name the probe key
(docs/fingerprint-probe.html) when there is one.

Nanfu-Patch-Applies-To: 155.0.8059.85
Nanfu-Patch-Promise: path/inside/src.cc::the exact string this patch adds
Nanfu-Patch-Repo: third_party/angle          # optional, default "."

diff --git a/path/inside/src.cc b/path/inside/src.cc
...
```

- `Nanfu-Patch-Applies-To` — comma-separated shell globs of Chromium versions
  this patch is valid on (`155.0.8059.85`, or `155.0.8059.*` for a patch that
  survives a patch-level bump). Required. The verifier refuses a patch whose
  declaration does not match the checkout's `chrome/VERSION`.
- `Nanfu-Patch-Promise` — `path::text`, at least one. After applying, the file
  at `path` must contain `text` verbatim. This is what stops a patch that
  "applied" from being counted as a patch that did something. Pick a string
  only this patch introduces.
- `Nanfu-Patch-Repo` — the repository the patch applies to, relative to the
  checkout root. Chromium nests real git repositories (`v8`,
  `third_party/angle`, `third_party/dawn`, `third_party/ffmpeg`,
  `third_party/swiftshader`, `third_party/webrtc`); a patch touching one of
  them declares it here and is verified in that repository's own index.
- Numbers are never reused. A dropped patch leaves a permanent gap.

## Regenerating a patch from a working tree

```bash
src=~/chromium/src
f=third_party/blink/renderer/core/frame/navigator.cc
cp "$src/$f" /tmp/navigator.cc.orig
# ... edit "$src/$f" ...
{
  printf 'Subject: [PATCH] blink: what it does\n\n'
  printf 'What changes, in the terms a page sees.\n\n'
  printf 'Nanfu-Patch-Applies-To: 155.0.8059.85\n'
  printf 'Nanfu-Patch-Promise: %s::a string only this patch adds\n\n' "$f"
  diff -u --label "a/$f" --label "b/$f" /tmp/navigator.cc.orig "$src/$f"
} > kernel/patches/0004-blink-what-it-does.patch
rm /tmp/navigator.cc.orig
```

Line endings are part of the diff. `.gitattributes` in the reference tree marks
`*.patch` as `-text`; keep it that way, and never let an editor rewrite a patch
file. Files with CRLF in the upstream tree need CRLF in the patch.

## Checking

```bash
sh kernel/verify-patches.sh --src ~/chromium/src        # apply + promise check
sh kernel/verify-patches.sh --list                      # metadata only
sh kernel/verify-patches.sh --in-tree --src ~/chromium/src   # leave the tree patched
```

`kernel/apply-patches.sh` is a three-line shim to the same verifier, kept only
because `.github/workflows/kernel-patches.yml` calls that path. Do not use it.

The verifier never touches the working tree unless `--in-tree` is given; by
default it accumulates the series in a throwaway git index, so it is safe to run
against a checkout someone is building in. `--self-test` builds a throwaway
fixture and runs the series against it; it only passes for a series of
new-file patches, so it does not apply to the current three entries.
