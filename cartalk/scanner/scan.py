"""All-module scan orchestration.

Given a Transport and a Platform definition, walk every module, read its DTCs, and
(optionally) read its named DIDs. This is the "deep fault scan" that a generic OBD-II
reader can't do — it reaches B/C/U codes in BCM, ABS, airbag, cluster, etc., not just
powertrain P-codes on one bus.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from ..db.models import Platform, Module
from ..db.loader import decode_did_value
from ..protocol.dtc import Dtc
from ..protocol.uds import UdsClient, UdsError


@dataclass
class ModuleScan:
    """Results for one module."""

    module_id: str
    name: str
    reachable: bool = True
    error: str | None = None
    dtcs: list[Dtc] = field(default_factory=list)
    data: dict[str, object] = field(default_factory=dict)  # DID name -> decoded value

    def to_dict(self) -> dict:
        return {
            "module_id": self.module_id,
            "name": self.name,
            "reachable": self.reachable,
            "error": self.error,
            "dtcs": [
                {"code": d.code, "sub": d.sub, "status": d.status,
                 "flags": d.status_flags,
                 "description": None}  # filled in by enrich() below
                for d in self.dtcs
            ],
            "data": self.data,
        }


def _read_dids(client: UdsClient, dids, into: dict) -> None:
    for did in dids:
        try:
            raw = client.read_did(did.id)
            into[did.name] = decode_did_value(raw, did.decode)
        except Exception:
            # Missing/unreadable DID is non-fatal; skip it.
            continue


def _enter_session(client: UdsClient) -> None:
    """Best-effort extended diagnostic session; some modules need it, some reject it."""
    try:
        client.diagnostic_session()
    except Exception:
        pass


def _scan_module(transport, module: Module, read_data: bool,
                 enter_session: bool) -> ModuleScan:
    result = ModuleScan(module_id=module.id, name=module.name)
    client = UdsClient(transport, module.request_id, module.response_id)
    if enter_session:
        _enter_session(client)
    try:
        result.dtcs = client.read_dtcs()
    except UdsError as e:
        result.error = str(e)
    except Exception as e:  # transport-level failure: treat module as unreachable
        result.reachable = False
        result.error = str(e)
        return result

    if read_data:
        _read_dids(client, module.dids, result.data)
    return result


def scan_platform(transport, platform: Platform, read_data: bool = False,
                  enter_session: bool = True) -> list[ModuleScan]:
    """Scan every module in ``platform`` and return per-module results.

    The transport is assumed already open. A dead module is recorded as unreachable and
    the scan continues. DTC code strings are enriched with module-specific descriptions
    from the database where available (see ``enrich_descriptions``).
    """
    return [_scan_module(transport, m, read_data, enter_session) for m in platform.modules]


def read_live(transport, platform: Platform, module_id: str | None = None,
              enter_session: bool = True) -> dict[str, dict]:
    """Read the ``live`` DIDs for one module (or all) and return decoded values.

    Returns ``{module_id: {did_name: value}}``. Config DIDs are skipped — this is the
    read-only live-data view behind ``cartalk live``.
    """
    modules = ([platform.module(module_id)] if module_id else platform.modules)
    out: dict[str, dict] = {}
    for module in modules:
        if module is None:
            continue
        live_dids = [d for d in module.dids if d.kind == "live"]
        if not live_dids:
            continue
        client = UdsClient(transport, module.request_id, module.response_id)
        if enter_session:
            _enter_session(client)
        values: dict = {}
        _read_dids(client, live_dids, values)
        out[module.id] = values
    return out


def enrich_descriptions(results: list[ModuleScan], platform: Platform) -> list[dict]:
    """Serialize results, attaching DB-known DTC descriptions per module."""
    out = []
    for scan in results:
        module = platform.module(scan.module_id)
        d = scan.to_dict()
        if module is not None:
            for entry, dtc in zip(d["dtcs"], scan.dtcs):
                entry["description"] = module.describe_dtc(dtc.code)
        out.append(d)
    return out
