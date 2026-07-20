"""Aureline pre-bind authentication adapter for the Forge engine.

The one-shot bootstrap frame arrives on inherited stdin. The credential is never
accepted from argv, environment, URL or a file.
"""
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
INTERNAL_ORIGIN = b"http://aureline.internal"
EXPECTED_GRADIO_VERSION = "4.40.0"
PROTOCOL_VERSION = 1


@dataclass(frozen=True)
class Bootstrap:
    token: str
    instance_id: str
    expected_host: str
    launch_generation: int
    forge_root: Path

    @staticmethod
    def read(stream: BinaryIO) -> "Bootstrap":
        line = stream.readline(MAX_FRAME_BYTES)
        if not line or len(line) >= MAX_FRAME_BYTES or not line.endswith(b"\n"):
            raise RuntimeError("bootstrap frame missing, unterminated, or oversized")
        if stream.read(1) != b"":
            raise RuntimeError("bootstrap transport must contain exactly one frame")
        try:
            value = json.loads(line.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise RuntimeError("bootstrap frame is invalid JSON") from error
        if not isinstance(value, dict) or value.get("frameVersion") != 1 or value.get("protocolVersion") != PROTOCOL_VERSION:
            raise RuntimeError("unsupported bootstrap protocol")
        token, instance_id, expected_host, forge_root = (value.get(key) for key in ("token", "instanceId", "expectedHost", "forgeRoot"))
        generation = value.get("launchGeneration")
        if not all(isinstance(item, str) and item for item in (token, instance_id, expected_host, forge_root)):
            raise RuntimeError("bootstrap fields are invalid")
        if not isinstance(generation, int) or generation < 1 or not expected_host.startswith("127.0.0.1:"):
            raise RuntimeError("bootstrap generation or host is invalid")
        root = Path(forge_root).resolve()
        if not (root / "launch.py").is_file():
            raise RuntimeError("Forge root does not contain launch.py")
        return Bootstrap(token, instance_id, expected_host, generation, root)


class Guard:
    def __init__(self, app: Callable[..., Any], bootstrap: Bootstrap):
        self.app, self.bootstrap = app, bootstrap

    async def __call__(self, scope: MutableMapping[str, Any], receive: Callable[..., Any], send: Callable[..., Any]) -> None:
        if scope.get("type") not in ("http", "websocket"):
            await self.app(scope, receive, send)
            return
        headers = {bytes(name).lower(): bytes(value) for name, value in scope.get("headers", [])}
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
                "service": "aureline-engine-bridge", "protocolVersion": PROTOCOL_VERSION,
                "instanceId": self.bootstrap.instance_id, "launchGeneration": self.bootstrap.launch_generation,
                "capabilities": {"http": True, "websocket": True}, "enginePid": os.getpid(),
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
        if origin is None and headers.get(b"sec-fetch-site") not in (None, b"same-origin", b"none"):
            return 403, "cross_site_request"
        if not hmac.compare_digest(headers.get(AUTH_HEADER, b""), f"Bearer {self.bootstrap.token}".encode("ascii")):
            return 401, "unauthorized"
        return 200, "authorized"


def install(bootstrap: Bootstrap) -> None:
    if importlib.metadata.version("gradio") != EXPECTED_GRADIO_VERSION:
        raise RuntimeError(f"unsupported Gradio version; expected {EXPECTED_GRADIO_VERSION}")
    server_spec, blocks_spec = importlib.util.find_spec("gradio.http_server"), importlib.util.find_spec("gradio.blocks")
    if server_spec is None or server_spec.origin is None or blocks_spec is None or blocks_spec.origin is None:
        raise RuntimeError("Gradio integration seam unavailable")
    if "config = uvicorn.Config(" not in Path(server_spec.origin).read_text(encoding="utf-8"):
        raise RuntimeError("Gradio Uvicorn seam changed")
    if 'f"{self.local_url}startup-events"' not in Path(blocks_spec.origin).read_text(encoding="utf-8"):
        raise RuntimeError("Gradio startup-events seam changed")

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

    import uvicorn
    if "app" not in inspect.signature(uvicorn.Config.__init__).parameters or getattr(uvicorn.Config, "_forge_desktop_guard", False):
        raise RuntimeError("Uvicorn seam changed or guard already installed")
    original_init = uvicorn.Config.__init__
    def guarded_init(self: object, app: Any, *args: Any, **kwargs: Any) -> None:
        if isinstance(app, str):
            raise RuntimeError("string ASGI applications are not accepted")
        original_init(self, Guard(app, bootstrap), *args, **kwargs)
    uvicorn.Config.__init__ = guarded_init
    uvicorn.Config._forge_desktop_guard = True


def main() -> None:
    bootstrap = Bootstrap.read(sys.stdin.buffer)
    install(bootstrap)
    os.chdir(bootstrap.forge_root)
    sys.path.insert(0, str(bootstrap.forge_root))
    runpy.run_path(str(bootstrap.forge_root / "launch.py"), run_name="__main__")


if __name__ == "__main__":
    main()
