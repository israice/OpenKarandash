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

import ast
import difflib
import json
import logging
import re
import uuid
from typing import Any

# A fenced ```json block, or a bare object — the two shapes models actually emit.
logger = logging.getLogger("claude_bridge.tools")

_FENCE = re.compile(r"^\s*```(?:json)?\s*(.*?)\s*```\s*$", re.DOTALL)

# Разбор JSON, терпимый к «сырому» control-символу внутри строкового литерала.
# Живой случай: длинный аргумент write_file (весь файл текстом), модель на
# середине потеряла экранирование переноса строки — вместо `\n` ушёл настоящий
# байт 0x0A внутри JSON-строки. Строгий json.loads такое отвергает целиком
# («Bad control character in string literal»), и весь запрос — с уже готовым
# вызовом write_file — уходил человеку сырым текстом, обрывая ход (сессия
# hermes-docker-mu4uiwpq). strict=False разрешает буквальные control-символы
# в строках и ничего не стоит, когда вход и так был правильным.
_STRICT_DECODER = json.JSONDecoder()
_LENIENT_DECODER = json.JSONDecoder(strict=False)


def _loads(text: str) -> Any:
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return json.loads(text, strict=False)


def _raw_decode(text: str, idx: int = 0) -> tuple[Any, int]:
    try:
        return _STRICT_DECODER.raw_decode(text, idx)
    except json.JSONDecodeError:
        return _LENIENT_DECODER.raw_decode(text, idx)


PROTOCOL_INSTRUCTIONS = """
# Tool request protocol — READ THIS FIRST

You are the reasoning half of a larger system. You do NOT execute tools and you
have NO tool runtime of your own in this session — ignore any built-in tooling
you would normally have. Instead, the system below EXECUTES tools on your
behalf when you REQUEST them.

Requesting a tool is done by writing a JSON object — that JSON *is* the call.
It always works; there is no situation where a listed tool is unavailable to
you.

To request one or more tools, END your reply with this object, on its own line,
with nothing after it — no markdown fence, no closing remark:

{"tool_calls": [{"name": "<tool name>", "arguments": {<arguments object>}}]}

Rules:
- "arguments" must be a JSON object matching that tool's parameter schema.
  Put every argument inside it — never beside "name".
- The reply is that OBJECT, with the "tool_calls" key. A bare list of calls is
  not the protocol.
- Emit several entries only when the calls are independent of each other.
- Never say you lack access to a listed tool, and never tell the user to look
  the answer up elsewhere — request the tool instead.
- A short sentence about what you are doing may come BEFORE the object; the
  object still has to be the last thing in the reply. Saying you will do
  something and stopping there ends your turn without doing it.
- When the task genuinely needs no tool, answer in plain text alone.
- Never invent a tool that is not listed.

## Tools you may request
""".strip()

# Поправка, которую мост сам отправляет модели, когда её ответ похож на вызов
# инструмента, но ни один разборщик его не взял. Раньше такой ответ уходил в
# Hermes обычным текстом — и ход заканчивался: каждая новая форма записи
# (``execute_code(code=...)``, ``name\nRequest\n{...}``, битый JSON) обрывала
# сессию, пока под неё не допишут очередной разборщик. Поправка закрывает весь
# класс сразу: модель переписывает вызов в форме протокола, и ход идёт дальше.
CORRECTION = (
    "[Bridge notice: your previous reply looks like a tool request, but it is not "
    "in the protocol format, so NOTHING was executed. If you meant to call a tool, "
    "reply again with ONLY the object "
    '{"tool_calls": [{"name": "<tool>", "arguments": {...}}]} — valid JSON with '
    "escaped strings; no function-call syntax like name(arg=...), no labels, no "
    "code fence. If that reply was your final answer to the user, repeat it unchanged.]"
)

REMINDER = (
    "[Protocol reminder: to use a tool, END this reply with the JSON object "
    '{"tool_calls": [{"name": ..., "arguments": {...}}]} on its own line. '
    "Announcing a plan without that object ends your turn without doing it.]"
)


# The cue cli_backend.build_turn closes a multi-message transcript with; the
# reminder must land before it so the model's reply starts right after the cue.
ASSISTANT_CUE = "\n\nAssistant:"

