"""Hermes agent-side entrypoint for the unified voice package.

Realtime Voice registers no model-facing tools or hooks. Its server routes live
in ``dashboard/plugin_api.py`` and its renderer surface in ``desktop/plugin.js``.
The no-op entrypoint keeps the package compatible with Hermes versions whose
plugin doctor requires every native ``plugin.yaml`` package to be importable.
"""


def register(ctx) -> None:
    """Load the package without adding tools, hooks, or model instructions."""

