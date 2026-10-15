# Firefox customization project

Status: project initialized; browser implementation and installers are not yet available.

## Intended platform

Firefox / Gecko, preserving Firefox WebExtensions compatibility. Upstream source: https://github.com/mozilla-firefox/firefox . A reproducible build must pin an upstream revision and retain applicable upstream licenses. No upstream browser source has been imported yet.

## Requested behavior

- Isolate tabs using separate container identities, with explicit handling of new tabs, popups and duplicated tabs.
- Maintain a user-managed proxy pool (initial use: 5–20 entries).
- Rotate the active tab's proxy on user refresh, without changing other tabs.
- Explore per-container privacy settings and geographic configuration; IP geolocation is approximate and does not grant website geolocation permission.
- Preserve compatibility with Firefox Multi-Account Containers, Tree Style Tab and user-installed extensions; compatibility requires testing.

## Engineering constraints

Container storage isolation is not fingerprint isolation. Per-refresh, per-tab changes require browser-level investigation and must not be advertised as implemented until tested. Existing connections, workers, DNS and extension-origin traffic need explicit routing behavior. Switching a proxy entry does not prove the public exit IP changed.

Proxy support must be declared by protocol and authentication method. HTTP, HTTPS-to-proxy, SOCKS4 and SOCKS5 need separate verification. Shadowsocks, VMess, VLESS and Trojan require a separate proxy engine. Unsupported or failed proxies must fail closed rather than silently connect directly.

Do not commit real proxy credentials, API keys or personal browsing data. This repository is public.

## Delivery gates

1. Pin and obtain upstream source; validate a clean build.
2. Implement container and proxy routing with observable status.
3. Evaluate browser-level privacy changes and extension compatibility.
4. Validate routing and isolation using controlled test endpoints.
5. Produce versioned builds and clearly list verified features and limitations.
