"""CLI backend: drives the `claude` binary in headless (`-p`) mode.

Input goes in as stream-json rather than a bare prompt, which is what makes
images possible — but every `user` line in that stream starts its own turn, so
one HTTP request is one user message: either the whole role-labelled
transcript (new CLI session) or only the messages the CLI session has not seen
yet (continued session, see session_cache — that is what lets the history be
read from the prompt cache instead of re-billed on every agent step).
"""

from __future__ import annotations

import logging
import os
import subprocess
import threading
import time
import uuid
from dataclasses import dataclass, field
from typing import Any

import cli_process
import run_notes
import session_cache
import tool_protocol
import transcript
from cli_process import (  # noqa: F401 — прежние имена модуля, их зовут снаружи
    DEFAULT_SYSTEM_PROMPT, HOST_WIN, PING_SECONDS, build_argv, launch_prefix,
    sweep_prompt_files, to_target_path, to_windows_path,
)
from config import BridgeConfig

logger = logging.getLogger("claude_bridge.cli")

split_content = transcript.split_content
build_turn = transcript.build_turn
build_stdin = transcript.build_stdin


# ── process handling ─────────────────────────────────────────

@dataclass
class BridgeResult:
    """Normalized outcome of one CLI turn."""

    text: str
    input_tokens: int = 0
    output_tokens: int = 0
    session_id: str = ""
    model: str = ""
    stop_reason: str = "end_turn"
    tool_calls: list[dict] = field(default_factory=list)
    # Cache split, reported separately because the two have very different
    # prices: writing the cache costs more than plain input, reading it costs a
    # fraction. Summing them into prompt_tokens hides which backend is cheaper.
    cache_read: int = 0
    cache_write: int = 0
    # Размышления модели: Claude шлёт их отдельными блоками, а не текстом
    # ответа. Без них лента показывает только шаги, и между действиями агента
    # видна пустота — непонятно, чем он занят и почему выбрал именно это.
    reasoning: str = ""


@dataclass
class _Plan:
    """Что запускаем и как потом запомнить сессию для продолжения."""

    argv: list[str]
    stdin: str
    prompt_file: str
    session_id: str = ""  # пусто — ход без сохраняемой сессии
    head: str = ""
    lines: list[str] = field(default_factory=list)  # вся переписка запроса


def _result_from_payload(payload: dict, model: str) -> BridgeResult:
    """Normalize the CLI's terminal ``result`` envelope."""
    if payload.get("is_error"):
        raise RuntimeError(f"claude reported an error: {str(payload.get('result'))[:500]}")
    usage = payload.get("usage") or {}
    # Cached tokens are still input tokens on the OpenAI wire; Hermes reads its
    # accounting off prompt_tokens.
    input_tokens = (
        int(usage.get("input_tokens") or 0)
        + int(usage.get("cache_read_input_tokens") or 0)
        + int(usage.get("cache_creation_input_tokens") or 0)
    )
    model_usage = payload.get("modelUsage") or {}
    resolved_model = next(iter(model_usage), "") if isinstance(model_usage, dict) else ""
    return BridgeResult(
        text=str(payload.get("result") or ""),
        input_tokens=input_tokens,
        output_tokens=int(usage.get("output_tokens") or 0),
        session_id=str(payload.get("session_id") or ""),
        model=resolved_model or model,
        stop_reason=str(payload.get("stop_reason") or "end_turn"),
        cache_read=int(usage.get("cache_read_input_tokens") or 0),
        cache_write=int(usage.get("cache_creation_input_tokens") or 0),
    )


# ── continued CLI sessions ───────────────────────────────────

_INDEXES: dict[str, session_cache.SessionIndex] = {}
_INDEX_LOCK = threading.Lock()


def _index(cfg: BridgeConfig) -> session_cache.SessionIndex:
    path = os.path.join(cfg.sessions_dir, "index.json")
    with _INDEX_LOCK:
        if path not in _INDEXES:
            _INDEXES[path] = session_cache.SessionIndex(path)
        return _INDEXES[path]


