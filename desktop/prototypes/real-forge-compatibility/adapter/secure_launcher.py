"""Bounded launcher adapter for the real-Forge compatibility smoke."""

from __future__ import annotations

import hmac
import importlib.metadata
import importlib.util
import inspect
import json
import os
import runpy
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, BinaryIO, Callable, MutableMapping
from urllib.parse import urlsplit

MAX_FRAME_BYTES = 16 * 1024
AUTH_HEADER = b"x-forge-bridge-authorization"
INTERNAL_ORIGIN = b"http://forge-desktop.internal"
EXPECTED_GRADIO_VERSION = "4.40.0"
EXPECTED_PROTOCOL_VERSION = 1


@dataclass(frozen=True)
class LaunchBootstrap:
    token: str
    instance_id: str
    expected_host: str
    launch_generation: int

    @staticmethod
    def from_stream(stream: BinaryIO) -> "LaunchBootstrap":
        line = stream.readline(MAX_FRAME_BYTES)
        if not line or len(line) >= MAX_FRAME_BYTES or not line.endswith(b"\n"):
            raise RuntimeError("bridge bootstrap frame is missing, unterminated, or oversized")
        if stream.read(1) not in (b"",):
            raise RuntimeError("bridge bootstrap transport must contain exactly one frame")
        try:
            value = json.loads(line.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise RuntimeError("bridge bootstrap frame is invalid JSON") from error
        if not isinstance(value, dict) or value.get("frameVersion") != 1:
            raise RuntimeError("bridge bootstrap frame version is unsupported")
        if value.get("protocolVersion") != EXPECTED_PROTOCOL_VERSION:
            raise RuntimeError("bridge protocol version is unsupported")
        token = value.get("token")
        instance_id = value.get("instanceId")
        expected_host = value.get("expectedHost")
        launch_generation = value.get("launchGeneration")
        if not all(isinstance(item, str) and item for item in (token, instance_id, expected_host)):
            raise RuntimeError("bridge bootstrap fields are invalid")
        if not isinstance(launch_generation, int) or launch_generation < 1:
            raise RuntimeError("bridge launch generation is invalid")
        if not expected_host.startswith("127.0.0.1:"):
            raise RuntimeError("bridge host must be explicit IPv4 loopback")
        return LaunchBootstrap(token, instance_id, expected_host, launch_generation)


def _headers(scope: MutableMapping[str, Any]) -> dict[bytes, bytes]:
    return {bytes(name).lower(): bytes(value) for name, value in scope.get("headers", [])}


class SecureForgeGuard:
    def __init__(self, app: Callable[..., Any], bootstrap: LaunchBootstrap):
        self.app = app
        self.bootstrap = bootstrap

    async def __call__(self, scope: MutableMapping[str, Any], receive: Callable[..., Any], send: Callable[..., Any]) -> None:
        if scope.get("type") not in ("http", "websocket"):
            await self.app(scope, receive, send)
            return
        headers = _headers(scope)
        status, code = self._authorize(headers)
        if status != 200:
            if scope.get("type") == "websocket":
                await send({"type": "websocket.close", "code": 4401 if status == 401 else 4403, "reason": code})
            else:
                body = json.dumps({"error": code}, separators=(",", ":")).encode()
                await send({"type": "http.response.start", "status": status, "headers": [(b"content-type", b"application/json"), (b"cache-control", b"no-store")]})
                await send({"type": "http.response.body", "body": body})
            return
        if scope.get("type") == "http" and scope.get("path") == "/bridge/identity":
            body = json.dumps({
                "service": "forge-desktop-bridge",
                "protocolVersion": EXPECTED_PROTOCOL_VERSION,
                "instanceId": self.bootstrap.instance_id,
                "launchGeneration": self.bootstrap.launch_generation,
                "capabilities": {"http": True, "websocket": True},
                "enginePid": os.getpid(),
            }, separators=(",", ":")).encode()
            await send({"type": "http.response.start", "status": 200, "headers": [(b"content-type", b"application/json"), (b"cache-control", b"no-store")]})
            await send({"type": "http.response.body", "body": body})
            return
        await self.app(scope, receive, send)

    def _authorize(self, headers: dict[bytes, bytes]) -> tuple[int, str]:
        if not hmac.compare_digest(headers.get(b"host", b""), self.bootstrap.expected_host.encode("ascii")):
            return 421, "unexpected_host"
        origin = headers.get(b"origin")
        if origin is not None and not hmac.compare_digest(origin, INTERNAL_ORIGIN):
            return 403, "unexpected_origin"
        fetch_site = headers.get(b"sec-fetch-site")
        if origin is None and fetch_site not in (None, b"same-origin", b"none"):
            return 403, "cross_site_request"
        expected = f"Bearer {self.bootstrap.token}".encode("ascii")
        if not hmac.compare_digest(headers.get(AUTH_HEADER, b""), expected):
            return 401, "unauthorized"
        return 200, "authorized"


def assert_compatibility() -> None:
    actual = importlib.metadata.version("gradio")
    if actual != EXPECTED_GRADIO_VERSION:
        raise RuntimeError(f"unsupported Gradio version: expected {EXPECTED_GRADIO_VERSION}, got {actual}")
    spec = importlib.util.find_spec("gradio.http_server")
    if spec is None or spec.origin is None:
        raise RuntimeError("Gradio HTTP server seam is unavailable")
    source = Path(spec.origin).read_text(encoding="utf-8")
    if "config = uvicorn.Config(" not in source or "server.run_in_thread()" not in source:
        raise RuntimeError("Gradio pre-bind Uvicorn seam changed")
    blocks_spec = importlib.util.find_spec("gradio.blocks")
    if blocks_spec is None or blocks_spec.origin is None:
        raise RuntimeError("Gradio Blocks startup seam is unavailable")
    blocks_source = Path(blocks_spec.origin).read_text(encoding="utf-8")
    if 'f"{self.local_url}startup-events"' not in blocks_source:
        raise RuntimeError("Gradio startup-events self-call seam changed")


def install_startup_event_credential(bootstrap: LaunchBootstrap) -> None:
    """Authenticate Gradio's exact loopback self-call without opening the route."""
    import httpx

    original_get = httpx.get

    def guarded_get(url: Any, *args: Any, **kwargs: Any) -> Any:
        if isinstance(url, str):
            parsed = urlsplit(url)
            if parsed.scheme == "http" and parsed.netloc == bootstrap.expected_host and parsed.path == "/startup-events":
                headers = dict(kwargs.pop("headers", {}) or {})
                headers[AUTH_HEADER.decode("ascii")] = f"Bearer {bootstrap.token}"
                kwargs["headers"] = headers
        return original_get(url, *args, **kwargs)

    httpx.get = guarded_get


def install_guard(bootstrap: LaunchBootstrap) -> None:
    assert_compatibility()
    install_startup_event_credential(bootstrap)
    import uvicorn

    if "app" not in inspect.signature(uvicorn.Config.__init__).parameters:
        raise RuntimeError("Uvicorn Config constructor seam changed")
    if getattr(uvicorn.Config, "_forge_desktop_real_smoke_guard", False):
        raise RuntimeError("guard was already installed")
    original_init = uvicorn.Config.__init__

    def guarded_init(self: object, app: Any, *args: Any, **kwargs: Any) -> None:
        if isinstance(app, str):
            raise RuntimeError("string ASGI applications are not accepted")
        original_init(self, SecureForgeGuard(app, bootstrap), *args, **kwargs)

    uvicorn.Config.__init__ = guarded_init
    uvicorn.Config._forge_desktop_real_smoke_guard = True


def main() -> None:
    bootstrap = LaunchBootstrap.from_stream(sys.stdin.buffer)
    install_guard(bootstrap)
    repo_root = Path(__file__).resolve().parents[4]
    os.chdir(repo_root)
    sys.path.insert(0, str(repo_root))
    runpy.run_path(str(repo_root / "launch.py"), run_name="__main__")


if __name__ == "__main__":
    main()
