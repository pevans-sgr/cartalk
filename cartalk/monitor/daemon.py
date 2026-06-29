"""The monitor supervisor loop.

Ties the source, lifecycle, triggers, store, and status page together and runs until
killed. Built to survive everything the car throws at it:

* a read failing (bus asleep, adapter hiccup) is recorded as a partial sample, not a crash;
* an unexpected transport error reconnects the adapter with backoff;
* the loop's poll rate follows the lifecycle state (fast when ACTIVE, slow when parked);
* when a trigger fires it freezes the buffered pre-window and densely samples a post-window,
  then writes the snapshot — so the fault is captured with context on both sides.

All wall-clock work uses the real clock here (this is the live daemon, not a pure unit);
the pure, time-injected logic lives in ``lifecycle`` and ``triggers`` and is tested there.
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field

from .hooks import PiHooks
from .led import StatusLed
from .lifecycle import Lifecycle, State
from .source import ElmSource
from .store import EventStore, utc_now_iso
from .triggers import RingBuffer, Sample, TriggerSet
from .webstatus import make_server


@dataclass
class MonitorConfig:
    data_dir: str
    http_host: str = "127.0.0.1"
    http_port: int = 8088
    # poll cadence by state (seconds)
    active_interval: float = 0.3
    parked_interval: float = 2.0
    sleep_interval: float = 2.0
    dtc_interval: float = 30.0         # how often to read TCM DTCs while awake (a full
                                       # 40-DTC read is slow and blocks the fast voltage
                                       # loop, so keep it infrequent; a tripped fault
                                       # latches, so 30s still catches it "in the act")
    # capture window around a trigger (seconds)
    pre_window: float = 120.0
    post_window: float = 30.0
    # trigger thresholds
    sag_volts: float = 11.0
    watch_codes: tuple[str, ...] = ("U1465", "U1267")
    # lifecycle
    sleep_timeout: float = 1200.0
    park_debounce: float = 30.0
    batt_floor: float = 11.8
    batt_floor_grace: float = 120.0
    parked_log_interval: float = 30.0  # sparse sample logging while parked, to spare the SD
    enable_actions: bool = True        # set False to dry-run hooks off-vehicle
    led: str | None = "ACT"            # onboard status-LED name; None/"" to disable


def log(msg: str) -> None:
    print(f"{utc_now_iso()} {msg}", flush=True)


@dataclass
class _Capture:
    """An in-progress fault snapshot."""
    until: float
    pre: list[dict]
    triggers: list[dict]
    post: list[dict] = field(default_factory=list)


class MonitorDaemon:
    def __init__(self, source: ElmSource, cfg: MonitorConfig):
        self.source = source
        self.cfg = cfg
        self.store = EventStore(cfg.data_dir)
        self.hooks = PiHooks(log, enable_actions=cfg.enable_actions)
        self.lifecycle = Lifecycle(
            self.hooks, sleep_timeout=cfg.sleep_timeout, park_debounce=cfg.park_debounce,
            batt_floor=cfg.batt_floor, batt_floor_grace=cfg.batt_floor_grace)
        self.triggers = TriggerSet(sag_volts=cfg.sag_volts, watch_codes=cfg.watch_codes)
        self.ring = RingBuffer(window_seconds=cfg.pre_window)
        self.led = StatusLed(cfg.led, log=log)

        self._stop = threading.Event()
        self._started = time.monotonic()
        self._n_samples = 0
        self._capture: _Capture | None = None
        self._last_dtc_read = 0.0
        self._last_parked_log = 0.0
        self._last_status: dict = {"state": "active"}
        self._server = None

    # -- status for the web page -------------------------------------------

    def _status(self) -> dict:
        return dict(self._last_status,
                    uptime=time.monotonic() - self._started,
                    samples=self._n_samples)

    # -- main loop ----------------------------------------------------------

    def run(self) -> None:
        # Bring the status page up first, so it's reachable even before the adapter is.
        self._server = make_server(self.cfg.http_host, self.cfg.http_port,
                                   self._status, self.store)
        threading.Thread(target=self._server.serve_forever, daemon=True).start()
        log(f"monitor up — http://{self.cfg.http_host}:{self.cfg.http_port}  "
            f"data dir {self.cfg.data_dir}")
        self.led.heartbeat()  # alive, not yet reading the van
        # Connect to the adapter, retrying until it appears — it may be unplugged at boot
        # or enumerate a little after us in the car. Never fatal; the status page stays up.
        if not self._connect_with_retry():
            self._teardown()
            return
        backoff = 1.0
        try:
            while not self._stop.is_set():
                try:
                    self._tick()
                    backoff = 1.0
                except Exception as e:  # never die on a tick; reconnect and continue
                    log(f"tick error: {e!r} — reconnecting in {backoff:.0f}s")
                    self._reconnect(backoff)
                    backoff = min(backoff * 2, 30.0)
                self._stop.wait(self._interval())
        finally:
            self._teardown()

    def _connect_with_retry(self) -> bool:
        """Open the adapter, backing off until it's present or we're told to stop."""
        backoff = 1.0
        while not self._stop.is_set():
            try:
                self.source.open()
                log("adapter connected")
                return True
            except Exception as e:
                self._last_status = {"state": "waiting", "watched": "adapter not ready"}
                log(f"adapter not ready: {e} — retry in {backoff:.0f}s")
                self._stop.wait(backoff)
                backoff = min(backoff * 2, 30.0)
        return False

    def _teardown(self) -> None:
        self.led.close()
        self.source.close()
        if self._server is not None:
            self._server.shutdown()
        log("monitor stopped")

    def stop(self) -> None:
        self._stop.set()

    # -- one cycle ----------------------------------------------------------

    def _tick(self) -> None:
        now = time.monotonic()
        power = self.source.read_power()
        sample = Sample(
            t=now, wall=utc_now_iso(), volts=power.volts, rpm=power.rpm,
            car_awake=power.ok, state=self.lifecycle.state.value)

        # Read watched DTCs on their own slow cadence, only while the car is awake. This
        # is the one expensive read (full multi-frame), so it's deliberately infrequent.
        if power.ok and (now - self._last_dtc_read) >= self.cfg.dtc_interval:
            t0 = time.monotonic()
            try:
                sample.dtc_status = self.source.read_watch_dtcs()
                dur = time.monotonic() - t0
                if dur > 1.0:  # surface how long the DTC read actually blocks the loop
                    log(f"dtc read took {dur:.1f}s")
            except Exception as e:
                sample.note = f"dtc read failed: {e}"
            self._last_dtc_read = now

        state = self.lifecycle.update(now, car_awake=power.ok,
                                      battery_volts=power.volts)
        sample.state = state.value
        self.ring.append(sample)
        self._n_samples += 1
        self._record_sample(sample, state)
        self._update_status(sample, state)
        self._drive_led(sample)

        for event in self.triggers.evaluate(sample):
            self._on_trigger(event, sample)

        self._service_capture(now, sample)

    def _drive_led(self, sample: Sample) -> None:
        # fast blink while capturing a fault; solid when reading the live bus (safe to
        # crank); heartbeat otherwise (alive but the bus is asleep / adapter quiet).
        if self._capture is not None:
            self.led.fast_blink()
        elif sample.car_awake:
            self.led.solid()
        else:
            self.led.heartbeat()

    # -- triggers & capture -------------------------------------------------

    def _on_trigger(self, event, sample: Sample) -> None:
        log(f"TRIGGER {event.kind}: {event.detail}")
        if self._capture is None:
            self._capture = _Capture(
                until=sample.t + self.cfg.post_window,
                pre=[s.to_dict() for s in self.ring.recent()],
                triggers=[event.to_dict()])
        else:
            # Already capturing — fold this trigger in and extend the tail.
            self._capture.triggers.append(event.to_dict())
            self._capture.until = max(self._capture.until,
                                      sample.t + self.cfg.post_window)

    def _service_capture(self, now: float, sample: Sample) -> None:
        cap = self._capture
        if cap is None:
            return
        cap.post.append(sample.to_dict())
        if now >= cap.until:
            self._flush_capture(cap)
            self._capture = None

    def _flush_capture(self, cap: _Capture) -> None:
        kinds = ", ".join(sorted({t["kind"] for t in cap.triggers}))
        details = "; ".join(t["detail"] for t in cap.triggers)
        event = {
            "captured": utc_now_iso(),
            "summary": f"{kinds}: {details}",
            "triggers": cap.triggers,
            "pre_window": cap.pre,
            "post_window": cap.post,
        }
        path = self.store.write_event(event)
        log(f"captured fault snapshot -> {path}  ({len(cap.pre)} pre, {len(cap.post)} post)")

    # -- sample logging & status -------------------------------------------

    def _record_sample(self, sample: Sample, state: State) -> None:
        # Always log while active or mid-capture; spare the SD while parked/asleep.
        if state is State.ACTIVE or self._capture is not None:
            self.store.log_sample(sample.to_dict())
        elif (sample.t - self._last_parked_log) >= self.cfg.parked_log_interval:
            self.store.log_sample(sample.to_dict())
            self._last_parked_log = sample.t

    def _update_status(self, sample: Sample, state: State) -> None:
        watched = ", ".join(f"{c} 0x{s:02X}" for c, s in sample.dtc_status.items()) \
            if sample.dtc_status else "watching U1465 / U1267"
        self._last_status = {
            "state": state.value, "volts": sample.volts, "rpm": sample.rpm,
            "watched": watched, "capturing": self._capture is not None}

    # -- timing & connection ------------------------------------------------

    def _interval(self) -> float:
        if self._capture is not None:
            return self.cfg.active_interval
        return {State.ACTIVE: self.cfg.active_interval,
                State.PARKED_AWAKE: self.cfg.parked_interval,
                State.SLEEP: self.cfg.sleep_interval}[self.lifecycle.state]

    def _reconnect(self, backoff: float) -> None:
        self.source.close()
        self._stop.wait(backoff)
        try:
            self.source.open()
            log("adapter reconnected")
        except Exception as e:
            log(f"reconnect failed: {e}")
