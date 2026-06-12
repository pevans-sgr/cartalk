"""FastAPI app exposing the engine to the web UI.

Run with:  uvicorn cartalk.api.server:app --reload   (needs the `api` extra)

Endpoints (Phase 1):
  GET  /health                       liveness
  GET  /platforms                    available vehicle definitions
  GET  /platforms/{id}               one platform's modules/DIDs
  POST /scan                         run an all-module scan (body: adapter config)
  POST /diagnose                     AI diagnosis for a scan result
A WebSocket for live-data streaming lands with Phase 1 `live` support.
"""

from __future__ import annotations

from dataclasses import asdict

try:
    from fastapi import FastAPI, HTTPException
    from pydantic import BaseModel
except ImportError as e:  # pragma: no cover - optional extra
    raise RuntimeError("the API needs: pip install 'cartalk[api]'") from e

from ..db import list_platforms, load_platform
from ..db.loader import DEFINITIONS_DIR

app = FastAPI(title="cartalk", version="0.0.1")


class ScanRequest(BaseModel):
    vehicle: str
    adapter: str = "elm327"
    port: str | None = None
    read_data: bool = False


class DiagnoseRequest(BaseModel):
    vehicle: str = ""
    scan: list | dict


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}


@app.get("/platforms")
def platforms() -> dict:
    return {"platforms": list_platforms()}


@app.get("/platforms/{platform_id:path}")
def platform_detail(platform_id: str) -> dict:
    try:
        platform = load_platform(platform_id)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"unknown platform {platform_id!r}")
    return asdict(platform)


@app.post("/scan")
def scan(req: ScanRequest) -> dict:
    """Run an all-module scan. Requires a connected adapter."""
    from ..scanner.scan import scan_platform, enrich_descriptions

    try:
        platform = load_platform(req.vehicle)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"unknown vehicle {req.vehicle!r}")

    transport = _build_transport(req.adapter, req.port)
    try:
        with transport:
            results = scan_platform(transport, platform, read_data=req.read_data)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"scan failed: {e}")
    return {"vehicle": req.vehicle, "modules": enrich_descriptions(results, platform)}


@app.post("/diagnose")
def diagnose_endpoint(req: DiagnoseRequest) -> dict:
    from ..ai.diagnose import diagnose

    try:
        text = diagnose(req.scan, vehicle=req.vehicle)
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))
    return {"diagnosis": text}


def _build_transport(adapter: str, port: str | None):
    if adapter == "elm327":
        if not port:
            raise HTTPException(status_code=400, detail="elm327 adapter needs a port")
        from ..transport.elm327 import Elm327Transport
        return Elm327Transport(port)
    raise HTTPException(status_code=400, detail=f"unknown adapter {adapter!r}")
