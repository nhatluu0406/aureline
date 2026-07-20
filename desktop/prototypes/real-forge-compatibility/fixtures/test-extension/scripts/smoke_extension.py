"""Real Forge extension fixture: no model, GPU, or generation behavior."""

import asyncio
import sys

import gradio as gr
from fastapi import FastAPI, Request, WebSocket
from fastapi.responses import JSONResponse, RedirectResponse, StreamingResponse

from modules import script_callbacks


def on_ui_tabs():
    with gr.Blocks(analytics_enabled=False) as tab:
        value = gr.Textbox(label="Desktop Smoke Input", elem_id="desktop-smoke-input")
        output = gr.Textbox(label="Desktop Smoke Output", elem_id="desktop-smoke-output")
        button = gr.Button("Desktop Smoke Echo", elem_id="desktop-smoke-button")
        button.click(lambda text: f"echo:{text}", inputs=value, outputs=output, api_name="desktop_smoke_echo")
    return [(tab, "Desktop Smoke", "desktop_smoke")]


def register_routes(_demo: gr.Blocks, app: FastAPI):
    @app.get("/desktop-smoke/extension")
    async def extension_route():
        return {"extension": "real-forge-smoke", "registered": True}

    @app.post("/desktop-smoke/post")
    async def post_route(request: Request):
        return {"body": await request.json()}

    @app.get("/desktop-smoke/argv")
    async def argv_route():
        return {"argv": sys.argv}

    @app.get("/desktop-smoke/delayed")
    async def delayed_route():
        await asyncio.sleep(2)
        return {"delayed": True}

    @app.get("/desktop-smoke/stream")
    async def stream_route():
        async def events():
            yield b"data: real-forge-one\n\n"
            await asyncio.sleep(0.05)
            yield b"data: real-forge-two\n\n"
        return StreamingResponse(events(), media_type="text/event-stream")

    @app.get("/desktop-smoke/redirect")
    async def redirect_route():
        return RedirectResponse("/desktop-smoke/cookie", status_code=307)

    @app.get("/desktop-smoke/cookie")
    async def cookie_route():
        response = JSONResponse({"cookie": True})
        response.set_cookie("desktop-smoke", "real", httponly=True, samesite="strict")
        return response

    @app.websocket("/desktop-smoke/ws")
    async def websocket_route(socket: WebSocket):
        await socket.accept()
        value = await socket.receive_text()
        await socket.send_text(f"echo:{value}")
        await socket.close()


script_callbacks.on_ui_tabs(on_ui_tabs)
script_callbacks.on_app_started(register_routes)
