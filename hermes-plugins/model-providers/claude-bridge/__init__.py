"""Claude via the local ``claude-bridge`` shim.

Hermes runs in Docker; the ``claude`` CLI lives on the host. The bridge is an
OpenAI-compatible HTTP server sitting on the host next to that CLI, so this
profile is a plain chat_completions provider pointed at it. Under Docker
Desktop the container reaches the host as ``host.docker.internal`` —
``CLAUDE_BRIDGE_URL`` (set by docker-compose.hermes.yml) carries the address.

Lives in the OpenKarandash repo (``hermes-plugins/``), not inside ``hermes/``:
the Hermes checkout is pulled from upstream GitHub and reset on every start, so
anything kept there would be lost. docker-compose.hermes.yml mounts this
directory to ``$HERMES_HOME/plugins/model-providers/claude-bridge`` — the
official user-plugin location (see ``providers/__init__.py`` in Hermes).

Deliberately NOT the bundled ``anthropic`` profile: nothing here talks to
api.anthropic.com, and no Anthropic API key or OAuth credential is used.
"""

import json
import logging
import os
import urllib.request

from providers import register_provider
from providers.base import ProviderProfile

logger = logging.getLogger(__name__)

DEFAULT_BASE_URL = os.environ.get("CLAUDE_BRIDGE_URL", "http://host.docker.internal:8788/v1")


class ClaudeBridgeProfile(ProviderProfile):
    """Local bridge profile — catalog comes from the bridge itself."""

    def fetch_models(
        self, *, api_key: str | None = None, base_url: str | None = None, timeout: float = 8.0
    ) -> list[str] | None:
        """Read /v1/models off the bridge.

        The bridge's token is optional (it is only meaningful once the port is
        exposed beyond loopback), so an absent key is not an error here the way
        it is for a hosted provider.
        """
        url = (base_url or self.base_url or DEFAULT_BASE_URL).rstrip("/") + "/models"
        try:
            req = urllib.request.Request(url, headers={"Accept": "application/json"})
            if api_key:
                req.add_header("Authorization", f"Bearer {api_key}")
            with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310 — loopback bridge
                data = json.loads(resp.read().decode())
            return [m["id"] for m in data.get("data", []) if isinstance(m, dict) and "id" in m]
        except Exception as exc:
            logger.debug("fetch_models(claude-bridge): %s", exc)
            return None


claude_bridge = ClaudeBridgeProfile(
    name="claude-bridge",
    aliases=("claudebridge", "claude-local"),
    display_name="Claude Bridge (local)",
    description="Claude through the host-side claude CLI, via the local bridge shim",
    api_mode="chat_completions",
    base_url=DEFAULT_BASE_URL,
    auth_type="api_key",
    env_vars=("CLAUDE_BRIDGE_TOKEN",),
    hostname="host.docker.internal",
    supports_vision=True,
    fallback_models=("claude-bridge-sonnet", "claude-bridge-opus", "claude-bridge-haiku"),
    default_aux_model="claude-bridge-haiku",
)

register_provider(claude_bridge)
