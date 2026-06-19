# Feasibility: can open-source data drive the *module-level* shifter / ESS work?

**Question.** [`research-fca.md`](research-fca.md) points at OpenDBC and the
commaCarSegments logs as open-source data sources. Is there enough in that data to
actually build the **module-level** part of cartalk — the AlfaOBD-style read /
configure / actuate layer — for two concrete targets: the **electronic shifter** and
**auto stop-start (ESS)**?

**Short answer.** For *reading* (DTCs, module identity, some live values): mostly yes,
from standards alone. For *configuring or actuating these two features specifically*:
**no.** The open data is the wrong layer, and for ESS the capability does not exist even
in the closed commercial tool. The only real route is capturing a known tool's traffic on
the bypassed bus — cartalk's Phase 2/3, which need the vehicle and hardware, not more open
data.

---

## The crux: two different layers of CAN data

There are two unrelated kinds of "CAN data," and only one of them is what cartalk's
module layer needs.

| | **Layer 1 — passive broadcast** | **Layer 2 — diagnostic UDS** |
|---|---|---|
| What it is | Unsolicited frames ECUs emit constantly | Request/response exchange a tester initiates |
| Examples | gear readout, wheel speed, steering angle | read/write config DID, run actuator routine |
| CAN IDs | vehicle-specific broadcast IDs (`0x101`–`0x3xx`) | physical diagnostic IDs (`0x7xx` / 29-bit `0x18DAxxF1`) |
| Services | none — it's just signal bits | UDS 0x22/0x2E/0x31/0x27 over ISO-TP |
| Who reverse-engineered it | openpilot / comma.ai | OEM tools (AlfaOBD, wiTECH) |
| **In OpenDBC?** | **Yes — this is all OpenDBC is** | **No — never broadcast, so never captured** |

cartalk's module-level work (config DIDs, RoutineControl, SecurityAccess) is **entirely
Layer 2**. OpenDBC is **entirely Layer 1, by construction** — it decodes the frames a car
emits on its own; ECUs never emit their diagnostic config this way, so it can't appear in
a passively-collected DBC or in the commaCarSegments logs. The two data sets do not
overlap with what we need.

## Evidence: the actual OpenDBC Pacifica DBC

From `commaai/opendbc` →
`opendbc/dbc/generator/chrysler/chrysler_pacifica_2017_hybrid.dbc`:

- **31 messages, all passive broadcast IDs** in the `0x101`–`0x36E` range
  (`SPEED_1`, `BRAKE_MODULE`, `GEAR`, `LKAS_COMMAND`, `STEERING_2`, `ACCEL_*`,
  `ENERGY_RELATED_*`, …). **Zero diagnostic `0x7xx` messages.**
- `GEAR` (`0x2EA`) carries `PRNDL` → `VAL_ … 5 "L" 4 "D" 3 "N" 2 "R" 1 "P"`. This is a
  **status readout of the current gear**. It is *not* the shifter module's diagnostic
  address, *not* a DID, and *not* a way to command a shift.
- **No stop-start / ESS signal exists anywhere in the file.**

So the open data tells you *what gear the van is in* and *how fast it's going* — useful
for openpilot, useless for talking to a module as a diagnostic tester.

## Per-feature verdict

### Electronic shifter (ESM)
- It is a real, separate **shift-by-wire** module (the DTC `U1267` = "no valid data
  received from the ESM/shifter"); it coordinates with the TCM.
- Open data gives **only the passive `PRNDL` readout**. The ESM's diagnostic CAN IDs, its
  DIDs, and any RoutineControl actuator are **not** in open data.
- Even setting data aside: **actively commanding a shift via diagnostics is
  safety-critical** and generally not exposed even by factory tools. The realistic
  module-level scope here is *read ESM DTCs / identity*, not actuate it.

### Auto stop-start (ESS)
- This is worse than "absent from open data." Community consensus on the Pacifica is that
  **even AlfaOBD cannot disable ESS** — there is no exposed BCM configuration parameter
  for it. That is precisely why an aftermarket-hardware market exists (the *Autostop
  Eliminator* dongle, which simply re-asserts the OFF button each key-on).
- Implication for cartalk: there is **no known config target to implement**, in open
  *or* closed-tool databases, for this platform. ⚠️ The
  `0x2001 "Auto Stop-Start Configured"` DID currently in
  `web/db/chrysler-pacifica_2018.json` is a **schema placeholder, not a real address** —
  it should not be relied on. (Left unchanged here; flagged for a later DB pass.)

## The deeper blocker behind both: SecurityAccess

Independent of which feature you target, **any write requires UDS SecurityAccess (0x27)
seed/key**, and on 2018+ vehicles the **SGW must be bypassed** (hardware) even to reach
the bus. FCA's seed/key algorithm is **proprietary, per-module and per-firmware**, and is
not in open data — what circulates on forums is leaked/traded, not clean-room. cartalk's
own [`roadmap.md`](roadmap.md) already puts SecurityAccess in **Phase 3** for this reason.

## Conclusion

| Capability | Feasible from open data? | Why |
|---|---|---|
| Read DTCs / module identity (all modules) | **Yes** | UDS 0x19 + SAE DTC decode are standardized; the all-module scan already works |
| Read some live DIDs | **Partly** | Standard DIDs (e.g. VIN `0xF190`) yes; OEM live params need capture |
| **Configure the shifter / ESS** | **No** | Layer-2 config data isn't in OpenDBC; needs tool-capture + SecurityAccess RE |
| **Disable ESS specifically** | **No (anywhere)** | Not exposed even in AlfaOBD; market uses a hardware dongle |
| Actuate the shifter | **No** | Not in open data, safety-gated, not factory-exposed |

**The real route to Layer-2 data** is not "find a better open database" — it's
**capture-from-a-known-tool**: put a sniffer on the bypassed bus while AlfaOBD/wiTECH
talks to the van, reassemble the ISO-TP exchanges, and recover the request IDs, DIDs,
routines, and seed/key behaviour. That is cartalk's **Phase 2 (sniffer + ISO-TP
reassembler)** and **Phase 3 (SecurityAccess)** — both require the vehicle and an adapter,
not more open-source data. See [`roadmap.md`](roadmap.md) and the authoring workflow in
[`database-format.md`](database-format.md).

---

## Sources
- OpenDBC Pacifica DBC (Layer-1 signals; inspected directly):
  `commaai/opendbc` → `opendbc/dbc/generator/chrysler/chrysler_pacifica_2017_hybrid.dbc`.
  Repo: <https://github.com/commaai/opendbc>
- "Can AlfaOBD be used to deactivate Stop Start?" — pacificaforums.com (ESS not
  software-disableable on the Pacifica; hardware eliminator used instead):
  <https://www.pacificaforums.com/threads/can-alfaobd-be-used-to-deactivate-stop-start.58728/>
- Autostop Eliminator, 2018+ Chrysler Pacifica (confirms the hardware-dongle market):
  <https://www.autostopeliminator.com/products/2018-chrysler-pacifica-autostop-eliminator>
- `U1267` = "no valid data received from ESM/shifter" — shift-by-wire, separate module
  (representative diagnostic Q&A): <https://www.justanswer.com/chrysler/>
- FCA SecurityAccess / SGW / AutoAuth background (proprietary, pay-gated seed/key):
  general UDS 0x27 references and FCA AutoAuth program documentation.
