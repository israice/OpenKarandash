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

- `TYPESAFE_API_KEY` — лежит в `.env` проекта (его же использует `SYSTEM/core/typesafe.js`).
- `TEXT_MODEL_API_KEY` — ключ OpenRouter для генерации текста, лежит в `.env` проекта.
- Остальное (`TYPESAFE_MODEL`, `TEXT_MODEL_BASE_URL`, `TEXT_MODEL`, `TEXT_MODEL_REASONING`) — по `jev-ultrafast/.env.example`. Экономия: `TEXT_MODEL` держим на free-модели OpenRouter (`nvidia/nemotron-3.5-lightning:free`), `TEXT_MODEL_BASE_URL=https://openrouter.ai/api/v1`. `TEXT_MODEL_BASE_URL` обязателен: без него jev по умолчанию уходит в `api.deepseek.com` и падает с 401.

## Запуск

Из корня клона: `uv run --env-file <путь к .env проекта> python examples/run.py --url <адрес> --goal '<цель словами>'`. Инспектор с шагами — `uv run jev`, открывается на http://127.0.0.1:8766.

## Мост до Chrome (`chrome-bridge.js`)

Chrome стоит на Windows, а исполнение — из WSL (или контейнера Hermes). Мост — маленький прокси без зависимостей. Он сам поднимает Chrome с отладкой на отдельном профиле `DATA/chrome-profile` (Chrome с 136-й версии не открывает отладку на обычном профиле; в нужные аккаунты в этом профиле входят один раз) и слушает порт `CHROME_BRIDGE_PORT` (по умолчанию 9223). Наружу отладка идёт только по секретному префиксу пути `/<CHROME_BRIDGE_TOKEN>/…`, токен мост при первом запуске сам дописывает в `.env`; без него — 404. Порт отладки Chrome — полный контроль над браузером, поэтому открыто его не выставляют.

Мост поднимает агент из сессии (записка 069, обновление 2026-09-23); сторож его не поднимает. Нужен Windows-Node в `C:\Program Files\nodejs\node.exe`. Из WSL:

```
cmd.exe /c 'start "jev-bridge" /min cmd /c ""C:\Program Files\nodejs\node.exe" C:\0_PROJECTS\OpenKarandash\PROJECTS\Browser\chrome-bridge.js > C:\0_PROJECTS\OpenKarandash\DATA\chrome-bridge.log 2>&1"'
```

## Профиль из настоящего Chrome (`sync-user-profile.js`)

По умолчанию у моста свой пустой профиль `DATA/chrome-profile`, и аккаунты в него входят один раз руками. Чтобы jev работал с твоими входами, которые уже стоят в настоящем Chrome, запусти синк на Windows — он скопирует каталог данных Chrome в `CHROME_PROFILE_DIR` (по умолчанию `DATA/userchrome-profile`), а выбранный профиль положит там как `Default`:

```
C:\Program Files\nodejs\node.exe C:\0_PROJECTS\OpenKarandash\PROJECTS\Browser\sync-user-profile.js
```

Берётся профиль, стоявший последним (по `Local State`); другой профиль из переключателя — аргументом `--profile "Имя"`. Кэш, расширения и служебный мусор не копируются, куки и ключ расшифровки (Local State) едут вместе. Копия делается потому, что настоящий каталог нельзя: Chrome с 136-й версии не открывает отладку на штатном каталоге, а живой Chrome держит его залоченным.

**Важно:** пока настоящий Chrome открыт, его файлы входа (куки, сессии) залочены и в копию не попадут — синк предупредит. Для полной копии закрой Chrome и запусти синк ещё раз: он докачает изменившееся. Повторный запуск меняет только файлы, которых в копии нет или они выросли: входы, сделанные агентом в копии, не стираются. После замены куки файлом браузер агента надо перезапустить (закрыть Chrome на профиле — проще всего перезапустить мост командой выше), иначе живой браузер новые входы не подхватит.

Команда возвращается через несколько секунд, мост остаётся жить после сессии; логи — в `DATA/chrome-bridge.log`. PowerShell с `Start-Process` и перенаправлением не годится: он держит WSL-шелл до таймаута. Если Windows блокирует входящее соединение, нужно разрешить порт 9223 в брандмауэре (только для сети WSL/Docker).

Из контейнера инструмент запускают через `PROJECTS/Browser/run.sh python examples/run.py --url … --goal '…'`: скрипт собирает `BU_CDP_URL=http://host.docker.internal:9223/<токен>` из `.env`. Из чистого WSL `host.docker.internal` иногда не резолвится — тогда задай `CHROME_BRIDGE_HOST=<шлюз WSL>` (например `172.22.0.1`). Настройки в `.env`, все необязательные: `CHROME_BRIDGE_PORT`, `CHROME_CDP_PORT` (9222), `CHROME_PATH`, `CHROME_PROFILE_DIR`.

## Ограничения

Мост нужен запущенным: без него из WSL/контейнера до Chrome не достать. Рамки самого инструмента: нет теневых корней, фреймов, canvas, загрузки файлов; `DONE` не доказывает успех, итог надо проверять отдельно. Проверено: пакет ставится, 31 офлайн-тест проходит. 2026-09-23 — живой проход на настоящем Chrome с ключами проекта: ввод текста и клик, итог подтверждён отдельно по DOM.