# A role label the model sometimes copies from the transcript in front of its
# own reply — stripped before parsing, never treated as prose.
_ROLE_PREFIX = re.compile(r"^\s*(?:Assistant|Model)\s*:\s*", re.IGNORECASE)

# Такое же эхо, только не метки роли, а самого напоминания о протоколе: оно
# стоит последней строкой запроса, и модель копирует его к себе в ответ перед
# объектом вызова (видели живьём: ход оборвался, сырой вызов ушёл человеку).
# Ловим строку целиком: от «[Protocol reminder» до последней скобки в этой же
# строке. Не до первой — внутри самого напоминания есть пример вызова со
# своими скобками, и остановка на первой оставила бы половину эха в тексте.
_REMINDER_ECHO = re.compile(r"^[ \t]*\[[ \t]*Protocol reminder\b.*\][ \t]*$", re.IGNORECASE | re.MULTILINE)


def insert_reminder(transcript: str) -> str:
    """Append REMINDER to a transcript, keeping the trailing ``Assistant:`` cue last."""
    if transcript.endswith(ASSISTANT_CUE):
        return f"{transcript[:-len(ASSISTANT_CUE)]}\n\n{REMINDER}{ASSISTANT_CUE}"
    return f"{transcript}\n\n{REMINDER}"


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


def render_tool_calls(tool_calls: list[dict]) -> str:
    """Serialize OpenAI tool_calls into the protocol's request object — the text
    the model would have written itself. Used to replay history."""
    entries = []
    for call in tool_calls or []:
        fn = call.get("function") or {}
        if not fn.get("name"):
            continue
        raw = fn.get("arguments") or "{}"
        try:
            args = json.loads(raw) if isinstance(raw, str) else raw
        except json.JSONDecodeError:
            args = {"_raw": raw}
        # ключи аргументов по алфавиту: Hermes возвращает наш же вызов с
        # отсортированными ключами, и без этого одна и та же история
        # отрисовывалась по-разному — продолжение сессии CLI промахивалось
        args = json.loads(json.dumps(args, sort_keys=True)) if isinstance(args, dict) else {}
        entries.append({"name": fn["name"], "arguments": args})
    return json.dumps({"tool_calls": entries}, ensure_ascii=False) if entries else ""


# Drift shape: ``Tool call: name({...})`` — one per line, or several joined by
# ``;`` after a single ``Tool call:`` (the form the bridge itself used to replay
# history in, which the model then learned). Parse it rather than hand it to the
# user as prose.
_DRIFT_CALL = re.compile(
    r"([A-Za-z0-9_.-]+)\s*\((\{.*?\})\)\s*(?=;|[A-Za-z0-9_.-]+\s*\(\{|$)", re.DOTALL
)


def _repair_brackets(candidate: str) -> str:
    """Достроить пропущенные закрывающие скобки, не трогая данные.

    Модель теряет скобку и в конце, и в середине: живьём приходило
    ``…"context": 8}]}`` — закрыт объект аргументов, а объект самого вызова нет,
    и весь запрос уходил человеку текстом, обрывая ход. Идём по строке со
    стеком открытых скобок (содержимое строковых литералов пропускаем): чужая
    закрывающая закрывает всё, что осталось незакрытым до неё, а хвост стека
    дописывается в конце. Данные при этом остаются как есть — меняется только
    структура, поэтому починенное можно смело разбирать."""
    out = []
    stack = []
    in_string = False
    escaped = False
    closer = {"{": "}", "[": "]"}
    for char in candidate:
        if in_string:
            out.append(char)
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            continue
        if char == '"':
            in_string = True
            out.append(char)
            continue
        if char in "{[":
            stack.append(closer[char])
            out.append(char)
            continue
        if char in "}]":
            while stack and stack[-1] != char:
                out.append(stack.pop())  # пропущенная закрывающая — дописываем сами
            if stack:
                stack.pop()
                out.append(char)
            continue
        out.append(char)
    while stack:
        out.append(stack.pop())
    return "".join(out)


