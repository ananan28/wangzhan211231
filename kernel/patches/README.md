# kernel/patches

The Nanfu kernel series: every change we make to Chromium lives here as a diff
against the pinned upstream tag, plus a `series` file that fixes the order.

Pinned tag: **155.0.8059.85** (the version `vendor/aliasmode-chromium/build/CHROMIUM_VERSION`
names, and the version the shipped runtime is built from).

```
kernel/patches/
  series                                  order, and the only list that counts
  0001-base-nanfu-kernel-stamp.patch       \
  0002-base-nanfu-fingerprint-surface.patch > applicable today
  examples/0003-...patch.stub              labelled stub, NOT in series, will not apply
```

## What is in here right now, honestly

| Entry | Applies today? | Does anything yet? |
| --- | --- | --- |
| `0001-base-nanfu-kernel-stamp.patch` | yes, at any tag | no. Adds a header nothing includes. |
| `0002-base-nanfu-fingerprint-surface.patch` | yes, at any tag | no. Adds a header nothing includes. |
| `examples/0003-...patch.stub` | **no, on purpose** | nothing. It is a format illustration. |

Both live patches are new-file diffs. A new file has no context to match, so
`git apply` accepts them on a clean checkout at the declared tag and on any
other tag that does not already have `base/nanfu/`. That is why they are the
first two entries: the series applies end to end from day one, and
`kernel/verify-patches.sh --self-test` proves the harness works before the first
real behavioural patch exists.

They are **inert**. Nothing in the tree includes them, and no GN target compiles
them. Wiring them into `base/BUILD.gn` edits an existing file, and an edit to an
existing file can only be authored on a checkout, against real context. We do
not have one on the authoring machine, so that patch does not exist yet. A
fabricated context diff would be worse than no diff: it would look like a
kernel capability we do not have.

**No behavioural patch exists in this directory yet.** The first one will be
written on a checkout, by the procedure in `docs/kernel/patch-pipeline.md`.

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
Say what stays as in stock Chromium, and name the surface (see
base/nanfu/surface.h) when there is one.

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
} > kernel/patches/0003-blink-what-it-does.patch
rm /tmp/navigator.cc.orig
```

Line endings are part of the diff. `.gitattributes` in the reference tree marks
`*.patch` as `-text`; keep it that way, and never let an editor rewrite a patch
file. Files with CRLF in the upstream tree need CRLF in the patch.

## Checking

```bash
sh kernel/verify-patches.sh --src ~/chromium/src        # apply + promise check
sh kernel/verify-patches.sh --list                      # metadata only
sh kernel/verify-patches.sh --self-test                 # harness, no checkout needed
```

The verifier never touches the working tree unless `--in-tree` is given; by
default it accumulates the series in a throwaway git index, so it is safe to run
against a checkout someone is building in.
