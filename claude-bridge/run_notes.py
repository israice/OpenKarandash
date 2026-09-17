"""Пометки о том, что мост сделал с ответом модели за один запрос.

Мост молча правит то, что написала модель: переспрашивает неразобранный вызов,
поднимает таймаут terminal, выбрасывает несуществующий инструмент, чинит JSON.
Раньше всё это оставалось строкой предупреждения в логе моста, а человек,
глядя на сессию, считал, что видит работу модели как есть.

Источник пометок — те же предупреждения: обработчик логов собирает их, пока
идёт запрос, и ответ уносит их с собой в поле размышлений с подписью
``[claude-bridge]`` (другого канала от моста до ленты через Hermes нет). Сервер
OpenKarandash показывает такие строки отдельными событиями хода
(SYSTEM/core/hermes-history.js, DOCS/decisions/039). Новое предупреждение в
любом модуле моста попадает к человеку само, без правок здесь.

ThreadingHTTPServer отдаёт каждому запросу свой поток, поэтому пометки
держатся в threading.local и не перемешиваются между сессиями.
"""

from __future__ import annotations

import logging
import threading

PREFIX = "[claude-bridge]"
_local = threading.local()


class _Collector(logging.Handler):
    def emit(self, record: logging.LogRecord) -> None:
        notes = getattr(_local, "notes", None)
        if notes is None:
            return
        try:
            text = " ".join(record.getMessage().split())
        except Exception:  # noqa: BLE001 — сломанный формат не должен ронять запрос
            return
        if text and text not in notes:
            notes.append(text)


_collector = _Collector(level=logging.WARNING)
logging.getLogger("claude_bridge").addHandler(_collector)


def start() -> None:
    """Начать сбор пометок для запроса в текущем потоке."""
    _local.notes = []


def take() -> str:
    """Забрать собранное строками с подписью и закончить сбор."""
    notes = getattr(_local, "notes", None) or []
    _local.notes = None
    return "\n".join(f"{PREFIX} {note}" for note in notes)