def _repair_truncated(candidate: str) -> dict | None:
    """A long request object with its last closing bracket(s) dropped by the model
    (seen live: a 1.1k-char ``{"tool_calls": [...]`` missing the final ``}``).
    Append the missing closers, at most a few, and accept only a well-formed
    request object — anything else stays prose."""
    bare_list = candidate.startswith('[{"name"') or candidate.startswith("[{'name'")
    if not candidate.startswith('{"tool_calls"') and not bare_list:
        return None
    for suffix in ("}", "]", "}]", "]}", "}]}", "}}]}"):
        try:
            payload = _loads(candidate + suffix)
        except json.JSONDecodeError:
            continue
        repaired = _normalize_payload(payload)
        if repaired is not None and isinstance(repaired.get("tool_calls"), list):
            logger.warning("tool-call request was truncated; repaired with %r", suffix)
            return repaired
    return None


def _normalize_payload(payload: Any) -> dict | None:
    """Свести разобранный JSON к объекту запроса.

    Форма протокола одна, но модель её варьирует: видели голый список вызовов
    (``[{"name": …, "arguments": {…}}, …]``) без обёртки — целая сессия встала,
    потому что такой ответ ушёл человеку сырым. Список вызовов — это тот же
    запрос, распознаём и его; лишние имена всё равно отсеет ``known``."""
    if isinstance(payload, dict):
        return payload
    if isinstance(payload, list) and payload and all(
            isinstance(item, dict) and (item.get("name") or (item.get("function") or {}).get("name"))
            for item in payload):
        logger.warning("tool calls arrived as a bare list; wrapped into a request object")
        return {"tool_calls": payload}
    return None


# Служебные ключи строки вызова: всё остальное рядом с ними — это разложенные
# аргументы (видели ``{"name": "terminal", "command": "…"}`` вместо
# ``"arguments": {"command": "…"}``).
_CALL_KEYS = {"name", "arguments", "id", "call_id", "type", "function"}


def _inline_arguments(entry: dict) -> dict:
    """Аргументы, разложенные прямо в объекте вызова, вместо ``arguments``."""
    return {k: v for k, v in entry.items() if k not in _CALL_KEYS}


# Метка регистронезависимая: живьём видели и «Tool call:», и «tool call:» —
# сравнение строкой ловило только точный регистр и отбрасывало вызов как прозу.
_TOOL_CALL_LABEL = re.compile(r"(?i)tool call:")


def _parse_drift(candidate: str) -> dict | None:
    """Bare ``name({...})`` call(s), with or without a ``Tool call:`` label.

    Seen live both ways: labelled (``Tool call: foo({...})``, the form history
    replay used, which the model then learned) and bare — session mu4me2k5
    stalled on a reply that was nothing but ``search_files({...})``, no label
    at all. Either way the reply must be nothing but calls: prose around them
    means the model was talking, not requesting.
    """
    body = _TOOL_CALL_LABEL.sub(";", candidate) if _TOOL_CALL_LABEL.match(candidate) else candidate
    entries = []
    for name, args in _DRIFT_CALL.findall(body):
        try:
            entries.append({"name": name, "arguments": json.loads(args)})
        except json.JSONDecodeError:
            return None
    leftover = _DRIFT_CALL.sub("", body).replace(";", "").strip()
    if not entries or leftover:
        return None
    return {"tool_calls": entries}


# Четвёртый дрейф: ``-name: X\narguments: {...}`` — YAML-подобная форма без
# скобок вокруг вызова и без фигурной обёртки протокола, одна или несколько
# записей подряд (session mu4me2k5 встала именно на паре таких записей —
# search_files и следом read_file). ``raw_decode`` сам разбирает JSON
# аргументов, поэтому переносы строк и вложенные скобки внутри не ломают разбор.
_YAML_ENTRY = re.compile(r"-?\s*name:\s*(?P<name>\S+)\s*\n\s*arguments:\s*", re.IGNORECASE)


def _parse_yaml_style(candidate: str) -> dict | None:
    entries = []
    pos = 0
    while True:
        m = _YAML_ENTRY.match(candidate, pos)
        if not m:
            break
        try:
            args, end = _raw_decode(candidate, m.end())
        except json.JSONDecodeError:
            return None
        entries.append({"name": m.group("name"), "arguments": args if isinstance(args, dict) else {}})
        pos = end
        while pos < len(candidate) and candidate[pos] in " \t\r\n":
            pos += 1
    # весь ответ обязан состоять из записей: проза до/после/между значит, что
    # модель говорила, а не просила вызов
    if not entries or candidate[pos:].strip():
        return None
    return {"tool_calls": entries}


