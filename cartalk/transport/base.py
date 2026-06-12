"""Transport abstraction.

A Transport carries a diagnostic request to one ECU (addressed by its CAN request id)
and returns the ISO-TP-reassembled response bytes. Concrete transports differ only in
*how* the bytes reach the bus — ELM327 AT-commands vs. raw SocketCAN frames — so the
UDS and scanner layers above are written against this ABC and never care which is used.
"""

from __future__ import annotations

from abc import ABC, abstractmethod


class TransportError(Exception):
    """Raised on a transport failure (no adapter, timeout, bus error, bad response)."""


class Transport(ABC):
    """Base class for all adapters.

    Lifecycle: ``open()`` → many ``request(...)`` calls → ``close()``. Use as a
    context manager to get open/close for free.
    """

    @abstractmethod
    def open(self) -> None:
        """Connect to the adapter and initialize the bus. Idempotent."""

    @abstractmethod
    def close(self) -> None:
        """Release the adapter. Idempotent; safe to call if never opened."""

    @abstractmethod
    def request(self, request_id: int, response_id: int, payload: bytes,
                timeout: float = 2.0) -> bytes:
        """Send ``payload`` to ``request_id`` and return the reassembled response.

        Args:
            request_id: CAN arbitration id to send the diagnostic request on.
            response_id: CAN id the target module replies on.
            payload: UDS/KWP service bytes (without ISO-TP framing).
            timeout: seconds to wait for the full response.

        Returns:
            The response service bytes (ISO-TP reassembled, framing stripped).

        Raises:
            TransportError: on timeout, bus error, or malformed response.
        """

    # Convenience -----------------------------------------------------------

    def __enter__(self) -> "Transport":
        self.open()
        return self

    def __exit__(self, *exc) -> None:
        self.close()
