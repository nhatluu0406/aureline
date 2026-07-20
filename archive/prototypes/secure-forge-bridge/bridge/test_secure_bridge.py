import asyncio
import io
import json
import unittest

from bridge.secure_bridge import BridgeBootstrap, SecureBridgeMiddleware, install_uvicorn_config_guard


BOOTSTRAP = BridgeBootstrap(token="test-only-token", instance_id="instance-a", expected_host="127.0.0.1:4567")


async def invoke(scope):
    downstream = []

    async def app(_scope, _receive, send):
        await send({"type": "http.response.start", "status": 204, "headers": []})
        await send({"type": "http.response.body", "body": b""})

    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message):
        downstream.append(message)

    await SecureBridgeMiddleware(app, BOOTSTRAP)(scope, receive, send)
    return downstream


def headers(token="test-only-token", host=b"127.0.0.1:4567", origin=None):
    value = [(b"host", host), (b"x-forge-bridge-authorization", f"Bearer {token}".encode())]
    if origin is not None:
        value.append((b"origin", origin))
    return value


class SecureBridgeTests(unittest.TestCase):
    def test_bootstrap_stream_fails_closed(self):
        with self.assertRaises(RuntimeError):
            BridgeBootstrap.from_stream(io.BytesIO(b""))
        parsed = BridgeBootstrap.from_stream(io.BytesIO(json.dumps({
            "token": "abc", "instanceId": "id", "expectedHost": "127.0.0.1:99"
        }).encode() + b"\n"))
        self.assertEqual(parsed.token, "abc")

    def test_http_authorization_identity_host_and_origin(self):
        base = {"type": "http", "path": "/extension/route", "headers": headers()}
        self.assertEqual(asyncio.run(invoke(base))[0]["status"], 204)
        self.assertEqual(asyncio.run(invoke({**base, "headers": headers("wrong")}))[0]["status"], 401)
        self.assertEqual(asyncio.run(invoke({**base, "headers": headers(host=b"localhost:4567")}))[0]["status"], 421)
        self.assertEqual(asyncio.run(invoke({**base, "headers": headers(origin=b"https://evil.example")}))[0]["status"], 403)
        identity = asyncio.run(invoke({**base, "path": "/bridge/identity"}))
        payload = json.loads(identity[1]["body"])
        self.assertEqual(payload["instanceId"], "instance-a")
        self.assertEqual(payload["protocolVersion"], 1)

    def test_websocket_uses_same_boundary(self):
        denied = asyncio.run(invoke({"type": "websocket", "path": "/queue/join", "headers": headers("wrong")}))
        self.assertEqual(denied, [{"type": "websocket.close", "code": 4401, "reason": "unauthorized"}])

    def test_uvicorn_config_is_wrapped_before_construction(self):
        class FakeConfig:
            def __init__(self, app, marker=None):
                self.app = app
                self.marker = marker

        install_uvicorn_config_guard(FakeConfig, BOOTSTRAP)
        config = FakeConfig(lambda *_args: None, marker="seen")
        self.assertIsInstance(config.app, SecureBridgeMiddleware)
        self.assertEqual(config.marker, "seen")


if __name__ == "__main__":
    unittest.main()