# Пятый дрейф: имя инструмента само по себе первой строкой, затем произвольная
# короткая подпись на любом языке («Запрос:», «Request:», …) и сразу объект —
# без «arguments:» и без обёртки {"name":...}: объект тут и есть аргументы.
# Живой пример из этой же сессии: ``execute_code\nЗапрос: {"code": "..."}\n``.
# Разбираем только когда первая строка — это ИМЯ ПРЕДЛОЖЕННОГО инструмента
# (иначе любая короткая фраза вида «Слово: {...}» превратится в вызов), и
# остаток целиком — этот один JSON-объект без хвоста.
_NAME_LINE = re.compile(r"^[ \t]*([A-Za-z_][A-Za-z0-9_.-]*)[ \t]*:?[ \t]*\r?\n")
_SHORT_LABEL = re.compile(r"^[ \t]*[^\n:{\[]{0,24}:[ \t]*")
# Та же подпись, но без двоеточия, отдельной строкой — живой случай, который
# оборвал сессию: ``execute_code\nRequest\n\n{...}``. Слово "Request" без
# ":" не совпадает с _SHORT_LABEL (тот требует двоеточие на этой же строке),
# разбор проваливался, и готовый вызов (execute_code с валидным JSON внутри)
# уходил человеку сырым текстом вместо исполнения.
# И в одну строку: ``execute_code Request  {...}`` (сессия mu4w0wf6)
_NAME_INLINE_REQUEST = re.compile(r"^[ \t]*([A-Za-z_][A-Za-z0-9_.-]*)[ \t]+Request:?[ \t]*(?=[{\[\r\n])")
_BARE_LABEL_LINE = re.compile(r"^[ \t]*[^\n:{\[]{1,24}\r?\n")


def _parse_name_then_json(candidate: str, known: set[str] | None) -> dict | None:
    if not known:
        return None
    m = _NAME_LINE.match(candidate) or _NAME_INLINE_REQUEST.match(candidate)
    if not m:
        return None
    real = _match_known(m.group(1), known)
    if real is None:
        return None
    rest = candidate[m.end():]
    # снимаем сколько угодно коротких строк-подписей перед объектом (не одну
    # как раньше): модель то пишет "Request:", то просто "Request" отдельной
    # строкой, то оставляет пустую строку перед {.
    for _ in range(4):
        stripped = rest.lstrip()
        if stripped[:1] in "{[":
            rest = stripped
            break
        label = _SHORT_LABEL.match(stripped) or _BARE_LABEL_LINE.match(stripped)
        if not label:
            rest = stripped
            break
        rest = stripped[label.end():]
    try:
        args, end = _raw_decode(rest)
    except json.JSONDecodeError:
        return None
    if rest[end:].strip() or not isinstance(args, dict):
        return None
    return {"tool_calls": [{"name": real, "arguments": args}]}


def _parse_python_call(candidate: str, known: set[str] | None) -> dict | None:
    """Вызов, записанный как Python: ``execute_code(code="...")``.

    Живой случай: сессия hermes-docker-mu4wyl0n закончилась ответом, который
    целиком был ``execute_code(code="from hermes_tools import …")`` — ни JSON,
    ни ``name({...})``. Разбираем через ast: только вызовы предложенных
    инструментов, только именованные аргументы-литералы; всё остальное (код с
    выражениями, позиционные аргументы) остаётся прозой."""
    if not known:
        return None
    try:
        tree = ast.parse(candidate.strip(), mode="exec")
    except (SyntaxError, ValueError):
        return None
    entries = []
    for node in tree.body:
        call = node.value if isinstance(node, ast.Expr) else None
        if not isinstance(call, ast.Call) or not isinstance(call.func, ast.Name) or call.args:
            return None
        name = _match_known(call.func.id, known)
        if name is None:
            return None
        args = {}
        for kw in call.keywords:
            if kw.arg is None:
                return None
            try:
                args[kw.arg] = ast.literal_eval(kw.value)
            except (ValueError, SyntaxError):
                return None
        entries.append({"name": name, "arguments": args})
    if not entries:
        return None
    logger.warning("tool call written as a Python call; parsed")
    return {"tool_calls": entries}


