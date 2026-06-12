"""FastAPI app — a thin shell over ``api/engine.py`` that also serves the web UI.

Run via the CLI: ``cartalk serve --adapter loopback`` (or via the Termux launcher with
``--adapter android-usb``). The adapter is configured from environment variables so the
ASGI app object stays import-time side-effect free:

    CARTALK_ADAPTER   loopback | android-usb | tcp | elm327   (default: loopback)
    CARTALK_USB_FD    file descriptor for android-usb (set by termux-serve.sh)
    CARTALK_TCP       HOST:PORT for the tcp adapter
    CARTALK_PORT      serial port for the elm327 adapter
"""

from __future__ import annotations

import os
from pathlib import Path

try:
    from fastapi import FastAPI, HTTPException
    from fastapi.responses import FileResponse
    from fastapi.staticfiles import StaticFiles
    from pydantic import BaseModel
except ImportError as e:  # pragma: no cover - optional extra
    raise RuntimeError("the API needs: pip install 'cartalk[api]'") from e

from dataclasses import asdict

from ..db import list_platforms, load_platform
from .engine import ScanEngine, TranscriptStore

WEBUI_DIR = Path(__file__).parent.parent / "webui"


def _engine_from_env() -> ScanEngine:
    fd = os.environ.get("CARTALK_USB_FD")
    return ScanEngine(
        adapter=os.environ.get("CARTALK_ADAPTER", "loopback"),
        port=os.environ.get("CARTALK_PORT"),
        usb_fd=int(fd) if fd else None,
        tcp=os.environ.get("CARTALK_TCP"),
        transcripts=TranscriptStore(),
    )


app = FastAPI(title="cartalk", version="0.0.1")
engine = _engine_from_env()

if WEBUI_DIR.exists():
    app.mount("/static", StaticFiles(directory=str(WEBUI_DIR)), name="static")


class ScanRequest(BaseModel):
    vehicle: str
    read_data: bool = False
    log: bool = True


class DiagnoseRequest(BaseModel):
    vehicle: str = ""
    scan: list | dict


@app.get("/")
def index():
    idx = WEBUI_DIR / "index.html"
    if not idx.exists():
        return {"service": "cartalk", "note": "web UI not packaged; use the JSON API"}
    return FileResponse(str(idx))


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "adapter": engine.adapter}


@app.get("/platforms")
def platforms() -> dict:
    return {"platforms": list_platforms()}


@app.get("/platforms/{platform_id:path}")
def platform_detail(platform_id: str) -> dict:
    try:
        return asdict(load_platform(platform_id))
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"unknown platform {platform_id!r}")


@app.post("/scan")
def scan(req: ScanRequest) -> dict:
    try:
        return engine.scan(req.vehicle, read_data=req.read_data, log=req.log)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"unknown vehicle {req.vehicle!r}")
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"scan failed: {e}")


@app.get("/transcript/{tid}")
def transcript(tid: str):
    path = engine.store.path(tid)
    if path is None:
        raise HTTPException(status_code=404, detail="transcript not found")
    return FileResponse(path, media_type="application/x-ndjson",
                        filename=f"cartalk-{tid}.jsonl")


@app.post("/diagnose")
def diagnose_endpoint(req: DiagnoseRequest) -> dict:
    from ..ai.diagnose import diagnose
    try:
        return {"diagnosis": diagnose(req.scan, vehicle=req.vehicle)}
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))
