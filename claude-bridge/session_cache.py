"""Продолжение сессий claude CLI между запросами Hermes — ради кеша промпта.

Hermes присылает на каждый ход всю переписку заново. Если отдавать её CLI
одним новым сообщением, кеш Anthropic по истории не срабатывает никогда:
кеш совпадает только по границам блоков, а хвост блока (напоминание протокола
и метка ``Assistant:``) каждый раз другой. История при этом не читается из
кеша, а заново в него пишется — дороже обычного ввода, и на 100 тыс. токенов
это ещё и секунды задержки на каждом шаге агента.

Поэтому ход, после которого разговор может продолжиться (запрос с
инструментами), идёт в сохраняемую сессию CLI. Индекс здесь помнит, какой
сессии соответствует какое начало переписки: следующий запрос, который
начинается ровно с этой переписки и ответа на неё, продолжает ту же сессию
(``--resume``) и шлёт только новые сообщения — остальное CLI берёт из своей
записи, и Anthropic отдаёт его из кеша.

Сопоставление — по цепочке хешей отрисованных строк переписки (каждая строка —
одно сообщение в том виде, в каком его видит модель). Любое расхождение
(Hermes сжал контекст, переписал сообщение, сменил системный промпт или
набор инструментов) даёт промах, и ход честно уходит полной перепиской в
новую сессию — так же, как было до этого модуля.

Запись индекса одноразовая: продолженная сессия уже содержит новый ход, и
второй запрос с тем же началом (фоновая проверка Hermes, повтор после сбоя)
получил бы в контексте лишнее. Он получает промах и идёт полной перепиской.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import threading
import time
from collections import OrderedDict

logger = logging.getLogger("claude_bridge.sessions")

# Сколько начал переписки помнить. Одна живая сессия Hermes держит одну запись,
# так что это с запасом покрывает все параллельные сессии.
MAX_ENTRIES = 512

# Файлы сессий CLI старше этого удаляются: к такому разговору Hermes уже не
# вернётся без сжатия контекста, а сжатие всё равно даёт промах.
SESSION_TTL_SECONDS = 24 * 3600
PRUNE_EVERY_SECONDS = 1800


def _digest(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8", "surrogatepass")).hexdigest()


_CALL_MARK = '{"tool_calls": '


def _normalize(line: str) -> str:
    # Пробелы по краям и переводы строк Hermes может хранить не байт в байт —
    # на смысл переписки это не влияет и промаха давать не должно.
    # Короткую фразу перед вызовом инструмента («Выполняю шаг 1.») Hermes
    # обратно не присылает: у ответа с вызовом ключ — только сам вызов.
    if line.startswith("Assistant:") and _CALL_MARK in line:
        line = "Assistant: " + line[line.index(_CALL_MARK):]
    return " ".join(line.split())


def prefix_chain(head: str, lines: list[str]) -> list[str]:
    """Хеши всех начал переписки: [i] — первые i строк (0 — только голова).

    Голова — всё, что делает сессию несовместимой при смене: модель, effort,
    системный промпт вместе с описанием инструментов."""
    chain = [_digest(head)]
    for line in lines:
        chain.append(_digest(chain[-1] + "\0" + _digest(_normalize(line))))
    return chain


class SessionIndex:
    """Начало переписки -> id сессии CLI, с сохранением на диск."""

    def __init__(self, path: str, limit: int = MAX_ENTRIES):
        self.path = path
        self.limit = limit
        self._lock = threading.Lock()
        self._entries: OrderedDict[str, str] = OrderedDict()
        self._recent: OrderedDict[str, tuple[list[str], list[str]]] = OrderedDict()
        self._load()

    def _load(self) -> None:
        try:
            with open(self.path, encoding="utf-8") as fh:
                data = json.load(fh)
            if isinstance(data, dict):
                self._entries.update((str(k), str(v)) for k, v in data.items())
        except (OSError, ValueError):
            pass

    def _save(self) -> None:
        tmp = f"{self.path}.tmp"
        try:
            os.makedirs(os.path.dirname(self.path), exist_ok=True)
            with open(tmp, "w", encoding="utf-8") as fh:
                json.dump(self._entries, fh)
            os.replace(tmp, self.path)
        except OSError as exc:
            logger.warning("session index not saved: %s", exc)

    def explain_miss(self, chain: list[str], lines: list[str]) -> None:
        """Почему не нашлось продолжения: где новая переписка разошлась с записанной.

        Без этого промах выглядит как «new» в логе, и не видно, что именно
        Hermes прислал по-другому — системный промпт или одно из старых сообщений."""
        best, best_common = None, -1
        with self._lock:
            recent = list(self._recent.items())
        for session_id, (old_chain, old_lines) in recent:
            common = 0
            for a, b in zip(old_chain, chain):
                if a != b:
                    break
                common += 1
            if common > best_common:
                best, best_common = (session_id, old_chain, old_lines), common
        if best is None:
            return
        session_id, old_chain, old_lines = best
        if best_common == 0:
            logger.info("no resume: system prompt/tools differ from session %s", session_id[:8])
            return
        at = best_common - 1  # индекс первой различающейся строки
        if at == 0 or at >= len(old_lines) or at >= len(lines):
            return  # другой разговор с тем же системным промптом — не промах
        logger.info("no resume: session %s matched %d messages, message %d differs:\n  was: %r\n  now: %r",
                    session_id[:8], at, at, old_lines[at][:300], lines[at][:300])

    def note(self, session_id: str, chain: list[str], lines: list[str]) -> None:
        """Запомнить последнюю переписку сессии — только для explain_miss."""
        with self._lock:
            self._recent[session_id] = (chain, lines)
            self._recent.move_to_end(session_id)
            while len(self._recent) > 16:
                self._recent.popitem(last=False)

    def take(self, chain: list[str]) -> tuple[int, str]:
        """Самое длинное известное начало, оставляющее хотя бы одно новое сообщение.

        Возвращает (сколько строк уже есть в сессии, id сессии) или (0, "")."""
        with self._lock:
            for count in range(len(chain) - 2, 0, -1):
                session_id = self._entries.pop(chain[count], None)
                if session_id:
                    self._save()
                    return count, session_id
        return 0, ""

    def put(self, key: str, session_id: str) -> None:
        with self._lock:
            self._entries[key] = session_id
            self._entries.move_to_end(key)
            while len(self._entries) > self.limit:
                self._entries.popitem(last=False)
            self._save()


def cli_project_slug(cwd: str) -> str:
    """Имя папки, в которую claude CLI пишет сессии, запущенные в ``cwd``
    (путь в том виде, как его видит сам CLI)."""
    return re.sub(r"[^A-Za-z0-9]", "-", cwd)


_last_prune = 0.0


def prune_due() -> bool:
    """Пора ли чистить старые сессии — не чаще раза в полчаса."""
    global _last_prune
    now = time.time()
    if now - _last_prune < PRUNE_EVERY_SECONDS:
        return False
    _last_prune = now
    return True


def prune_local(folder: str) -> None:
    """Удалить файлы сессий старше SESSION_TTL_SECONDS в папке на этой же стороне."""
    now = time.time()
    try:
        names = os.listdir(folder)
    except OSError:
        return
    removed = 0
    for name in names:
        if not name.endswith(".jsonl"):
            continue
        path = os.path.join(folder, name)
        try:
            if now - os.path.getmtime(path) > SESSION_TTL_SECONDS:
                os.unlink(path)
                removed += 1
        except OSError:
            continue
    if removed:
        logger.info("pruned %d stale CLI session files", removed)