# Нижняя граница таймаута terminal. Модель сама ставит 30–60 с, а медленные
# команды на смонтированном проекте идут дольше (git status из контейнера —
# около 90 с): команда убивалась на полпути, ход тратился на повторы. Hermes
# возвращает результат сразу по завершении команды, так что большой таймаут
# ничего не стоит быстрым командам. 600 — предел переднего плана у Hermes.
TERMINAL_TIMEOUT_FLOOR = 600


def _lift_terminal_timeout(name: str, args: Any) -> Any:
    if name != "terminal":
        return args
    parsed = args
    if isinstance(args, str):
        try:
            parsed = json.loads(args)
        except json.JSONDecodeError:
            return args
    if not isinstance(parsed, dict):
        return args
    timeout = parsed.get("timeout")
    if isinstance(timeout, (int, float)) and not isinstance(timeout, bool) and timeout < TERMINAL_TIMEOUT_FLOOR:
        # предупреждение, а не молчаливая правка: оно же уходит пометкой в ленту (run_notes)
        logger.warning("terminal timeout raised from %s to %s seconds", timeout, TERMINAL_TIMEOUT_FLOOR)
        return {**parsed, "timeout": TERMINAL_TIMEOUT_FLOOR}
    return args


# Строка, которая начинается с имени предложенного инструмента и дальше похожа
# на вызов: скобка, фигурная скобка, подпись «Request» или конец строки.
def _call_line(known: set[str]) -> re.Pattern:
    names = "|".join(sorted((re.escape(n) for n in known), key=len, reverse=True))
    return re.compile(rf"(?m)^[ \t`*]*(?:{names})[`*]*[ \t]*(?:\(|\{{|:?[ \t]*\r?\n[ \t]*(?:\{{|Request\b)|[ \t]+Request\b)")


def looks_like_call_attempt(text: str, known: set[str] | None) -> bool:
    """Ответ, в котором модель явно пыталась вызвать инструмент, но разбор не
    удался. Ложное срабатывание стоит одного лишнего запроса (модель повторит
    ответ), пропуск — оборванной сессии, поэтому граница скорее широкая."""
    body = _strip_echo(text or "")
    if not body:
        return False
    if re.search(r"""["']tool_calls["']""", body):
        return True
    if re.search(r'(?m)^[ \t]*[\[{][ \t]*\{?[ \t]*"(?:name|arguments)"[ \t]*:', body):
        return True
    return bool(known) and bool(_call_line(known).search(body))


def _strip_echo(text: str) -> str:
    """Снять с ответа служебное эхо: метку роли и скопированное напоминание.

    И то и другое стоит в конце запроса, поэтому модель повторяет их перед
    собственным ответом. Прозой это не является — иначе разборщик отдал бы
    сырой вызов человеку и оборвал ход."""
    # Метка и напоминание идут в любом порядке («Assistant: [Protocol…]» и
    # наоборот), поэтому чистим по кругу, пока текст укорачивается.
    cleaned = (text or "").strip()
    for _ in range(4):
        shorter = _ROLE_PREFIX.sub("", cleaned, count=1).strip()
        shorter = _REMINDER_ECHO.sub(" ", shorter).strip()
        if shorter == cleaned:
            break
        cleaned = shorter
    return cleaned


def _decode_leading_object(candidate: str) -> dict | None:
    """Разобрать объект в начале строки, даже если за ним остался хвост.

    Хвост допускается только служебный (то же эхо, повторная метка роли,
    закрывающий фенс) — прозу после вызова считаем разговором, а не запросом."""
    try:
        payload, end = _raw_decode(candidate)
    except json.JSONDecodeError:
        return None
    tail = _strip_echo(candidate[end:]).strip().strip("`").strip()
    if tail:
        return None
    return payload if isinstance(payload, dict) else None


