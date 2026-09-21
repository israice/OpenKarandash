# Browser

Управление браузером для агентов проекта через [jev-ultrafast](https://github.com/browser-use/jev-ultrafast) (browser-use): одна цель словами, Jev от TypeSafe выбирает действие и элемент за один запрос, малая модель пишет текст только для `TYPE_TEXT`.

## Где что лежит

- `jev-ultrafast/` в корне проекта — чужой код, клонируется сюда сам (`git clone --depth 1`), в git не хранится (`.gitignore`) и в карту проекта не попадает (`SYSTEM/core/scan.js`). Так же устроен `hermes/`.
- `PROJECTS/Browser/` — только наша обвязка и это описание.

## Установка

```
git clone --depth 1 https://github.com/browser-use/jev-ultrafast.git jev-ultrafast
cd jev-ultrafast && uv sync
```

Внутри контейнера Hermes окружение Python держат вне смонтированной папки проекта (9p медленный): `UV_PROJECT_ENVIRONMENT=/opt/data/venvs/jev-ultrafast uv sync`, и так же при каждом `uv run`.

## Ключи

- `TYPESAFE_API_KEY` — уже есть в `.env` проекта (его же использует `SYSTEM/core/typesafe.js`).
- `TEXT_MODEL_API_KEY` — ключ OpenRouter для генерации текста; в `.env` проекта его пока нет. Остальное (`TYPESAFE_MODEL`, `TEXT_MODEL_BASE_URL`, `TEXT_MODEL`, `TEXT_MODEL_REASONING`) — по `jev-ultrafast/.env.example`.

## Запуск

Из корня клона: `uv run --env-file <путь к .env проекта> python examples/run.py --url <адрес> --goal '<цель словами>'`. Инспектор с шагами — `uv run jev`, открывается на http://127.0.0.1:8766.

## Ограничения

Нужен Chrome с включённой удалённой отладкой; он стоит на Windows, а Hermes работает в контейнере, поэтому из контейнера до него нужен отдельный мост (не сделан). Без моста запуск — на стороне Windows. Рамки самого инструмента: нет теневых корней, фреймов, canvas, загрузки файлов; `DONE` не доказывает успех, итог надо проверять отдельно. Проверено: пакет ставится, 31 офлайн-тест проходит. С настоящим браузером и моделями не запускался.
