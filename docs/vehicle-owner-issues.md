# Vehicle issue log — 2018 Chrysler Pacifica (intermittent "Service Shifter")

Vehicle: 2018 Chrysler Pacifica (gas), VIN `2C4RC1BG5JR127185`.
Investigation: scan + oscilloscope captures 2026-06-20; battery-monitor baseline 2026-06-21.

---

## 1. Symptom

The vehicle **intermittently** reports a shifter error. If the vehicle is stopped when it
occurs, it forces the transmission into **Park** and **locks the shifter knob**
("Service Shifter").

**Timing is variable:** it sometimes occurs **at startup**, but often appears **minutes after
startup, during idle or driving.** So it is *not* purely a crank/start event — it can trip at
steady state.

## 2. Owner-reported history

**Troubleshooting that had NO effect:**
- Removed the auxiliary battery.
- Removed the auto-stop/start eliminator (physical device).
- "Computer reset" — holding the gas pedal down for a set time.

**What DOES clear the issue (the key clue):**
1. Turn off the car.
2. Remove the negative battery terminal connection.
3. Remove the small charge-sensor connector from the negative-terminal connector
   (this is the **IBS — Intelligent Battery Sensor**).
4. Start the car.
5. Reconnect the charge-sensor connector.

→ The fault clears **only** by power-cycling the **negative-terminal / IBS** connection.

**Bench checks performed:**
- Oscilloscope on the CAN bus — no extra noise observed (see §4).
- Resistance from CAN pins to ground — **60 Ω**, i.e. proper termination, no ground fault.

**Battery age:** both the **main and auxiliary batteries are less than 2 years old.**

## 3. Diagnostic scan results (cartalk Enhanced 11-bit sweep, SGW bypass installed)

The enhanced sweep reached the powertrain modules on the 500 kbps HS-CAN and read their
fault memory — the U-codes that generic OBD-II cannot surface.

**PCM (`0x7E0 → 0x7E8`):** VIN + serial read OK. Does **not** support enhanced DTC service
`0x19` (NRC `0x11`); its codes come from generic OBD-II (mode 03).

**TCM (`0x7E1 → 0x7E9`):** part # `50049895`, serial `T001U713700194`. Returned **40 DTCs**.
The two that carry meaningful status are the shifter-communication codes:

| Code  | Meaning (FCA) | Status |
|-------|---------------|--------|
| **U1465** | Implausible driver shift request signal received from the ESM | `pendingDTC` + `confirmedDTC` + `testFailedSinceLastClear` — a **matured, real fault** |
| **U1267** | No valid data received from the Electronic Shift Module (ESM) | `testFailedSinceLastClear` |
| U0104 | Lost communication with cruise/ACC module | `testNotCompleted…` (dormant) |

**The other ~37 codes** (gear-ratio `P0731–P0735`/`P0729`, the `P1Dxx` block, `P0607`,
`P061B`, `P0219`, etc.) were almost all status **`testNotCompletedThisOperationCycle`**.

> **Readiness caveat:** `testNotCompletedThisOperationCycle` is set at the start of *every*
> key/operation cycle and clears only once each monitor runs. The scan was done parked/idle,
> before drive-dependent monitors (gear-ratio tests need driving) could complete — so that bit
> on most codes is **normal monitor-readiness, not 37 active faults**, and not specifically an
> artifact of the battery disconnect (any key-on produces it). Tell-tale: most showed `0x40`
> only, **not** `testNotCompletedSinceLastClear` (`0x10`, the bit a DTC *clear* sets).
> **Re-scanning after a normal drive cycle should collapse this list** to the codes that
> actually re-fail — the cleanest confirmation they were readiness noise.

## 4. Oscilloscope review (CAN bus, captures in `../CAN Pics/`, 2026-06-20)

cartalk reviewed all 12 captures (CAN-High = yellow, idles ~2.5 V → up to ~4 V dominant;
CAN-Low = blue, idles ~2.5 V → down to ~1.5 V dominant).

**Conclusion: no electrical noise that would corrupt communication. The bus is healthy.**
- Clean, complementary differential signaling (CANH up ↔ CANL down, mirrored about 2.5 V).
- Correct recessive idle (~2.5 V), flat and clean in the quiet stretches — no noise on it.
- The "fuzz" on the traces is **display aliasing** of thousands of bits at a slow timebase,
  not noise on the wire.
- Minor/benign: CANH dominant slightly high (~4 V vs ~3.5 V — still in spec); spikes sit at
  the trigger crosshair (trigger/probe artifact).
- **Notable (not noise):** traffic arrives in **bursts with gaps of silence** — consistent
  with a module intermittently dropping off the bus.

**Does this rule out the CAN star connector? No.** The scope rules out *gross, continuous*
faults (shorts, noise, ground offset, termination — the 60 Ω confirms the terminators/backbone).
It does **not** rule out an intermittent star-connector joint, because: the captures were taken
while the fault was *not* active; a bad joint on the ESM's *stub* can choke that branch while
the backbone at the DLC still looks clean; the 60 Ω only proves the backbone/terminators, not
stubs; and connector reflections are only visible zoomed into a single frame, not at this slow
timebase. The bursty pattern is, if anything, *consistent with* an intermittent stub.

## 5. Battery / charging monitor — baseline (cartalk Power monitor, PID 0x42, 2026-06-21)

Captured from before engine start through start and into idle. **The shifter error was NOT
active during this capture**, so this is a healthy baseline, not the fault condition.

| Phase | RPM | PCM (`0x7E8`) | TCM (`0x7E9`) |
|-------|-----|---------------|---------------|
| Engine **off** (rest) | 0 | **~12.63 V** | ~12.35 V |
| **Start** (caught) | 0 → 1595 | 12.60 → **14.16 V** | 12.31 → 13.93 V |
| **Idle / charging** | settling 1379→818 | **~13.5–13.7 V** | ~13.2–13.4 V |

