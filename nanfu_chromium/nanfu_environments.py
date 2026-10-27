"""Persistent, validated environment settings for Nanfu's Chromium migration."""

from __future__ import annotations

import ipaddress
import json
import os
import tempfile
import uuid
from pathlib import Path
from urllib.parse import urlsplit

PROXY_SCHEMES = {"http", "https", "socks4", "socks5"}


def validate_proxy(value: str) -> str:
    value = value.strip()
    if not value:
        return ""
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except ValueError as exc:
        raise ValueError("无效的代理地址或端口") from exc
    if (parsed.scheme.lower() not in PROXY_SCHEMES or not parsed.hostname
            or port is None or not 1 <= port <= 65535
            or parsed.username is not None or parsed.password is not None
            or parsed.path not in ("", "/") or parsed.query or parsed.fragment):
        raise ValueError("代理格式应为 http://主机:端口 或 socks5://主机:端口；不支持在地址中填写账号密码")
    return value.rstrip("/")


def new_environment(name: str, proxy: str = "") -> dict:
    name = name.strip()
    if not name or len(name) > 80:
        raise ValueError("环境名称不能为空，且不能超过 80 个字符")
    return {
        "id": uuid.uuid4().hex,
        "name": name,
        "proxy": validate_proxy(proxy),
        "proxy_mode": "fixed",
        "rotate_fingerprint_on_reload": False,
    }


def batch_create(prefix: str, count: int, proxy: str = "") -> list[dict]:
    if not isinstance(count, int) or isinstance(count, bool) or not 1 <= count <= 1000:
        raise ValueError("批量数量应为 1 到 1000")
    validate_proxy(proxy)
    return [new_environment(f"{prefix} {i}", proxy) for i in range(1, count + 1)]


def save_environments(path: Path, environments: list[dict]) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".nanfu-", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump({"version": 1, "environments": environments}, stream,
                      ensure_ascii=False, indent=2)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def load_environments(path: Path) -> list[dict]:
    path = Path(path)
    if not path.exists():
        return []
    data = json.loads(path.read_text(encoding="utf-8"))
    if data.get("version") != 1 or not isinstance(data.get("environments"), list):
        raise ValueError("环境配置格式错误")
    ids = set()
    for item in data["environments"]:
        if not isinstance(item, dict):
            raise ValueError("环境配置格式错误")
        try:
            ident = item["id"]
            uuid.UUID(hex=ident)
            if ident in ids or not isinstance(item["name"], str) or not item["name"].strip():
                raise ValueError("环境 ID 或名称无效")
            validate_proxy(item["proxy"])
            if item["proxy_mode"] != "fixed" or type(item["rotate_fingerprint_on_reload"]) is not bool:
                raise ValueError("环境配置无效")
            ids.add(ident)
        except (KeyError, TypeError, AttributeError) as exc:
            raise ValueError("环境配置格式错误") from exc
    return data["environments"]
