import asyncio
from modules import script_callbacks
from fastapi import WebSocket
from fastapi.responses import StreamingResponse

def register(_demo, app):
    @app.get("/desktop-shell-smoke/sse")
    async def smoke_sse():
        async def events():
            yield "data: shell-ready\n\n"
        return StreamingResponse(events(), media_type="text/event-stream")

    @app.websocket("/desktop-shell-smoke/ws")
    async def smoke_ws(socket: WebSocket):
        await socket.accept()
        value = await socket.receive_text()
        await socket.send_text(f"forge:{value}")
        await socket.close()

script_callbacks.on_app_started(register)