**Read:** the power system looks **normal** here. Rest ~12.6 V = healthy/near-full charge
(consistent with young batteries); charging ~13.5–14.2 V = alternator working (low-normal at
warm idle). Caveats:
- **Crank dip not captured** — voltage jumped 12.6 → 14.2 V between samples; the old 500 ms
  poll was too slow. (Monitor since upgraded to fast voltage sampling — see §8.)
- **Fault not present**, so no sag to find — as expected.
- **Minor curiosity:** the TCM reads **~0.25–0.3 V below the PCM** at every point. Probably
  sense-point/calibration, but worth watching since the TCM is the module flagging the ESM.

> Both the scope (§4) and this baseline (§5) were taken while everything worked. An
> intermittent fault cannot be ruled out by snapshots from when it isn't happening — the
> decisive data is capturing **the moment the fault trips.**

## 6. Root-cause research (for `U1267` / `U1465`)

Independent repair databases rank the causes of `U1267` (lost comm with ESM):
- **Low / weak battery voltage (< ~12.4 V) — most common, ~60% of cases.** Battery testing is
  the recommended **first** step.
- Recurring Pacifica cases: the **~$90 CAN star connector behind the glove box**.
- **ESM software update** (TSB) in some cases.
- **Replacing the shifter module — least likely / last resort.**

A Chrysler **TSB** notes that with `U1465` + `U1466` + `U1267` present, the remedy is to
replace the shifter assembly (PRNDM/ESM). We have `U1465` + `U1267` (2 of 3) — but a TSB is a
warranty pattern-match, not a root-cause proof.

## 7. Interpretation

The DTCs name the **symptom** — the ESM stopped sending valid data (`U1267`) and the TCM saw an
implausible shift signal (`U1465`) — **not the cause**. A module that **browns out from low
voltage** drops off the bus and sets these exact codes, identically to a failing module; the
codes cannot distinguish the two.

Weighing the evidence:
- **Clean CAN bus** (scope + 60 Ω) → rules out wiring/noise; consistent with a brownout or an
  intermittent stub.
- **Healthy baseline voltage** (§5) → the battery isn't weak at rest; charging works.
- **Batteries < 2 years old** → lowers the odds of a *worn-out* battery (age ≠ health, but a
  resting 12.6 V agrees they're OK).
- **Timing: trips at startup AND minutes into idle/drive** → this is the key refinement. A weak
  battery would fault mainly under high load (crank), not randomly at idle. A fault that appears
  at *steady state, minutes in* smells like an **intermittent connection that randomly opens
  (vibration / thermal expansion as things warm up)** or a **flaky sensor/module** — not a
  simple cranking-voltage shortfall.
- **The clincher** → it clears only by reseating the **negative-terminal / IBS** connection,
  pointing at that exact junction.

## 8. Leading hypothesis

**An intermittent power/connection fault — most likely a marginal joint at the
negative-terminal / IBS connection (or a flaky IBS sensor, or the CAN star connector) — lets the
ESM brown out or drop off the bus at random (crank load *or* vibration/thermal at idle/drive),
which the TCM reports as `U1267`/`U1465` and reacts to by forcing Park and locking the shifter.**
A weak battery is unlikely (young + healthy baseline). Shifter-module replacement is the *last*
resort.

## 9. Diagnostic plan (cheap → expensive)

1. **Run the cartalk Power monitor (PID `0x42`), upgraded** — now samples voltage **fast**
   (catches the crank dip), tracks the **lowest reading + its RPM**, and survives reads failing
   mid-event. Leave it running **through start and several minutes of idle/drive** until the
   fault trips. A sag at the fault moment (or a deep crank dip) confirms power.
2. **Clean & torque** the negative terminal, the **IBS connector**, grounds, and inspect/reseat
   the **CAN star connector behind the glove box**. (Matches the reset clue; age-independent.)
3. **Wiggle/thermal test** those connections with the engine warm (the fault favors steady-state,
   which suggests vibration/thermal), watching the monitor for a voltage glitch.
4. **Measure charging voltage** and **load-test both batteries** — young ≠ healthy.
5. **Check / update ESM software** (TSB) if applicable.
6. **Re-run the Enhanced sweep after a drive cycle** (ideally while the fault is active) — a code
   that re-fails with `testFailed`/`confirmed` is the real one; the readiness list should collapse.
7. **Shifter module replacement** — only after 1–6 come back clean.

> If the upgraded monitor shows **rock-solid voltage with no sag through start, idle, drive, and
> the fault moment**, the power/connection hypothesis weakens and the shifter-module / software
> angle reopens.

## 10. Diagnostic tools the owner has
- CMTOOL OBD2 Breakout Box (16-pin, with LED indicators).
- VGATE vLinker FS USB (FORScan, HS/MS-CAN auto-switch) — the adapter cartalk drives.
- Multimeter.
- OBD2 SGW bypass cable (12+8, FCA Security Gateway) — required for full module access.

## 11. Sources
- `U1267` causes / battery-first: [go-parts](https://www.go-parts.com/garage/obd-u1267),
  [justanswer](https://www.justanswer.com/chrysler/ksxqt-code-u1267-chrysler-pacifica-shifter-keeps-locking-up.html)
- `U1465` definition: [engine-codes](https://www.engine-codes.com/u1465_chrysler.html),
  [autocodes](https://www.autocodes.com/u1465_chrysler.html)
- Related cartalk docs: [`feasibility-shifter-ess.md`](feasibility-shifter-ess.md),
  [`research-fca.md`](research-fca.md).