def _prepare(cfg: BridgeConfig, messages: list[dict], model: str,
             tools: list[dict] | None, tool_choice: Any) -> _Plan:
    system_prompt, entries = transcript.render(messages)
    tool_section = tool_protocol.render_tools(tools or [], tool_choice)
    if tool_section:
        system_prompt = f"{system_prompt}\n\n{tool_section}" if system_prompt else tool_section
    lines = [line for line, _ in entries]

    # Продолжать сессию имеет смысл только там, где разговор идёт дальше:
    # ход агента с инструментами. Разовые служебные запросы (заголовок,
    # пересказ для сжатия) остаются без записи на диск.
    persist = bool(tool_section) and cfg.session_reuse
    head, done, session_id = "", 0, ""
    if persist:
        head = f"{model}\0{cfg.effort}\0{system_prompt}"
        chain = session_cache.prefix_chain(head, lines)
        done, session_id = _index(cfg).take(chain)
        if not done:
            _index(cfg).explain_miss(chain, lines)
        _prune_sessions(cfg)

    fresh = [line for line, _ in entries[done:]]
    # продолжение из одной реплики пользователя всё равно идёт с меткой роли:
    # в сессии уже есть переписка, голый вопрос из неё выпадал бы
    text = "\n\n".join(fresh + ["Assistant:"]) if done else transcript.assemble(fresh)
    if tool_section:
        # Repeated at the END of the turn as well: the CLI wraps the session in
        # its own agent framing, and a protocol stated only in the system prompt
        # loses to that framing — the model answers "I have no weather tool"
        # instead of requesting one.
        #
        # BEFORE the trailing "Assistant:" cue, not after it. With the reminder
        # placed after the cue the model re-emitted the cue itself and answered
        # ``Assistant: {"tool_calls": ...}`` (seen live), which the parser then
        # took for prose — the turn ended with a raw call delivered as the answer.
        text = tool_protocol.insert_reminder(text)
    images = [block for _, blocks in entries[done:] for block in blocks]

    prompt_file = cli_process.write_system_prompt(system_prompt, cfg)
    argv = build_argv(cfg, model, prompt_file)
    if persist:
        if session_id:
            argv += ["--resume", session_id]
        else:
            session_id = str(uuid.uuid4())
            argv += ["--session-id", session_id]
        logger.info("session %s: %s (%d of %d messages already in it)",
                    session_id[:8], "resume" if done else "new", done, len(lines))
    else:
        argv.append("--no-session-persistence")
    if cfg.debug:
        logger.info("spawn: model=%s images=%d tools=%d", model, len(images), len(tools or []))
    return _Plan(argv, transcript.build_stdin(text, images), prompt_file, session_id, head, lines)


def _prune_sessions(cfg: BridgeConfig) -> None:
    """Старые файлы сессий моста — там, где их пишет CLI.

    Мост на Windows запускает claude внутри WSL, и сессии лежат в домашней папке
    WSL, а не Windows: туда можно дотянуться только через тот же wsl.exe."""
    if not session_cache.prune_due():
        return
    slug = session_cache.cli_project_slug(to_target_path(cfg.sessions_dir, cfg))
    if HOST_WIN and cfg.target == "wsl":
        minutes = session_cache.SESSION_TTL_SECONDS // 60
        script = f'find "$HOME/.claude/projects/{slug}" -name "*.jsonl" -mmin +{minutes} -delete 2>/dev/null'
        threading.Thread(target=subprocess.run, daemon=True, args=(["wsl.exe", "-e", "bash", "-lc", script],),
                         kwargs={"capture_output": True, "timeout": 60}).start()
    elif not HOST_WIN and cfg.target == "windows":
        return  # claude.exe хранит сессии в профиле Windows; путь до него отсюда не выводится
    else:
        session_cache.prune_local(os.path.join(os.path.expanduser("~"), ".claude", "projects", slug))


