"""Scanner: discover ECUs and read DTCs / DIDs across all modules."""

from .scan import ModuleScan, scan_platform, read_live, enrich_descriptions

__all__ = ["ModuleScan", "scan_platform", "read_live", "enrich_descriptions"]