def parse_tool_calls(text: str, known: set[str] | None = None) -> list[dict] | None:
    """Return OpenAI-shaped tool_calls if *text* is a tool-call object, else None.

    ``known`` restricts calls to the tools actually offered. A hallucinated name
    would otherwise reach Hermes and come back as "No such tool available",
    burning a turn and leaving the agent convinced its tools are broken.
    """
    calls = _parse_tool_calls(text, known)
    if calls is None:
        _warn_if_missed(text)
    return calls


def _warn_if_missed(text: str) -> None:
    """Ответ, в котором вызов явно был, но разобрать его не удалось, обрывает ход
    молча: сырой объект уходит человеку вместо работы. Виден такой случай только
    в журнале, поэтому пишем его громко — по нему чинится следующий дрейф."""
    probe = _strip_echo(text or "")
    if '"tool_calls"' in (text or "") or (probe[:1] in "[{" and '"name"' in probe[:400]):
        logger.warning("reply looks like a tool request but did not parse; delivered as prose: %r", probe[:400])


def _canon(name: str) -> str:
    """Имя без того, чем модель обычно ошибается: регистр и разделители."""
    return re.sub(r"[-_. ]", "", str(name).lower())


def _match_known(name: str, known: set[str]) -> str | None:
    """Подобрать настоящее имя инструмента для того, что назвала модель.

    Промах чаще всего косметический: другой разделитель или регистр
    (``hermes-agent`` вместо ``hermes_agent``), реже — опечатка. Такой вызов
    исполним, и молча его терять нельзя: ход закончится ничем.
    Совсем чужое имя (``process_manage`` при 32 предложенных) не подгоняем —
    близкое по буквам, но не тот инструмент хуже честной ошибки."""
    if name in known:
        return name
    canon = {_canon(k): k for k in known}
    hit = canon.get(_canon(name))
    if hit:
        logger.warning("tool %r matched offered %r by name shape", name, hit)
        return hit
    close = difflib.get_close_matches(_canon(name), list(canon), n=1, cutoff=0.9)
    if close:
        hit = canon[close[0]]
        logger.warning("tool %r taken as offered %r (close match)", name, hit)
        return hit
    return None


def unknown_tool_note(dropped: list[str], known: set[str]) -> str:
    """Сообщение модели о том, что названного инструмента нет.

    Раньше такой вызов просто отбрасывался: список вызовов пустел, весь объект
    уходил человеку текстом, а модель об ошибке не узнавала и звала то же самое
    снова — в журнале ``process_manage`` подряд три хода. Ответ ассистента она
    увидит на следующем ходу, поэтому ошибку возвращаем ей словами, вместе со
    списком настоящих имён."""
    missing = ", ".join(sorted(set(dropped)))
    offered = ", ".join(sorted(known))
    return (f"No such tool: {missing}. Nothing was executed. "
            f"Available tools: {offered}. "
            "Request one of these instead.")


def _parse_tool_calls(text: str, known: set[str] | None = None,
                      dropped: list[str] | None = None) -> list[dict] | None:
    candidate = _strip_echo(text or "")
    if not candidate:
        return None
    fenced = _FENCE.match(candidate)
    if fenced:
        candidate = _strip_echo(fenced.group(1))
    if candidate[0] not in "{[":
        payload = (_parse_drift(candidate) or _parse_yaml_style(candidate)
                   or _parse_name_then_json(candidate, known)
                   or _parse_python_call(candidate, known))
        if payload is None:
            return None
    else:
        try:
            payload = _loads(candidate)
        except json.JSONDecodeError:
            payload = _decode_leading_object(candidate) or _repair_truncated(candidate)
            if payload is None:
                # последняя попытка: достроить структуру и разобрать заново
                repaired = _repair_brackets(candidate)
                if repaired != candidate:
                    try:
                        payload = _loads(repaired)
                    except json.JSONDecodeError:
                        payload = _decode_leading_object(repaired)
                    if payload is not None:
                        logger.warning("tool-call JSON had unbalanced brackets; repaired")
            if payload is None:
                return None
    payload = _normalize_payload(payload)
    if payload is None:
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
        if args is None:
            # аргументы разложены рядом с именем, а не в «arguments»
            inline = _inline_arguments(entry)
            if inline:
                logger.warning("call %r carried inline arguments; folded into arguments", name)
                args = inline
        if known is not None:
            real = _match_known(str(name), known)
            if real is None:
                logger.warning("dropping hallucinated tool call %r (offered: %d tools)", name, len(known))
                if dropped is not None:
                    dropped.append(str(name))
                continue
            name = real
        args = _lift_terminal_timeout(str(name), args)
        if isinstance(args, str):  # already-serialized arguments pass through
            args_json = args
        else:
            args_json = json.dumps(args if isinstance(args, dict) else {}, ensure_ascii=False)
        calls.append({
            "id": f"call_{uuid.uuid4().hex[:24]}",
            "type": "function",
            "function": {"name": str(name), "arguments": args_json},
        })
    return calls or None


