"""AI-assisted diagnosis via the Claude API.

Takes the structured output of an all-module scan and asks a Claude model for a
prioritized, plain-English diagnosis: what the codes mean together, likely root cause,
and concrete next steps. ``build_prompt`` is pure and testable; ``diagnose`` performs
the API call and imports the SDK lazily so the rest of the package has no hard
dependency on ``anthropic``.
"""

from __future__ import annotations

import json
import os

from .. import DEFAULT_MODEL

SYSTEM_PROMPT = (
    "You are an expert automotive diagnostic technician specializing in FCA / "
    "Stellantis vehicles (Chrysler, Dodge, Jeep, Ram, Fiat, Alfa Romeo). You are given "
    "a full multi-module diagnostic scan: trouble codes from every ECU plus any live "
    "data that was read. Produce a prioritized diagnosis:\n"
    "1. Group related codes and identify the most likely single root cause when several "
    "codes share one.\n"
    "2. Separate active/confirmed faults from pending or historic ones.\n"
    "3. For the top issues, give concrete next diagnostic steps (what to measure, "
    "inspect, or test) in order of cost/effort.\n"
    "4. Flag anything safety-relevant (airbag/ORC, ABS, steering) explicitly.\n"
    "Be specific and practical. Note where a code is ambiguous rather than guessing."
)


def build_prompt(scan: dict | list, vehicle: str = "") -> str:
    """Render the scan into the user message. ``scan`` is the serialized scan result."""
    header = f"Vehicle: {vehicle}\n\n" if vehicle else ""
    body = json.dumps(scan, indent=2, default=str)
    return (
        f"{header}Here is the full multi-module diagnostic scan as JSON. "
        f"Diagnose it.\n\n```json\n{body}\n```"
    )


def diagnose(scan: dict | list, vehicle: str = "", model: str | None = None,
             api_key: str | None = None) -> str:
    """Return a plain-English guided diagnosis for a scan.

    Model defaults to the CARTALK_MODEL env var, then DEFAULT_MODEL (claude-opus-4-8).
    Requires the ``ai`` extra: pip install 'cartalk[ai]'.
    """
    try:
        import anthropic
    except ImportError as e:
        raise RuntimeError(
            "AI diagnosis needs the anthropic SDK: pip install 'cartalk[ai]'"
        ) from e

    model = model or os.environ.get("CARTALK_MODEL", DEFAULT_MODEL)
    client = anthropic.Anthropic(api_key=api_key) if api_key else anthropic.Anthropic()
    prompt = build_prompt(scan, vehicle)

    # Stream so long diagnoses don't hit the SDK's non-streaming timeout guard;
    # adaptive thinking + high effort suits multi-step diagnostic reasoning.
    with client.messages.stream(
        model=model,
        max_tokens=8000,
        system=SYSTEM_PROMPT,
        thinking={"type": "adaptive"},
        output_config={"effort": "high"},
        messages=[{"role": "user", "content": prompt}],
    ) as stream:
        message = stream.get_final_message()

    if message.stop_reason == "refusal":
        return "[diagnosis declined by the safety classifier]"
    return "".join(b.text for b in message.content if b.type == "text")