def _remember(cfg: BridgeConfig, plan: _Plan, result: BridgeResult) -> None:
    """Запомнить: переписка запроса + этот ответ = состояние сессии plan.session_id."""
    if not plan.session_id:
        return
    lines = plan.lines + [transcript.reply_line(result.text, result.tool_calls)]
    chain = session_cache.prefix_chain(plan.head, lines)
    _index(cfg).put(chain[-1], plan.session_id)
    _index(cfg).note(plan.session_id, chain, lines)


# ── running the CLI ──────────────────────────────────────────


# ── running the CLI ──────────────────────────────────────────

def _run(cfg: BridgeConfig, messages: list[dict], model: str,
         tools: list[dict] | None, tool_choice: Any):
    """Один запуск CLI. Генератор: отдаёт ("delta"|"reasoning"|"ping", …),
    возвращает BridgeResult — уже с разобранными tool_calls и запомненной сессией."""
    plan = _prepare(cfg, messages, model, tools, tool_choice)
    proc = cli_process.spawn(cfg, plan.argv, plan.stdin, plan.prompt_file)
    final: BridgeResult | None = None
    reasoning: list[str] = []
    try:
        for kind, value in cli_process.events(proc):
            if kind == "result":
                # The last result wins: extra turns would only appear if the
                # CLI split the input, and the closing one is the answer.
                final = _result_from_payload(value, model)
                continue
            if kind == "reasoning":
                reasoning.append(value)
            yield kind, value
    finally:
        code, stderr = cli_process.finish(proc, final is not None)

    if final is None:
        raise RuntimeError(f"claude produced no result (exit {code}): {stderr.strip()[:300]}")
    final.reasoning = "".join(reasoning).strip()
    final = _attach_tool_calls(final, tools)
    _remember(cfg, plan, final)
    return final


def _drain(gen) -> Any:
    """Прогнать генератор _run/_correct_unparsed до конца и вернуть его результат."""
    while True:
        try:
            next(gen)
        except StopIteration as stop:
            return stop.value


# Сколько раз мост сам просит модель переписать неразобранный вызов, прежде
# чем отдать ответ как есть
MAX_CORRECTIONS = 2


def _correct_unparsed(cfg: BridgeConfig, messages: list[dict], model: str,
                      tools: list[dict] | None, tool_choice: Any,
                      result: BridgeResult):
    """Не отдавать Hermes неразобранный вызов как ответ.

    Hermes считает текст без tool_calls концом хода — сессия обрывалась на
    каждой новой форме записи вызова, которую не знал разборщик. Здесь такой
    ответ возвращается модели с поправкой (tool_protocol.CORRECTION), и она
    переписывает вызов в форме протокола. Если модель повторила ответ слово в
    слово — это был настоящий ответ, отдаём его.

    Генератор, как и _run: пока идут повторы, наружу уходят признаки жизни."""
    if not tools:
        return result
    names = tool_protocol.tool_names(tools)
    for attempt in range(MAX_CORRECTIONS):
        if result.tool_calls or not tool_protocol.looks_like_call_attempt(result.text, names):
            return result
        logger.warning("reply looks like an unparsed tool request; asking the model to re-emit it "
                       "(attempt %d): %r", attempt + 1, result.text[:300])
        retry_messages = list(messages) + [
            {"role": "assistant", "content": result.text},
            {"role": "user", "content": tool_protocol.CORRECTION},
        ]
        again = yield from _run(cfg, retry_messages, model, tools, tool_choice)
        again.input_tokens += result.input_tokens
        again.output_tokens += result.output_tokens
        again.cache_read += result.cache_read
        again.cache_write += result.cache_write
        if not again.tool_calls and again.text.strip() == result.text.strip():
            return again
        result = again
    return result


