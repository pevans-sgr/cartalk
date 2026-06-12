"""AI-assisted diagnosis: turn collected vehicle state into guided troubleshooting."""

from .diagnose import diagnose, build_prompt

__all__ = ["diagnose", "build_prompt"]
