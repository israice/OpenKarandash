"""Tool calling over a text protocol.

Hermes speaks the OpenAI wire: it sends `tools` and expects the model to answer
with `tool_calls` and stop. Claude Code headless has no way to accept a caller's
tool schemas and hand the invocation back — its own tools execute in-process,
which is exactly what must NOT happen here (Hermes owns execution).

So the schemas are put in the system prompt and the model is asked to emit a
single JSON object when it wants a tool. That object is parsed back into proper
OpenAI `tool_calls`. It is a convention, not a guarantee: `parse_tool_calls`
returns None whenever the reply is not a well-formed call, and the text is then
delivered as an ordinary assistant message.
"""

from __future__ import annotations

import json
import logging
import re
import uuid
from typing import Any

# A fenced ```json block, or a bare object — the two shapes models actually emit.
logger = logging.getLogger("claude_bridge.tools")

_FENCE = re.compile(r"^\s*```(?:json)?\s*(.*?)\s*```\s*$", re.DOTALL)

PROTOCOL_INSTRUCTIONS = """
# Tool request protocol — READ THIS FIRST

You are the reasoning half of a larger system. You do NOT execute tools and you
have NO tool runtime of your own in this session — ignore any built-in tooling
you would normally have. Instead, the system below EXECUTES tools on your
behalf when you REQUEST them.

Requesting a tool is done by writing a JSON object as your entire reply — that
JSON *is* the call. It always works; there is no situation where a listed tool
is unavailable to you.

To request one or more tools, reply with this JSON object and NOTHING else — no
prose before or after it, no markdown fence, no explanation:

{"tool_calls": [{"name": "<tool name>", "arguments": {<arguments object>}}]}

Rules:
- "arguments" must be a JSON object matching that tool's parameter schema.
- Emit several entries only when the calls are independent of each other.
- Never say you lack access to a listed tool, and never tell the user to look
  the answer up elsewhere — request the tool instead.
- When the task genuinely needs no tool, answer in plain text. Never mix prose
  and the JSON object in one reply.
- Never invent a tool that is not listed.

## Tools you may request
""".strip()

REMINDER = (
    "[Protocol reminder: to use a tool, your entire reply must be the JSON object "
    '{"tool_calls": [{"name": ..., "arguments": {...}}]} — nothing else. '
    "Otherwise answer in plain text.]"
)


def render_tools(tools: list[dict], tool_choice: Any = None) -> str:
    """Render OpenAI tool definitions into the system prompt section."""
    blocks = []
    for tool in tools or []:
        if not isinstance(tool, dict):
            continue
        fn = tool.get("function") if tool.get("type") == "function" else tool
        if not isinstance(fn, dict) or not fn.get("name"):
            continue
        blocks.append(
            f"### {fn['name']}\n"
            f"{fn.get('description') or '(no description)'}\n"
            f"Parameters (JSON Schema):\n{json.dumps(fn.get('parameters') or {}, ensure_ascii=False)}"
        )
    if not blocks:
        return ""

    text = PROTOCOL_INSTRUCTIONS + "\n\n" + "\n\n".join(blocks)

    # tool_choice: "required"/"none"/{"function": {...}} — honoured as prompt
    # pressure, which is the strongest guarantee a text protocol can give.
    if tool_choice == "required":
        text += "\n\nYou MUST call one of the tools above in this reply."
    elif tool_choice == "none":
        text += "\n\nDo NOT call any tool in this reply; answer in plain text."
    elif isinstance(tool_choice, dict):
        forced = (tool_choice.get("function") or {}).get("name")
        if forced:
            text += f"\n\nYou MUST call the tool `{forced}` in this reply."
    return text


def parse_tool_calls(text: str, known: set[str] | None = None) -> list[dict] | None:
    """Return OpenAI-shaped tool_calls if *text* is a tool-call object, else None.

    ``known`` restricts calls to the tools actually offered. A hallucinated name
    would otherwise reach Hermes and come back as "No such tool available",
    burning a turn and leaving the agent convinced its tools are broken.
    """
    candidate = (text or "").strip()
    if not candidate:
        return None
    fenced = _FENCE.match(candidate)
    if fenced:
        candidate = fenced.group(1).strip()
    if not candidate.startswith("{"):
        return None

    try:
        payload = json.loads(candidate)
    except json.JSONDecodeError:
        return None
    if not isinstance(payload, dict):
        return None

    raw_calls = payload.get("tool_calls")
    if not isinstance(raw_calls, list) or not raw_calls:
        return None

    calls = []
    for entry in raw_calls:
        if not isinstance(entry, dict):
            continue
        name = entry.get("name") or (entry.get("function") or {}).get("name")
        if not name:
            continue
        args = entry.get("arguments")
        if args is None:
            args = (entry.get("function") or {}).get("arguments")
        if isinstance(args, str):  # already-serialized arguments pass through
            args_json = args
        else:
            args_json = json.dumps(args if isinstance(args, dict) else {}, ensure_ascii=False)
        if known is not None and str(name) not in known:
            logger.warning("dropping hallucinated tool call %r (offered: %d tools)", name, len(known))
            continue
        calls.append({
            "id": f"call_{uuid.uuid4().hex[:24]}",
            "type": "function",
            "function": {"name": str(name), "arguments": args_json},
        })
    return calls or None


def tool_names(tools: list[dict] | None) -> set[str]:
    """Names of the tools offered in this request."""
    names = set()
    for tool in tools or []:
        if not isinstance(tool, dict):
            continue
        fn = tool.get("function") if tool.get("type") == "function" else tool
        if isinstance(fn, dict) and fn.get("name"):
            names.add(str(fn["name"]))
    return names
