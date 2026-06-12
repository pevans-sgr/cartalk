"""Database schema as plain dataclasses.

These mirror the YAML format in docs/database-format.md. They carry no I/O — the
loader builds them from dicts so they're trivially testable without files or pyyaml.
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class Did:
    """A Data Identifier: a readable (and, Phase 3, writable) value in a module."""

    id: int                       # 16-bit DID
    name: str
    kind: str = "live"            # "live" | "config"
    decode: str = "hex"           # see docs/database-format.md → decode values


@dataclass
class Routine:
    """A RoutineControl id (actuator test / alignment)."""

    id: int
    name: str


@dataclass
class Module:
    """One ECU on the vehicle and how to talk to it."""

    id: str                       # short stable id, e.g. "bcm"
    name: str
    request_id: int               # diagnostic CAN request arbitration id
    response_id: int              # CAN id the module responds on
    protocol: str = "uds"         # "uds" | "kwp2000"
    dids: list[Did] = field(default_factory=list)
    routines: list[Routine] = field(default_factory=list)
    dtcs: dict[str, str] = field(default_factory=dict)  # code -> description override

    def describe_dtc(self, code: str) -> str | None:
        """Module-specific human description for a DTC code, if known."""
        return self.dtcs.get(code)


@dataclass
class Platform:
    """A vehicle platform: a set of modules plus metadata."""

    platform: str                 # unique id, e.g. "chrysler/pacifica_2018"
    make: str
    model: str
    year_from: int | None = None
    year_to: int | None = None
    notes: str = ""
    modules: list[Module] = field(default_factory=list)

    def module(self, module_id: str) -> Module | None:
        return next((m for m in self.modules if m.id == module_id), None)