# Начало строки, с которого может начинаться хвостовой блок запроса: сам
# объект протокола ({/[), дрейф-форма с меткой «Tool call:», или YAML-форма
# «-name: X» — без всех трёх вызов, идущий ПОСЛЕ пояснения модели («Сейчас
# проверю файл.\n\nname: search_files\narguments: {...}»), не находился вовсе:
# единственная попытка разобрать весь ответ целиком проваливалась из-за
# пояснения-прозы перед меткой, а этот хвостовой проход искал только { или [
# и метку в начале строки не видел — весь объект уходил человеку текстом
# вместо исполнения (живой репорт, вариант YAML-формы session mu4me2k5).
_BLOCK_START = re.compile(r"(?mi)^[ \t]*(?:[\[{]|tool call:|-?\s*name:\s*\S|[A-Za-z_][\w.-]*\s*\(\s*(?:\{|[A-Za-z_]\w*\s*=)|[A-Za-z_][\w.-]*[ \t]+Request\b)")
# открывающий фенс, оставшийся в пояснении перед блоком
_OPEN_FENCE_TAIL = re.compile(r"```(?:json)?[ \t]*$")


def split_reply(text: str, known: set[str] | None = None) -> tuple[str, list[dict] | None, str | None]:
    """Разделить ответ на пояснение и запрос инструментов.

    Модель разговорная: она пишет «продолжаю, сейчас сделаю…» и следом объект
    вызова. Требование «или текст, или объект» превращало такой ответ в речь —
    ход заканчивался обещанием, работа не делалась (так вставала сессия
    hermes-docker-mtqx7psv). Между тем OpenAI-ответ несёт и текст, и вызовы
    одновременно, так что терять нечего: пояснение отдаём как текст, объект —
    как вызовы.

    Блок засчитывается, только когда он начинается со своей строки и им ответ
    заканчивается: объект внутри фразы остаётся примером, а не запросом.

    Третьим значением возвращается замечание для модели: вызов разобрался, но
    названного инструмента нет и подобрать настоящий не вышло. Исполнять нечего,
    а молчать нельзя — иначе ход кончается ничем и модель зовёт то же самое
    снова.
    """
    cleaned = _strip_echo(text or "")
    # без внешней обёртки: жалоба в журнал пишется один раз, в самом конце —
    # когда не разобрался ни целый ответ, ни ответ с пояснением впереди
    dropped: list[str] = []
    prose_before = ""
    calls = _parse_tool_calls(cleaned, known, dropped)
    if calls:
        return "", calls, None
    for match in reversed(list(_BLOCK_START.finditer(cleaned))):
        if match.start() == 0:
            continue  # это и есть «весь ответ — вызов», уже проверено выше
        tail_dropped: list[str] = []
        calls = _parse_tool_calls(cleaned[match.start():], known, tail_dropped)
        if not calls:
            if tail_dropped:
                dropped.extend(tail_dropped)
                # пояснение перед несуществующим вызовом сохраняем: замечание
                # дописывается к нему, а не заменяет собой всё сказанное
                before = _OPEN_FENCE_TAIL.sub("", cleaned[:match.start()].rstrip()).rstrip()
                if before:
                    prose_before = before
            continue
        prose = _OPEN_FENCE_TAIL.sub("", cleaned[:match.start()].rstrip()).rstrip()
        if not prose:
            continue
        logger.warning("reply mixed prose with a tool request; both are kept")
        return prose, calls, None
    if dropped and known:
        return prose_before, None, unknown_tool_note(dropped, known)
    _warn_if_missed(cleaned)
    return cleaned, None, None


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
