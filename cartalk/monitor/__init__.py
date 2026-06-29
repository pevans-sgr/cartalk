"""Headless in-vehicle monitor (Pi Zero W).

A long-running supervisor that watches the bus for the intermittent shifter fault and
captures the moment it trips, then survives the car's on/off cycles gracefully.

The design separates four concerns so each is testable on its own:

* ``lifecycle`` — the ACTIVE / PARKED-AWAKE / SLEEP state machine. Pure logic over a
  clock + a ``car_awake`` boolean + battery voltage; emits side effects through a hooks
  object. No I/O, fully unit-tested.
* ``triggers`` — a ring buffer of recent samples plus the fault-trigger predicates
  (voltage sag, a watched DTC maturing). Pure, unit-tested.
* ``source`` — the data source. Phase 1 is ``ElmSource`` (poll the PCM for voltage and
  the TCM for the shifter DTCs over the ELM327). A future ``CanSource`` (MCP2515 /
  SocketCAN) slots in behind the same interface.
* ``hooks`` / ``store`` / ``webstatus`` — the side-effecting edges (Wi-Fi, CPU governor,
  protective halt; SD logging; the localhost status page), each safe to run off-vehicle.

``daemon`` wires them together. See ``docs/pi-monitor.md`` for the deployment story
(power, Cloudflare tunnel, systemd, the phased CAN-HAT upgrade).
"""

from __future__ import annotations
