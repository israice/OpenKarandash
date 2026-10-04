"""Разбирает свободный запрос по теме проекта: куда он адресован.

Laya отвечает на типизированный вопрос одним проходом. Здесь вопрос один —
в какую работу запрос попадает:

    design   правка макета в Penpot
    code     правка поведения в JS/CSS/HTML
    content  тексты и подписи на макете
    assets   иконки, картинки, шрифты
    question спросить у человека

Работает на чекпойнте typed-decisions: критерии — короткие, как в примерах
README Laya. Русский текст уходит в multilingual через Router.

Порог уверенности обязателен: на своей домене базовый чекпойнт отвечает
неточно (в README Laya — 0.362 на typed-decisions против 0.766 после
дообучения), поэтому ниже MIN_CONFIDENT ответ заменяется на `question`.
Ложный маршрут хуже лишнего уточнения.

    .venv/Scripts/python.exe decide.py "сделай пункт меню выше"
    .venv/Scripts/python.exe decide.py --json "добавь счётчик моделей"

После появления размеченных решений чекпойнт стоит дообучить (README Laya,
fine-tuning): тогда порог можно поднять, а `question` будет встречаться
реже.
"""

import json
import os
import sys

from laya import Router

MIN_CONFIDENT = float(os.environ.get("LAYA_MIN_CONFIDENT", "0.6"))

QUESTIONS = {
    "route": {
        "type": "choice",
        "instructions": "К какой работе относится запрос: правка внешнего вида макета в Penpot, "
                       "правка кода интерфейса, правка текстов, работа с иконками и картинками "
                       "или запрос непонятен.",
        "criteria": {
            "design": "цвет, отступы, радиус, размер, тень, состояние, порядок блоков, макет, "
                      "дизайн, перерисовать, переставить элементы",
            "code": "логика, обработчик, клик, состояние в коде, баг, не работает, ошибка, "
                    "CSS-класс, селектор, рефакторинг, тест",
            "content": "текст, подпись, заголовок, название, формулировка, локализация, "
                       "буква, ошибка в написании",
            "assets": "иконка, картинка, логотип, шрифт, favicon, иллюстрация, гифка",
            "question": "непонятно, уточнить, что именно, где смотреть",
        },
    },
    "confident": {
        "type": "noul",
        "instructions": "В запросе явно назван конкретный объект правки и конкретное действие "
                        "с ним, иначе нужно уточнять у человека.",
    },
}


def main(argv: list[str]) -> int:
    as_json = "--json" in argv
    text = " ".join(a for a in argv if not a.startswith("--")).strip()
    if not text:
        print(__doc__)
        return 2

    result = Router().predict(text, QUESTIONS)
    answer = result["answers"]["route"]["choice"]
    sure = result["answers"]["confident"]["noul"]
    model = result["routing"]["model"]
    gated = sure < MIN_CONFIDENT
    if gated:
        answer = "question"

    if as_json:
        print(json.dumps({
            "route": answer,
            "confident": sure,
            "model": model,
            "gated": gated,
            "min_confident": MIN_CONFIDENT,
        }, ensure_ascii=False))
    else:
        print(f"route     : {answer}{'  (порог не пройден)' if gated else ''}")
        print(f"confident : {sure:.3f} (порог {MIN_CONFIDENT})")
        print(f"model     : {model}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))