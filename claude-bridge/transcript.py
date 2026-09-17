"""Переписка Hermes -> текст для claude CLI.

Каждое сообщение превращается в одну строку-реплику с меткой роли
(``User: …``, ``Tool result (terminal): …``) — это же и единица, по которой
session_cache узнаёт уже отправленное начало переписки. Картинки идут
отдельными блоками рядом с текстом.
"""

from __future__ import annotations

import json
import re
from typing import Any

import tool_protocol

_DATA_URL = re.compile(r"^data:(?P<media>[\w.+/-]+);base64,(?P<data>.+)$", re.DOTALL)

_ROLE_LABELS = {"user": "User", "assistant": "Assistant", "tool": "Tool result", "function": "Tool result"}


def _image_block(url: str) -> dict | None:
    """OpenAI image part -> Anthropic image content block."""
    data_url = _DATA_URL.match(url or "")
    if data_url:
        return {"type": "image", "source": {
            "type": "base64",
            "media_type": data_url.group("media"),
            "data": data_url.group("data").strip(),
        }}
    if url.startswith(("http://", "https://")):
        return {"type": "image", "source": {"type": "url", "url": url}}
    return None


def split_content(content: Any) -> tuple[str, list[dict]]:
    """Split OpenAI message content into (text, image blocks)."""
    if isinstance(content, str):
        return content, []
    if not isinstance(content, list):
        return ("" if content is None else str(content)), []

    texts, images = [], []
    for item in content:
        if not isinstance(item, dict):
            continue
        kind = item.get("type")
        if kind == "text":
            texts.append(str(item.get("text") or ""))
        elif kind == "image_url":
            url = (item.get("image_url") or {}).get("url") if isinstance(item.get("image_url"), dict) else None
            block = _image_block(str(url or ""))
            if block:
                images.append(block)
        elif kind == "input_image":  # Responses-style part, accepted for tolerance
            block = _image_block(str(item.get("image_url") or ""))
            if block:
                images.append(block)
    return "\n".join(t for t in texts if t), images


def _describe_tool_calls(msg: dict) -> str:
    """Render an assistant turn's tool_calls back into the transcript.

    Without this, a tool result in the history has nothing to refer back to and
    the model cannot tell which call produced it.

    Rendered in the SAME shape the protocol asks the model to emit (the
    ``{"tool_calls": [...]}`` object), not as a human-readable
    ``Tool call: name(args)`` line. The model treats its own earlier turns as
    examples: after two tool rounds rendered as prose it answered the third
    round with ``Tool call: terminal({...})`` text, which the parser rejected,
    and the turn ended with tool requests delivered to the user as the answer.
    """
    return tool_protocol.render_tool_calls(msg.get("tool_calls") or [])


def render(messages: list[dict]) -> tuple[str, list[tuple[str, list[dict]]]]:
    """Return (system_prompt, [(строка реплики, её картинки), …])."""
    system_parts, entries = [], []

    for msg in messages or []:
        if not isinstance(msg, dict):
            continue
        role = str(msg.get("role") or "user")
        text, msg_images = split_content(msg.get("content"))

        if role == "system" or role == "developer":
            if text:
                system_parts.append(text)
            continue

        if role == "assistant" and msg.get("tool_calls"):
            described = _describe_tool_calls(msg)
            text = f"{text}\n{described}".strip() if text else described

        if role in ("tool", "function"):
            name = msg.get("name") or msg.get("tool_call_id") or ""
            label = f"Tool result ({name})" if name else "Tool result"
            entries.append((f"{label}: {text}", msg_images))
            continue

        if text or msg_images:
            label = _ROLE_LABELS.get(role, role.title())
            body = text if text else "(see attached image)"
            entries.append((f"{label}: {body}", msg_images))

    return "\n\n".join(p for p in system_parts if p), entries


def assemble(lines: list[str]) -> str:
    """Реплики -> текст одного сообщения CLI.

    A single trailing user message is sent verbatim: an invented "User:"
    wrapper around a lone question only adds noise."""
    if len(lines) == 1 and lines[0].startswith("User: "):
        return lines[0][len("User: "):]
    return "\n\n".join(lines + ["Assistant:"])


def build_turn(messages: list[dict]) -> tuple[str, str, list[dict]]:
    """Return (system_prompt, transcript, image_blocks) for one request."""
    system_prompt, entries = render(messages)
    images = [block for _, blocks in entries for block in blocks]
    return system_prompt, assemble([line for line, _ in entries]), images


def reply_line(text: str, tool_calls: list[dict]) -> str:
    """Строка, которой ответ модели вернётся в следующем запросе Hermes.

    Hermes присылает наш ответ обратно как assistant-сообщение с тем же текстом
    и теми же tool_calls — отрисовываем его тем же путём, что и входящие."""
    msg: dict = {"role": "assistant", "content": text or None}
    if tool_calls:
        msg["tool_calls"] = tool_calls
    _, entries = render([msg])
    return entries[0][0] if entries else ""


def build_stdin(transcript: str, images: list[dict]) -> str:
    """One stream-json `user` line — one turn."""
    content: list[dict] = [{"type": "text", "text": transcript}]
    content.extend(images)
    return json.dumps({"type": "user", "message": {"role": "user", "content": content}}) + "\n"
