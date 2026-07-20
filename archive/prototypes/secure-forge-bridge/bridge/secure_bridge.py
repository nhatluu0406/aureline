"""ASGI security boundary prototype; không phải Forge production extension."""

from __future__ import annotations

import hmac
import json
import os
from dataclasses import dataclass
from typing import Any, BinaryIO, Callable, MutableMapping

AUTH_HEADER = b"x-forge-bridge-authorization"
INTERNAL_ORIGIN = b"http://forge-desktop.internal"


@dataclass(frozen=True)
class BridgeBootstrap:
    token: str
    instance_id: str
    expected_host: str
    protocol_version: int = 1

    @staticmethod
    def from_stream(stream: BinaryIO) -> "BridgeBootstrap":
        line = stream.readline(16 * 1024)
        if not line or len(line) >= 16 * 1024:
            raise RuntimeError("bridge credential source is missing or oversized")
        try:
            value = json.loads(line.decode("utf-8"))
            token = value["token"]
            instance_id = value["instanceId"]
            expected_host = value["expectedHost"]
        except (UnicodeDecodeError, json.JSONDecodeError, KeyError, TypeError) as error:
            raise RuntimeError("bridge credential source is invalid") from error
        if not all(isinstance(item, str) and item for item in (token, instance_id, expected_host)):
            raise RuntimeError("bridge credential fields are invalid")
        if not expected_host.startswith("127.0.0.1:"):
            raise RuntimeError("bridge host must be explicit IPv4 loopback")
        return BridgeBootstrap(token=token, instance_id=instance_id, expected_host=expected_host)


def read_bootstrap_from_inherited_handle(environment_key: str = "FORGE_DESKTOP_SECRET_HANDLE") -> BridgeBootstrap:
    """Read-once inherited handle transport. The environment contains only a handle number."""
    raw_value = os.environ.pop(environment_key, None)
    if raw_value is None:
        raise RuntimeError("bridge credential handle is not configured")
    try:
        raw_handle = int(raw_value)
        if os.name == "nt":
            import msvcrt
            file_descriptor = msvcrt.open_osfhandle(raw_handle, os.O_RDONLY)
        else:
            file_descriptor = raw_handle
        with os.fdopen(file_descriptor, "rb", closefd=True) as stream:
            return BridgeBootstrap.from_stream(stream)
    except (OSError, TypeError, ValueError) as error:
        raise RuntimeError("bridge credential handle could not be read") from error


def _headers(scope: MutableMapping[str, Any]) -> dict[bytes, bytes]:
    return {bytes(name).lower(): bytes(value) for name, value in scope.get("headers", [])}


def _authorized(headers: dict[bytes, bytes], bootstrap: BridgeBootstrap) -> tuple[bool, int, str]:
    if not hmac.compare_digest(headers.get(b"host", b""), bootstrap.expected_host.encode("ascii")):
        return False, 421, "unexpected_host"
    origin = headers.get(b"origin")
    if origin is not None and not hmac.compare_digest(origin, INTERNAL_ORIGIN):
        return False, 403, "unexpected_origin"
    fetch_site = headers.get(b"sec-fetch-site")
    if origin is None and fetch_site not in (None, b"same-origin", b"none"):
        return False, 403, "cross_site_request"
    expected = f"Bearer {bootstrap.token}".encode("ascii")
    if not hmac.compare_digest(headers.get(AUTH_HEADER, b""), expected):
        return False, 401, "unauthorized"
    return True, 200, "authorized"


class SecureBridgeMiddleware:
    """Outer ASGI middleware protecting HTTP, WebSocket and late-added routes."""

    def __init__(self, app: Callable[..., Any], bootstrap: BridgeBootstrap):
        self.app = app
        self.bootstrap = bootstrap

    async def __call__(self, scope: MutableMapping[str, Any], receive: Callable[..., Any], send: Callable[..., Any]) -> None:
        if scope.get("type") not in ("http", "websocket"):
            await self.app(scope, receive, send)
            return
        allowed, status, code = _authorized(_headers(scope), self.bootstrap)
        if not allowed:
            if scope.get("type") == "websocket":
                await send({"type": "websocket.close", "code": 4401 if status == 401 else 4403, "reason": code})
            else:
                body = json.dumps({"error": code}, separators=(",", ":")).encode("utf-8")
                await send({"type": "http.response.start", "status": status, "headers": [(b"content-type", b"application/json"), (b"cache-control", b"no-store")]})
                await send({"type": "http.response.body", "body": body})
            return
        if scope.get("type") == "http" and scope.get("path") == "/bridge/identity":
            body = json.dumps({
                "service": "forge-desktop-bridge",
                "protocolVersion": self.bootstrap.protocol_version,
                "instanceId": self.bootstrap.instance_id,
                "enginePid": os.getpid(),
            }, separators=(",", ":")).encode("utf-8")
            await send({"type": "http.response.start", "status": 200, "headers": [(b"content-type", b"application/json"), (b"cache-control", b"no-store")]})
            await send({"type": "http.response.body", "body": body})
            return
        await self.app(scope, receive, send)


def install_uvicorn_config_guard(config_class: type, bootstrap: BridgeBootstrap) -> None:
    """Wrap the ASGI app at Uvicorn Config construction, before socket bind."""
    if getattr(config_class, "_forge_desktop_guard_installed", False):
        return
    original_init = config_class.__init__

    def guarded_init(self: object, app: Any, *args: Any, **kwargs: Any) -> None:
        if isinstance(app, str):
            raise RuntimeError("string ASGI app is not accepted by Forge Desktop guard")
        original_init(self, SecureBridgeMiddleware(app, bootstrap), *args, **kwargs)

    config_class.__init__ = guarded_init
    config_class._forge_desktop_guard_installed = True

