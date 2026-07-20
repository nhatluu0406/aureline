import io
import unittest

from adapter.secure_launcher import LaunchBootstrap, SecureForgeGuard, install_startup_event_credential


class AdapterTests(unittest.TestCase):
    def test_valid_versioned_frame(self):
        frame = b'{"frameVersion":1,"protocolVersion":1,"token":"token","instanceId":"id","expectedHost":"127.0.0.1:7860","launchGeneration":2}\n'
        value = LaunchBootstrap.from_stream(io.BytesIO(frame))
        self.assertEqual(value.launch_generation, 2)

    def test_invalid_or_multiple_frames_fail_closed(self):
        invalid = [b"", b"{}\n", b'{"frameVersion":2}\n', b'{"frameVersion":1}\nextra']
        for frame in invalid:
            with self.subTest(frame=frame):
                with self.assertRaises(RuntimeError):
                    LaunchBootstrap.from_stream(io.BytesIO(frame))

    def test_http_guard_rejects_missing_credential(self):
        called = False

        async def app(_scope, _receive, _send):
            nonlocal called
            called = True

        guard = SecureForgeGuard(app, LaunchBootstrap("token", "id", "127.0.0.1:7860", 1))
        sent = []

        async def send(message):
            sent.append(message)

        import asyncio
        asyncio.run(guard({"type": "http", "path": "/", "headers": [(b"host", b"127.0.0.1:7860")]}, None, send))
        self.assertFalse(called)
        self.assertEqual(sent[0]["status"], 401)

    def test_gradio_startup_self_call_gets_scoped_credential(self):
        import httpx
        original = httpx.get
        calls = []

        def fake_get(url, *args, **kwargs):
            calls.append((url, kwargs))
            return object()

        try:
            httpx.get = fake_get
            bootstrap = LaunchBootstrap("token", "id", "127.0.0.1:7860", 1)
            install_startup_event_credential(bootstrap)
            httpx.get("http://127.0.0.1:7860/startup-events")
            httpx.get("http://127.0.0.1:7860/other")
            self.assertEqual(calls[0][1]["headers"]["x-forge-bridge-authorization"], "Bearer token")
            self.assertNotIn("headers", calls[1][1])
        finally:
            httpx.get = original


if __name__ == "__main__":
    unittest.main()
