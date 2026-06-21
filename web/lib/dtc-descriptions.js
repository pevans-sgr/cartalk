// Curated DTC descriptions for the cards. The shifter/communication codes are FCA
// manufacturer-specific (the SAE decoder produces the code string but not the text); the
// rest are standard SAE J2012 powertrain/transmission codes seen on the Pacifica.
//
// Deliberately conservative: only codes whose meaning is corroborated are listed. An unknown
// code returns null and the UI shows the bare code — we never display a guessed description.

export const DTC_DESCRIPTIONS = {
  // --- Electronic Shift Module (ESM) / communication — the "Service Shifter" cluster ---
  U1267: "No valid data received from the Electronic Shift Module (ESM)",
  U1465: "Implausible driver shift request signal received from the ESM",
  U1466: "Implausible driver shift request signal received from the ESM",
  U0103: "Lost communication with the gear shift module",
  U0104: "Lost communication with the cruise control / ACC module",

  // --- Transmission gear-ratio monitors (SAE J2012) ---
  P0729: "Gear 6 incorrect ratio",
  P0731: "Gear 1 incorrect ratio",
  P0732: "Gear 2 incorrect ratio",
  P0733: "Gear 3 incorrect ratio",
  P0734: "Gear 4 incorrect ratio",
  P0735: "Gear 5 incorrect ratio",
  P0736: "Reverse incorrect ratio",

  // --- Powertrain / control-module performance (SAE J2012) ---
  P0219: "Engine overspeed condition",
  P0607: "Control module performance",
  P061B: "Internal control module torque calculation performance",
};

/** Human description for a DTC code string (e.g. "U1267"), or null if not in the table. */
export function describeDtc(code) {
  return DTC_DESCRIPTIONS[code] || null;
}