def run_turn(cfg: BridgeConfig, messages: list[dict], model: str,
             tools: list[dict] | None = None, tool_choice: Any = None) -> BridgeResult:
    """Run one headless turn, returning text or parsed tool calls."""
    run_notes.start()
    try:
        final = _drain(_run(cfg, messages, model, tools, tool_choice))
        final = _drain(_correct_unparsed(cfg, messages, model, tools, tool_choice, final))
    finally:
        notes = run_notes.take()
    # вмешательства моста — к размышлениям ответа, чтобы дойти до ленты сессии
    if notes:
        final.reasoning = f"{final.reasoning}\n{notes}".strip()
    return final


def stream_turn(cfg: BridgeConfig, messages: list[dict], model: str,
                tools: list[dict] | None = None, tool_choice: Any = None):
    """Yield ("delta"|"reasoning"|"ping", …) as they arrive, then one ("done", BridgeResult).

    When tools are offered the text deltas are BUFFERED rather than forwarded: a
    tool call arrives as JSON that Hermes must receive as `tool_calls`, not as
    assistant text, and whether the reply is a call is only known once it ends.
    Reasoning and pings are never held back — they are what shows that the turn
    is alive while the model thinks.
    """
    buffering = bool(tools)
    run_notes.start()

    last_sent = [time.monotonic()]

    def relay(gen):
        # yield from с фильтром: текст придерживаем, если ответ может оказаться вызовом.
        # Придержанный текст наружу не уходит, а CLI при этом не молчит — пинги
        # по тишине процесса не срабатывают, и Hermes минутами не видел ни байта,
        # пока модель писала длинный ответ. Поэтому пинг и по тишине наружу.
        while True:
            try:
                kind, value = next(gen)
            except StopIteration as stop:
                return stop.value
            if kind == "delta" and buffering:
                if time.monotonic() - last_sent[0] < cli_process.PING_SECONDS:
                    continue
                kind, value = "ping", None
            last_sent[0] = time.monotonic()
            yield kind, value

    try:
        final = yield from relay(_run(cfg, messages, model, tools, tool_choice))
        final = yield from relay(_correct_unparsed(cfg, messages, model, tools, tool_choice, final))
    finally:
        notes = run_notes.take()
    # размышления уже ушли по ходу — повтор в конце задвоил бы их в ленте.
    # Вмешательства моста — отдельным куском размышлений, своими строками:
    # сервер OpenKarandash показывает их событиями хода (run_notes)
    final.reasoning = ""
    if notes:
        yield ("reasoning", f"\n{notes}\n")
    # Придержанный текст отдаём и тогда, когда ответ оказался вызовом: слова модели
    # перед вызовом («[PLAN] понял так…», пояснение шага) иначе терялись целиком —
    # у Hermes такое сообщение оставалось с пустым content, хотя непотоковый путь
    # (_completion_envelope) прозу рядом с tool_calls отдаёт. В final.text к этому
    # месту уже только проза: вызовы из неё вынул _attach_tool_calls
    if buffering and final.text:
        yield ("delta", final.text)  # held back by the tool buffer
    yield ("done", final)


def _attach_tool_calls(result: BridgeResult, tools: list[dict] | None) -> BridgeResult:
    """Promote a tool-call JSON reply into structured tool_calls.

    A short line of prose in front of the object is kept as the message content:
    an OpenAI assistant message carries text and tool_calls together, and
    dropping the text used to end the turn on an announcement instead of work."""
    if not tools:
        return result
    names = tool_protocol.tool_names(tools)
    prose, calls, note = tool_protocol.split_reply(result.text, names)
    if calls:
        result.tool_calls = calls
        result.text = prose
        result.stop_reason = "tool_use"
    elif note:
        # инструмента нет: ошибку возвращаем модели словами, а не сырым
        # объектом человеку — иначе ход кончается ничем и вызов повторяется
        result.text = f"{prose}\n\n{note}" if prose else note
    return result
