# Pi Zero W in-vehicle fault monitor

A dedicated, always-on logger that lives in the van, arms itself, and **captures the
intermittent shifter fault at the moment it trips** — then behaves well through every
car-on/off cycle, at home or away. This is the strategy shift from the phone-tethered power
monitor (which can't sit plugged in for days): the Pi runs unattended until the fault fires.

Background on the fault and why "catch it in the act" is the decisive data:
[`vehicle-owner-issues.md`](vehicle-owner-issues.md).

This doc covers **Phase 1** (the USB-ELM327 monitor, buildable with hardware you already
own) and sketches **Phase 2** (the MCP2515 CAN-HAT raw sniffer and the hardware wake
circuit). See the phasing decision at the end.

---

## What it does

* Polls the **PCM** (`0x7E0→0x7E8`) for module voltage fast, and the **TCM**
  (`0x7E1→0x7E9`) for the shifter codes `U1465` / `U1267` — the field-validated 11-bit
  addresses from [`vehicle-owner-issues.md`](vehicle-owner-issues.md) §3, not the
  placeholder 29-bit modules in the YAML.
* **Triggers** a snapshot when voltage sags below threshold (the brownout hypothesis) or a
  watched DTC *matures live* (gains a test-failed / confirmed bit). Each snapshot is the
  buffered **pre-window** (default 120 s) plus a dense **post-window** (default 30 s) — the
  fault with context on both sides.
* Survives the **car's power cycles** via a three-state lifecycle (below).
* Serves a **localhost status page** that a Cloudflare tunnel publishes to your domain, so
  you review caught faults remotely from the garage.
* Writes everything to the **SD card first** — networking is a best-effort overlay, so a
  drive with no Wi-Fi loses nothing.

## The lifecycle (behaviour through on/off cycles)

The Pi is wired to constant 12 V, so it's always powered — "sleep" is a software low-power
state, not a true suspend. The process stays alive so it wakes in **under a second** and
never misses a crank-start fault.

| State | When | Monitoring | Wi-Fi | CPU |
|---|---|---|---|---|
| **ACTIVE** | car awake (PCM answers) | full rate (~3 Hz) | **off** (driving; no home net) | normal |
| **PARKED-AWAKE** | car just shut off | light | **on** → tunnel up for review | normal |
| **SLEEP** | parked > `--sleep-timeout` (20 min) | slow wake-watch | **off** | `powersave` |

Guards that make this robust:
* **Park debounce (30 s):** the car must look asleep *continuously* before leaving ACTIVE.
  The fault disrupts the bus briefly; without this a fault could be misread as "parked."
  Awake is keyed on the **PCM**, which stays up through the fault (it's the TCM/ESM that
  drop out), so the fault never looks like a key-off.
* **Wake is immediate:** a *single* awake sample returns to ACTIVE — catching the crank
  matters more than avoiding a spurious wake.
* **Battery protection:** if resting voltage stays below `--batt-floor` (11.8 V) for 2 min,
  the Pi does a clean protective shutdown. ⚠️ This is terminal — after a true halt the
  constant-12 V supply can't power-cycle the Pi, so car-on won't auto-revive it (the
  Phase-2 wake circuit fixes that). Young/healthy batteries should never trip it; it's a
  last-ditch guard so the monitor can't be what flattens your battery.

Why Wi-Fi only when parked: you only ever connect from the garage (no cell service in the
van), and the radio wastes power scanning for an out-of-range network while driving. Drive
away → Wi-Fi off, logging continues to SD. Park in the garage → Wi-Fi on, NetworkManager
re-associates, the tunnel comes back, you review what was caught.

---

## Status LED (the onboard green ACT light)

The monitor repurposes the Pi Zero's single green **ACT** LED (`/sys/class/leds/ACT`) as a
no-screen status indicator, so you can confirm it's armed before cranking:

| LED | Meaning |
|-----|---------|
| **heartbeat** (double-pulse) | process up, but not yet reading the van (adapter waiting / car asleep) |
| **solid on** | reading the live bus right now — **armed, safe to crank** |
| **fast blink** | a fault capture is in progress |

**Pre-crank workflow:** key the van to **RUN** (engine off) and wait for the LED to go
**solid** — that means the monitor already sees the bus awake and will capture from the very
first instant of the start — *then* crank. It goes solid within ~1–2 s of the bus waking (or
after boot, ~1 min, if the Pi cold-started with the car).

The original LED trigger (SD-activity) is restored on a clean stop. Disable with
`--no-led`, or point at a different LED with `--led <name>` (see `/sys/class/leds`).

## Hardware & power (Phase 1)

You need, beyond the Pi Zero W (header soldered — good, that's for Phase 2):

* The **vLinker FS** (FTDI FT230X) you already use, on the Pi's **USB-OTG** port via a
  micro-USB-OTG adapter. On Linux it enumerates as `/dev/ttyUSB0` with the in-kernel
  `ftdi_sio` driver — far simpler than the Android WebUSB path; no custom FTDI driver.
* The **SGW bypass** inline (as for any enhanced read on this van).
* **5 V power for the Pi** from the OBD port's constant 12 V (pin 16) through a **buck
  converter** (12 V→5 V, ≥1 A). This is *constant* power — the battery-protection floor and
  the SLEEP state exist precisely to bound the resulting parasitic draw.

> **Parasitic draw is the open number.** A Pi Zero W in SLEEP (Wi-Fi off, `powersave`)
> draws on the order of tens of mA off the battery through the buck. Over a multi-day park
> that's real but modest; the protective floor is the backstop. Measure it in the field
> (below) — that measurement is what decides whether you add the Phase-2 wake circuit.

OBD pinout used: **6** CAN-H, **14** CAN-L (Phase 2 CAN HAT), **16** +12 V, **4/5** ground.

---

## Software setup

OS: Raspberry Pi OS Lite (64-bit works; Zero W is ARMv6 so use the **Bullseye/Bookworm
armhf** image). Enable SSH, set your home Wi-Fi in the imager.

```bash
git clone https://github.com/pevans-sgr/cartalk && cd cartalk
sudo deploy/install.sh        # installs cartalk[elm327], udev rule, systemd service
```

`install.sh` is idempotent — re-run it after a `git pull` to update.

Check it:
```bash
systemctl status cartalk-monitor
journalctl -u cartalk-monitor -f      # watch state changes + TRIGGER lines
curl localhost:8088/status.json
```

Run it by hand off-vehicle (dry-runs the Wi-Fi/CPU/halt side effects):
```bash
cartalk monitor --port /dev/ttyUSB0 --data-dir /tmp/cartalk --no-actions
```

### Networking

* **Home Wi-Fi auto-connect:** NetworkManager (default on current Pi OS) reconnects to a
  saved SSID automatically — confirm with `nmcli connection show`. The daemon turns the
  radio on/off by **state** via `rfkill`; NM does the (re)association whenever the radio is
  up and the network is in range. Nothing to schedule.
* **Cloudflare tunnel:** see [`../deploy/cloudflared-config.example.yml`](../deploy/cloudflared-config.example.yml).
  `cloudflared` runs as its own service with built-in retry, so losing Wi-Fi on a drive and
  regaining it in the garage re-establishes `monitor.evans-apps.org` with no intervention.

### Reviewing caught faults

From the garage, open `https://monitor.evans-apps.org` — current state + voltage, uptime,
and a list of **caught events** to download. Each event JSON has the trigger(s), the
pre-window, and the post-window. On the Pi directly:

```bash
ls  /var/lib/cartalk/events/          # one event-*.json per captured fault (plain JSON)
cat /var/lib/cartalk/events/event-*.json
ls  /var/lib/cartalk/samples-*.jsonl  # the continuous rolling log
```

Feed an event (or a day's samples) to the AI diagnosis once you've caught one.

### Tuning

All via service args (edit `/etc/systemd/system/cartalk-monitor.service`, then
`systemctl daemon-reload && systemctl restart cartalk-monitor`):

| Flag | Default | Meaning |
|---|---|---|
| `--sag-volts` | 11.0 | voltage-sag trigger threshold |
| `--watch` | U1465 U1267 | DTC codes to watch mature |
| `--sleep-timeout` | 1200 | seconds parked before SLEEP |
| `--batt-floor` | 11.8 | resting-voltage protective-shutdown floor |
| `--no-actions` | off | dry-run side effects (bench testing) |

---

## Measuring battery drain (decides Phase 2)

The phased plan: ship Phase 1, **measure real drain over a few long parks**, add the
hardware wake circuit only if the number is too high.

1. Park overnight / a weekend with the monitor running.
2. The rolling log records resting voltage in PARKED-AWAKE/SLEEP — watch the slope of
   `volts` over hours in `samples-*.jsonl`.
3. Or put a clamp/inline meter on the buck input for an actual mA figure.
4. If resting voltage trends toward the floor across a normal park, or draw is more than you
   want, build the Phase-2 wake circuit so the Pi can truly power down between drives.

---

## Phase 2 (next)

* **MCP2515 CAN HAT** on the now-soldered SPI header → `can0` via SocketCAN. Passively logs
  **every frame** with µs timestamps, decodes the **GEAR/PRNDL** broadcast (`0x2EA`, from
  OpenDBC) so you watch the gear snap to Park, and sees the **bus-dropout** (the bursty
  silence noted in the scope review §4) at the fault instant. It slots in behind the same
  `source` interface — a `CanSource` with the same `read_power` / `read_watch_dtcs` (plus a
  raw `candump`), and the daemon doesn't change.
  * First, a 30-second `candump can0` confirms broadcast frames actually reach the OBD port
    through the SGW bypass. If they don't, the CAN HAT still does UDS over ISO-TP; only the
    passive-broadcast bonus is gated.
  * Note the Zero W is single-core ARMv6: at 500 kbit/s under full bus load the MCP2515 can
    occasionally drop frames. For a trigger-logger watching a handful of IDs that's fine.
* **Hardware wake circuit** for true deep sleep: a comparator on the 12 V rising to charging
  voltage (~13.5 V) drives the Pi's **GPIO3** wake-from-halt pin, so SLEEP becomes a real
  `halt` (lowest drain) that auto-wakes on car-start. Eliminates the only downside of the
  software-sleep approach (the terminal protective halt).
