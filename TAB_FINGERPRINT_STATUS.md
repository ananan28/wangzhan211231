# Tab fingerprint implementation status

This branch contains native source modifications, not a tested release. Do not present the baseline build as the customized browser.

## Implemented in source

- Each tab stores a versioned fingerprint profile in SessionStore custom tab values. The refresh rotation checkbox defaults to false.
- The navigation toolbar exposes the per-tab rotation toggle even when Tree Style Tab hides the horizontal tab strip; Shift-click opens settings. A tab context menu also provides the checkbox and language, timezone, screen size and optional geographic-coordinate settings.
- Top-level reloads notify a parent-process DocumentLoadListener hook before document channel creation, covering UI, extension and page-script reloads; subframe reloads are excluded. A load identifier suppresses duplicate notifications. Disabling the checkbox retains the current seed.
- A new chrome-only, parent-writable BrowsingContext fingerprintSeed field feeds the native RFP HMAC used for document Canvas/WebGL randomization. The site partition key remains in the derivation. The UUID seed is persisted across session restore.
- Native BrowsingContext overrides are used for user agent, language, timezone, screen and optional position. The user agent is kept consistent with the actual Firefox platform rather than randomly inventing browser/OS combinations.
- No proxy APIs, container cookies or CAPTCHA behavior are changed.

## Validation

Six Node state tests pass locally, covering independent tabs, fixed keys, serialization, rotation, disabling rotation, duplication and invalid input. Syntax checks pass for the new JS modules. A native browser integration test is included, but has not run successfully yet. Native compilation and runtime compatibility remain unverified until CI succeeds.

## Limitations and unfinished validation

- The parent-process reload notification and its timing still require native runtime validation.
- Shared-worker matching now compares the serialized document fingerprint-randomization key as well as the original origin/container/name conditions. A native regression test checks same-document sharing and separation across tabs. This source change is not runtime-validated; if Firefox supplies no randomization key (for example through exemptions), it does not guarantee tab isolation.
- Service workers still share registration/runtime state within an origin and container. The document HMAC hook does not provide independent per-tab service-worker fingerprints.
- Canvas/WebGL perturbation is subject to Firefox fingerprinting protection preferences, exemptions and canvas permissions. GPU vendor/model spoofing and arbitrary hardware profiles are not implemented.
- Position, timezone and language do not automatically track the proxy plugin's exit IP. Set the tab's region manually. Geolocation permission is not automatically granted.
- The Multi-Account Containers, Tree Style Tab and Buster combination still needs live compatibility testing. The changes do not implement or modify CAPTCHA solving.
- Native tests must be extended for cross-site context replacement, workers, drag-to-another-window, private sessions, closed-tab restoration and fingerprint output stability.
- The current workflow creates a Linux development package only after native tests pass. Windows and macOS installers are not yet available.

## Upstream source

Mozilla Firefox release revision: 7e92a9e429dab30b7166890a7e778e3d1dd4cbeb. Upstream source and license notices are retained under firefox/.
