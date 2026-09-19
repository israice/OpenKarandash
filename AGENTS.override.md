Общие правила проекта для любого агента (Claude Code, Codex CLI, OpenCode) — читать перед началом работы. Claude Code дополнительно смотрит `CLAUDE.md` — там то, что специфично именно для него (например, поведение Windows-claude/WSL-claude).

## Карта проекта и память

Знания о проекте живут в Obsidian-vault внутри репозитория: папка `DATA/vault/` (не коммитится). Сервер создаёт и наполняет её при запуске и обновляет через 3 секунды после правок.

Что в ней лежит:
- `DATA/vault/Project/` — заметка на каждый файл папки проекта (включая скрытые и игнорируемые git; не обходятся только `.git` и `DATA/` — всё, что сервер собрал сам), на его секции и функции, плюс `API/` с заметкой на каждый роут. Связи берутся из настоящих ссылок: литералы `/api/...`, `src`/`href`, `require`, вызовы функций.
- `DATA/vault/Sessions/` — память о прошлых сессиях: что просили, чем закончилось, какие файлы затронуты. Помеченные `stale: true` устарели — после них файлы уже менялись.

Правила:
- Ищи по проекту командой `node PROJECTS/Graph/search.js "запрос"` — полнотекстовый поиск (FTS5/BM25) по коду, заметкам и прошлым сессиям, выдаёт узел, путь и фрагмент. Фильтр: `node PROJECTS/Graph/search.js --kind session "запрос"`. Индекс собирает сервер; MCP-инструменты `obsidian_*` не используем — они требуют запущенного Obsidian и токена.
- `DATA/vault/Project/` перезаписывается целиком при каждой пересборке. Свои заметки клади в корень vault — их никто не тронет, и они попадут и в граф, и в поиск.
- Отдельной вкладки с графом в интерфейсе нет (`DOCS/decisions/023`): карту читают поиском, приложение Obsidian не открывается. Сама карта на месте — её собирает сервер, из неё же берётся список связей узла в редакторе файла.

## Конвенции

- Почему в проекте что-то сделано именно так — в `DOCS/decisions/`. Туда же кладём новое решение, если ответ на «почему» из кода не виден. Записки версионируются вместе с кодом и попадают в поиск наравне с остальным.
- Куда проект идёт целиком — `DOCS/целевая-архитектура.md`: проект оптимизируется не под человека-читателя, а под исполнителя-агента, и мерило любого решения одно — **уменьшает ли оно объём, который исполнитель обязан удерживать в голове, чтобы не ошибиться**. Оттуда же главное разделение ролей: думает подключённый агент, а OpenKarandash — пульт и наблюдение, он не думает. Как это уживается с вернувшимся Hermes — `DOCS/decisions/040`: оркестрация живёт в Hermes снаружи пульта, своей очереди, своих повторов и своей памяти о задачах мы не заводим, а только отражаем чужие. Читать перед тем, как браться за план или заводить новую сущность.
- Зависимости допустимы, но каждая обосновывается: ставится только то, что убирает существенный объём своего кода, версия пинится точным номером в `package.json`, лок-файл коммитится. Сейчас их три — `eta` (шаблоны серверных фрагментов), `htmx.org` (клиентская часть тех же фрагментов) и `three` (3D-персонаж в ноде QA на Flow: рендер, загрузчик GLB; браузер берёт его прямо из `node_modules` через importmap в `index.html`, `DOCS/decisions/027`). `node_modules/` в git не попадает: после клона нужен `npm install`.
- Наружу проект смотрит одним каналом: телеграм-мост Settings (`PROJECTS/Settings/telegram-server.js`). Он шлёт последний ответ каждой завершившейся сессии людям из `TELEGRAM_USER_IDS` и принимает от них ответ обратно в ту же сессию, запуская настоящий ход. Сообщения не из этого списка отбрасываются молча — ключ бота и список id живут в `.env` и правятся из Settings (`DOCS/decisions/024`).
- **Полные права всем агентам проекта (решение владельца 2026-09-19, `DOCS/decisions/044`).** Claude Code, OpenCode, Codex, Hermes и pi правят и запускают всё без запросов на разрешение — это намеренно, не выключать и не «ужесточать». Где у каждого это задано — таблица в записке; новый агент получает полные права сразу и строку в ней.
- **Автокоммит по завершении задачи (решение владельца 2026-09-19).** Закончив задачу, агент сам делает локальный коммит, не спрашивая. Условия: в коммит идут только файлы этой задачи, поимённо — никогда `git add -A` или `git add .`, потому что в основной папке обычно лежат незакоммиченные правки других сессий; коммит только после успешного `npm run check`, при ошибке проверки не коммитить и сказать об этом; одна задача — один коммит и одна версия: сначала в конец `DEV LOG` в `VERSION.md` дописывается следующая строка `vX.Y.Z - что сделано` (номер и список версий в пульте берутся из этого файла — `currentVersion`/`versionHistory` в `server.js`), она входит в тот же коммит, а первая строка сообщения коммита совпадает с ней; дальше в сообщении по-русски, человеческим языком — id задачи beads и честная пометка, что проверено, а что нет. Пуш — только по явной просьбе. Задача в beads закрывается после живой проверки, и проверяет агент сам, а не перекладывает её на пользователя: свой сервер поднимать нельзя, но сервер, который поднял пользователь, доступен через `SYSTEM/live-check.mjs` (безголовый Edge на стороне Windows — открыть страницы, пройти сценарий, прогнать короткий ход). Всё, что для этого нужно включить (подключить CLI в Settings через `/api/agent/connect` и т. п.), агент включает сам. К пользователю идут только с тем, что агенту действительно недоступно, и называют, что именно и почему. Это правило перекрывает профиль «Conservative» из блока beads ниже в части коммита, но не пуша.
- В телеграм уходит именно последний ответ сессии как есть, без отдельного форматирования на сервере (`ctx.answer` пересылается «сырым» — см. `notifyTurnFinished` в `server.js`). Поэтому финальный ответ на любой ход, доведённый до конца задачи, пиши как отчёт руководителю компании, а не техническим языком: **три абзаца**, без списков, без имён файлов/функций/номеров строк и без слов вроде «коммит», «функция», «рефакторинг». Абзац 1 — что попросили сделать, своими словами. Абзац 2 — что сделано. Абзац 3 — что это улучшит и как теперь будет работать. Это касается только финального ответа по завершении задачи; промежуточные технические реплики в ходе работы такому формату не подчиняются.
- Порт и любые секреты — только в `.env` (создаётся при первом запуске с `PORT=3001`, в git не попадает). Сервер поднимается строго на этом порту и соседние не подбирает: вторая копия на той же папке дерётся за `DATA/.sessions.db`/`DATA/.index.db` и перезаписывает `DATA/vault/`. Новую настройку заводить в `.env`, а не хардкодом и не отдельным файлом.
- Комментарии в коде — на русском. Ответ в чате — **всегда на языке текущего сообщения пользователя**, без исключений: не жёстко русский, а именно тот язык, на котором пользователь обратился именно сейчас. Это правило перекрывает язык системных инструкций и языки предыдущих реплик в разговоре — при смене языка пользователем ответ переключается вместе с ним, ни для одной реплики, ни частично оставаться на прежнем языке нельзя.
- Прежде чем ответить «не могу» / «нет доступа» на вопрос о факте, который может устареть (курс, погода, версия, текущий статус чего-либо) или специфичен для этого репозитория, сначала проверить, нет ли уже подходящего инструмента (веб-поиск, чтение файла/документации) — а не отвечать по памяти модели и не отказываться, не проверив.

## Устройство сервера

`server.js` — тонкий диспетчер: `.env`, статика, сессии, живые запуски CLI. Всё, что относится к конкретной фиче, живёт рядом с ней и подключается таблицей маршрутов.

- Серверная половина фичи — файл `PROJECTS/<Фича>/*-server.js`, экспортирующий `createRoutes(deps)`: он сам заводит свои таблицы, держит свои шаблоны и возвращает объект «полный путь → обработчик». `server.js` только раскладывает такие объекты в `featureRoutes` и ничего не знает об их устройстве. Крупная серверная половина сама разъезжается по темам внутри своей папки: у карты проекта это вход `graph-server.js` (`init`, `prepareVault`, `createRoutes`) плюс `graph-vault.js` (сборка vault и общее состояние папки), `graph-search.js` (индекс FTS5 и поиск), `graph-files.js` (чтение и правка файла внутри корня) — `DOCS/decisions/022`. Так сделаны все фичи с серверной стороной: карта проекта (`graph-server.js`), Flow (`flow-server.js`), Home (`home-server.js`), Chat (`chat-server.js` и `pages-server.js`), Karandash (`karandash-server.js`), телеграм-мост Settings (`telegram-server.js`), плюс тулбар (`SYSTEM/toolbar-icons-server.js`).
- Вкладка Kanban сейчас чистая UI-заготовка без сервера (`DOCS/decisions/032`, отменяет `030` и `021`): своих маршрутов не заводит, вид меняется по шагам пользователя.
- В самом `server.js` маршрутов остаётся ровно два набора, и оба ничьи: `/api/agent/*` (запуск любого CLI) и `/api/sessions/*` (общее хранилище — его читают и Chat, и Flow, и Home, и страницы кнопки «+»). Всё, что рисует одна вкладка, обязано уехать в её папку. Половина файла — четыре коннектора CLI (Claude/OpenCode/Codex/pi): они не принадлежат ни одной папке `PROJECTS/`, потому что это не раздел интерфейса, а способ запустить агента. Подробности — `DOCS/decisions/017`.
- Общие мелочи HTTP (`readJson`, `sendJson`, `sendHtml`, `escapeHtml`) — в `SYSTEM/core/http.js`, чтобы модуль фичи не тянул за собой весь сервер. Рядом в `SYSTEM/core/` лежит остальная ничья обвязка: `format.js`, `reload.js` (правило живой перезагрузки), `scan.js` (обход файлов проекта), `hermes-history.js` (история Hermes → лента сессии: пересборка хода по окончании, дотягивание ходов мимо нас, шаги помощников `delegate_task`, сжатие контекста, пометки моста `[claude-bridge]` — строками роли `system`, `DOCS/decisions/039`), `hermes-tool-runs.js` (журнал запусков инструментов Hermes из его `hermes-home/state.db` — своей таблицы под это нет, `DOCS/decisions/038`), `branch-preview.js` (ветка исполнителя живьём: `/branch/<ветка>/` отдаёт клиент из её рабочей копии git, а API и база остаются главными, `DOCS/decisions/042`). Папка `SYSTEM/cli/` заведена под коннекторы CLI (`DOCS/decisions/022`), но пока пуста — сами коннекторы ещё в `server.js`; там же по `022` должны появиться `SYSTEM/core/sessions-routes.js` и `agent-routes.js`.
- Id новой сессии заводит сервер (`runTurn`), а не CLI при первом событии: сессия видна в списке сразу, ещё до первого ответа. Id, который выдал сам CLI, живёт отдельно в `session_cli` и нужен только для его же `--resume`.
- Сессию можно продолжить любым CLI, а не только тем, что её начал: наш id сессии и id внутри CLI — разные вещи. Второй лежит в таблице `session_cli` по паре «сессия + цель» и нужен только для `--resume` этого же CLI; у кого своей записи нет — начинает свою сессию, а контекст получает пересказом последних ходов из нашей базы (`handoffPreamble` в `server.js`). Колонка `target` в `sessions` при переключении не перебивается.
- Все CLI-агенты ходят через один набор маршрутов `/api/agent/{detect,connect,stop,ask}`; какой именно CLI звать, сервер берёт из поля `agent` в теле. Различия собраны в таблице `AGENTS` в `server.js` — новый коннектор добавляется строкой в ней, а не копией маршрутов.
- Сессии работают параллельно: ход стартует сразу, сервер не удерживает его из-за других запусков и файлы под ним не блокирует. `activeRuns` в `server.js` — просто реестр идущих ходов: по нему работает остановка (`/api/agent/stop`), счётчик «выполняется» на Home и откладывание перезапуска сервера. Перезапуск после правки серверного файла сторож не делает сам: он шлёт серверу `prepareRestart`, а гасит процесс только по ответу `readyToRestart` — сервер отдаёт его, когда последний ход дописан в базу, и с этого мгновения отвечает на `/api/agent/ask` отказом вместо оборванного соединения (`DOCS/decisions/020`). Причина любого выключения пишется в `DATA/server-exits.log`. Хуков блокировки файлов в проекте нет: в `.claude/hooks/` живут только `context-files-node.js`, `language-check.js`, `language-reminder.js` (оба языковых — на общем `language.js`: язык определяется по письменности, а не по доле букв, иначе служебный английский текст в обращении перевешивает слова человека), `no-bg-server.js`, `syntax-check.js` и их `hook-config.json`.
- Ошибку, которую обработчик предвидит, он отдаёт сам: `200` с `{ ok: false, error }`. Всё, что долетело до общего `catch`, — баг сервера: он пишется в консоль и отдаётся кодом `500`.

## Проверка изменений

- Перед словами «готово» агент обязан прогнать `npm run check` (`SYSTEM/checks.js`) — отдельным шагом в конце задачи, а не фоном. Это три проверки: неизвестные имена (`eslint`, единственное правило `no-undef`), циклические связи (`madge --circular server.js`) и счёт файлов длиннее 400 строк (норма `DOCS/decisions/022`). Первые две валят команду, третья только перечисляет. Нужна она затем, что `node --check` (хук `syntax-check.js`) видит один синтаксис и пропускает обращение к переменной, которой нигде нет: так в `PROJECTS/Settings/settings.js` жил вызов потерянной `pickInstall`, а в `PROJECTS/Flow/flow.js` — обращение к ненаписанной `ROOT_FIELDS`, и падало это уже в браузере у пользователя (`DOCS/decisions/034`). Новое имя, публикуемое вкладкой через `window`, дописывается в список `APP_GLOBALS` в `eslint.config.mjs`, иначе проверка примет его за опечатку. Смоука по-прежнему нет (`DOCS/decisions/025`), и работает ли фича на самом деле, смотрит пользователь на своём сервере. Живой интерфейс при необходимости проходит агент `ui-checker` через Playwright MCP — но на сервере, который поднял пользователь, а не сам агент.
- Тем же шагом в конце задачи агент дописывает приём в память своего работника — `PROJECTS/Flow/profiles/<Роль>/memories/skills.md` (`POST /api/flow/profile/memory/add`, серверная половина — `PROJECTS/Flow/profiles-server.js`), а в начале похожего задания читает её. Запись только о проверенном: четыре поля — когда применим, что делать, чем подтверждён, когда записано. «Наверное, помогает» засоряет память быстрее, чем приносит пользы (`DOCS/decisions/035`).
- Не запускать `server.js` из сессии — ни в фоне через `&`, ни на переднем плане. Без `NO_RELOAD=1` поднимается сторож с дочерним процессом, а на Windows завершение сессии не шлёт им сигналов: оба остаются жить. Осиротевший сторож держит cwd проекта (папку нельзя переименовать), сутками крутит опрос файлов и дерётся за `DATA/.sessions.db` со следующей копией. Запуск блокирует хук `.claude/hooks/no-bg-server.js`.
- Сервер для себя пользователь запускает сам: `node server.js` в своём терминале (PowerShell или WSL), останов — `Ctrl+C`. Сторож при этом сначала проверяет системные зависимости и ставит недостающие (`SYSTEM/core/host-deps.js`: git, python, Docker, claude CLI и вход в него через `claude auth login`; `HOST_DEPS=0` выключает), сам подключает найденный claude (`/api/agent/status`), затем поднимает Hermes-стек (`SYSTEM/core/hermes-stack.js`: проверка и установка npm-зависимостей, клон/обновление `hermes/` с GitHub (в git не хранится, только наши настройки к нему), образ, ключи `.env`, потом claude-bridge на хосте и `docker compose up -d gateway`) и гасит его по `Ctrl+C`; `HERMES_STACK=0` в `.env` выключает стек. `hermes-start.sh`/`hermes-stop.sh` — ручной запасной путь для WSL, из сессии их тоже не запускать. Правку `claude-bridge/*.py` перезапускать руками не нужно: сторож следит за ними так же, как за серверными файлами, и перезапускает один мост, не трогая сервер и Hermes (`DOCS/decisions/029`).
- Если зомби всё же завёлся, искать по рабочему каталогу, а не по имени процесса — в диспетчере задач он неотличим от прочих `node.exe`:

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Select-Object ProcessId, CommandLine
Stop-Process -Id <pid> -Force
```

## Клиентский код

Клиент целиком лежит в `SYSTEM/`. `SYSTEM/index.html` — только разметка: стилей внутри страницы нет, они подключаются файлами (`SYSTEM/styles/*.css` — общие части страницы, `PROJECTS/<Фича>/*.css` — сами фичи), и порядок `<link>` повторяет прежний порядок правил, то есть значим для каскада. Страница отдаётся по адресу «/», поэтому пути в ней пишутся от корня проекта (`SYSTEM/app.js`, `PROJECTS/Graph/file-editor.js`), а не относительно самого файла. Скрипты подключены отдельными файлами: обычные — с `defer`, входы вкладок, разъехавшихся на ES-модули (`SYSTEM/app.js`, `PROJECTS/Chat/chat.js`), — с `type="module"`. Порядок один и тот же: модульные скрипты без `async` тоже откладываются и выполняются в порядке документа вместе с `defer`, поэтому цепочка `book-tab.js` → `app.js` → `chat.js` → остальные сохраняется (`DOCS/decisions/022`).

| Файл | Что в нём | Что публикует |
|---|---|---|
| `SYSTEM/app.js` | ядро: `api()`, модалка, лайтбокс, `App.VIEWS`, восстановление подключения CLI, `escapeHtml`. Подключён как `<script type="module">`, импортирует `./providers.js` (`DOCS/decisions/022`) | `window.App` |
| `SYSTEM/providers.js` | состояние провайдеров и подключений (`PROVIDERS`, `connections`, сохранение в `localStorage`), лимиты и usage, шапка сессии с моделью и effort, датчик контекста. Импортируется из `app.js` и `PROJECTS/Chat/chat*.js`, своего `window.*` не публикует | ES-экспорты |
| `PROJECTS/Chat/chat.js` | вход вкладки Chat: режимы отправки, композер, инициализация панели/ленты/потока. Подключён как `<script type="module">` сразу после `app.js`, импортирует ядро из него (обратный импорт дал бы цикл) и сам дописывает свои функции в `window.App` | дополняет `window.App` |
| `PROJECTS/Chat/chat-state.js` | общее изменяемое состояние вкладки Chat одним объектом (`export const state`), ничего не импортирует | `state` |
| `PROJECTS/Chat/chat-sessions.js` | панель сессий: список, выбор и удаление, черновики, индикатор «выполняется», занятость композера | ES-экспорты |
| `PROJECTS/Chat/chat-feed.js` | лента сообщений: markdown, шаги и размышления, автопрокрутка, лайтбокс превью | ES-экспорты |
| `PROJECTS/Chat/chat-details.js` | полнота строки в Sessions: сводка полей, сырое событие, картинки результата, блок Details под репликой (`DOCS/decisions/039`) | ES-экспорты |
| `PROJECTS/Chat/chat-stream.js` | поток NDJSON: `ask`/`attach`/`stop`, разбор событий CLI в ленту | ES-экспорты |
| `PROJECTS/Graph/file-editor.js` | редактор файла проекта: чтение, правка, автосохранение, связи узла карты. Своей вкладки у папки больше нет (`DOCS/decisions/023`), редактором живут Book, Chat и Flow (стили — `PROJECTS/Graph/file-editor.css`, серверная половина — `PROJECTS/Graph/graph-server.js` вместе с `graph-vault.js`/`graph-search.js`/`graph-files.js`, поиск из терминала — `PROJECTS/Graph/search.js`) | `window.MissionFiles` |
| `PROJECTS/Flow/flow.js` | вкладка Flow целиком (стили — `PROJECTS/Flow/flow.css`) | `window.MissionFlow` |
| `PROJECTS/Kanban/kanban.js` | вкладка Kanban: чистая UI-заготовка без сервера, рисует пять пустых колонок статуса (стили — `PROJECTS/Kanban/kanban.css`) | — |
| `PROJECTS/Telegram/telegram.js` | вкладка Telegram — крайняя слева в системной группе тулбара: своя разметка целиком (стили — `PROJECTS/Telegram/telegram.css`). Пока только подпись раздела; сам телеграм-мост серверный и живёт в Settings (`telegram-server.js`). Подключается **раньше `app.js`** — тот ищет `#telegramView` для `App.VIEWS` | — |
| `PROJECTS/Karandash/karandash.js` | кнопка Karandash целиком: своя разметка + комментарии к элементам (стили — `PROJECTS/Karandash/karandash.css`, серверная половина — `PROJECTS/Karandash/karandash-server.js`) | — |
| `PROJECTS/Settings/settings.js` | кнопка-шестерёнка и окно настроек целиком: своя разметка + логика провайдеров (стили — `PROJECTS/Settings/settings.css`) | `window.Settings` |
| `SYSTEM/home-tasks.js` | вкладка Home | — |
| `SYSTEM/tabs.js` | панель вкладок, `showView` | `window.MissionTabs` |
| `SYSTEM/toolbar-reorder.js` | drag-and-drop кнопок `.toolbar` по долгому нажатию | — |
| `SYSTEM/toolbar-menu.js` | меню кнопки «+» в тулбаре табов: показать/скрыть остальные кнопки (стили — `SYSTEM/toolbar-menu.css`) | — |
| `PROJECTS/Book/book-tab.js` | вкладка Book верхнего тулбара целиком: своя разметка + карточки всех разделов интерфейса слева и README выбранной справа (стили — `PROJECTS/Book/book.css`). Подключается **раньше `app.js`** — тот ищет `#bookView` для `App.VIEWS`. Чужое зовёт через окна: `MissionFiles.createFileEditor`/`nodeByPath`, `MdEditors.attach`, `SidebarResize.init` | `window.MissionBookTab` |
| `SYSTEM/new-button.js` | кнопка «+» тулбара: заводит страницу и настоящую папку в `PROJECTS/` с `README.md`, `page.js` и `page.css`, переключает такие страницы, грузит и пересобирает их модули (серверная половина — `PROJECTS/Chat/pages-server.js`) | `window.MissionPages` |
| `PROJECTS/<Страница>/page.js` | содержимое такой страницы целиком: `export default build(page, { panel, signal })` — рисует в выданном `<main>` и слоте топбара, подписки вешает на `signal`; грузится динамическим `import` при первом открытии, стили рядом в `page.css`. У заготовки это «Hello World»; у `PROJECTS/Feed/page.js` — выбор сессии в топбаре и её лента карточками-аккордеонами со всеми полями `/api/sessions/messages`, живая (подписка на `/api/sessions/attach`, как у Flow) | — |
| `SYSTEM/sidebar-resize.js` | ручка на правой грани боковой панели: зажать и тянуть, чтобы менять её ширину. Панели самой страницы — в `PANELS`; вкладка, которая строит панель сама (Book), подключается вызовом `SidebarResize.init(...)` | `window.SidebarResize` |
| `PROJECTS/Flow/flow-session-sync.js` | выпадающий список сессий в тулбаре Flow (`#flowSessionSelect`): строит граф нод канваса из сообщений выбранной сессии | — |
| `PROJECTS/Flow/flow-minion.js` | вращающийся 3D-персонаж в шапке ноды QA слева от заголовка (модель — `PROJECTS/Flow/assets/traveler.glb`). ES-модуль (`type="module"`), импортирует `three` через importmap в `index.html`; сам следит за появлением `.flow-node--qa` на странице, `flow.js` о нём не знает (`DOCS/decisions/027`) | — |
| `PROJECTS/Graph/md-editors.js` | EasyMDE для файловых панелей: панель чата (`#chatFileEditorText`) подключает сам, чужие вкладки зовут `MdEditors.attach(textarea)` из своей папки | `window.MdEditors` |

### Серверные фрагменты (htmx)

Часть интерфейса рисует не браузер, а сервер: шаблон `PROJECTS/<Фича>/<имя>.eta` → роут `/api/fragment/<имя>` → htmx подменяет им кусок страницы. Шаблон лежит в папке своей фичи рядом с её `*-server.js`, который его и рисует (свой экземпляр `Eta` с `views: __dirname`). Сейчас так сделаны панель наблюдения на Home (`PROJECTS/Home/home-observation.eta`, `home-server.js`), список сессий панели Chat (`PROJECTS/Chat/chat-sessions.eta`, `chat-server.js`, `#sessionList`). Кто из сессий выбран (`aria-current`) серверу не известен — это чинит `app.js` в обработчике `htmx:oobAfterSwap` сразу после подмены; лента сообщений выбранной сессии (стриминг NDJSON) на htmx-опрос не ложится и остаётся на JS.

- Куски адресуются через `hx-swap-oob="true"` по `id`: один ответ обновляет несколько мест страницы, а разметку `index.html` и её сетку трогать не нужно. Элемент-инициатор запроса при этом стоит с `hx-swap="none"`.
- Обработчики кликов вешать на контейнер, который htmx **не** подменяет (для Home это `.observation`, для списка сессий — `#sessionsPanel`): слушатель на самом заменяемом элементе переживёт только первое обновление. По той же причине нельзя держать константную JS-ссылку на подменяемый узел (`sessionList` в `app.js` — `let`, а не `const`) — переподхватывать актуальный узел по событию `htmx:oobAfterSwap` (`e.target`).
- Данные подставлять через `<%= %>` — Eta экранирует их сама; `<%~ %>` только для заведомо безопасной разметки. Комментарий в шаблоне — `<% /* … */ %>`, синтаксиса `<%# %>` в Eta 3 нет.
- Ошибка внутри `/api/fragment/*` отдаётся кодом 500, а не привычным `200 { ok: false }` — иначе htmx молча оставит панель замороженной.
- Обновление вне таймера: клиент шлёт событие на `body` (`sessions-changed`), фрагмент слушает его через `hx-trigger="… from:body"`.

### Живая перезагрузка

Сторож файлов смотрит, что именно изменилось, и шлёт точечное событие вместо перезагрузки страницы: правка любого `.eta` перезапрашивает фрагмент по имени его файла (`/api/fragment/<имя>`), правка любого `.css` подменяет `href` у его `<link>`, правка `PROJECTS/<папка>/page.js` пересобирает одну эту страницу кнопки «+» (`MissionPages.rebuildPage`). Всё остальное — и удаление файла, и пачка правок, где есть хоть один посторонний файл, — перезагружает страницу целиком. Правило лежит отдельным модулем `SYSTEM/core/reload.js` — его видно и можно позвать напрямую, не поднимая сервера. Подробности — `DOCS/decisions/011`.

Правила, чтобы одна поломка не гасила интерфейс целиком:
- Раздел живёт в своей папке целиком — вместе с разметкой: её создаёт сам скрипт раздела (Karandash, Settings, Book), а в `index.html` остаются только точки подключения (кнопка тулбара, `<link>` на стили, запись в `App.VIEWS`). Общий механизм, который разделу понадобился, публикуется наружу функцией (`MissionFiles.createFileEditor`, `MdEditors.attach`, `SidebarResize.init`), а не обзаводится знанием про этот раздел у себя. Подробности — `DOCS/decisions/014`.
- Страницы кнопки «+» — тот же раздел, только заведённый пользователем: содержимое каждой лежит в её папке (`PROJECTS/<Страница>/page.js` + `page.css`) и грузится модулем при первом открытии. В `index.html` про них нет вообще ничего: `<main>`, слот в топбаре под свою панель и `<link>` на стили выдаёт загрузчик. Взамен модуль обязан рисовать только в выданных узлах и подписывать всё на `signal` — тогда его правка пересобирает одну эту страницу, не трогая остальной интерфейс. Подробности — `DOCS/decisions/016`.
- Никогда не класть JS обратно в `<script>` внутри `index.html`. Новый кусок интерфейса — новый файл с `defer`: браузер выполняет их независимо, и исключение в одном не отменяет остальные. Файл с `import`/`export` подключается только с `type="module"` — с `defer` браузер откажется его исполнять.
- Чужое (`App.openModal`, `MissionTabs.show`, …) вызывать **внутри функций и обработчиков**, а не на верхнем уровне файла. Тогда порядок загрузки ни на что не влияет и циклические связи безопасны.
- `app.js` идёт первым (после `book-tab.js`): остальные файлы берут из `window.App` общее ядро. Части, разъехавшиеся из него, берут ядро не из `window`, а `import`-ом из `SYSTEM/app.js` — импорт в обратную сторону (из `app.js` в файл вкладки) запрещён, он даёт цикл.
- Всё, что сервер подставляет в HTML (`{{APP_VERSION}}`, `{{VERSION_LIST}}`), обязано проходить через `escapeHtml` в `server.js` — иначе `<` из сообщения коммита рвёт страницу.

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:6cd5cc61 -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.

## Agent Context Profiles

The managed Beads block is task-tracking guidance, not permission to override repository, user, or orchestrator instructions.

- **Conservative (default)**: Use `bd` for task tracking. Do not run git commits, git pushes, or Dolt remote sync unless explicitly asked. At handoff, report changed files, validation, and suggested next commands.
- **Minimal**: Keep tool instruction files as pointers to `bd prime`; use the same conservative git policy unless active instructions say otherwise.
- **Team-maintainer**: Only when the repository explicitly opts in, agents may close beads, run quality gates, commit, and push as part of session close. A current "do not commit" or "do not push" instruction still wins.

## Session Completion

This protocol applies when ending a Beads implementation workflow. It is subordinate to explicit user, repository, and orchestrator instructions.

1. **File issues for remaining work** - Create beads for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **Handle git/sync by active profile**:
   ```bash
   # Conservative/minimal/default: report status and proposed commands; wait for approval.
   git status

   # Team-maintainer opt-in only, unless current instructions forbid it:
   git pull --rebase
   git push
   git status
   ```
5. **Hand off** - Summarize changes, validation, issue status, and any blocked sync/commit/push step

**Critical rules:**
- Explicit user or orchestrator instructions override this Beads block.
- Do not commit or push without clear authority from the active profile or the current user request.
- If a required sync or push is blocked, stop and report the exact command and error.
<!-- END BEADS INTEGRATION -->

<!-- BEGIN BEADS CODEX SETUP: generated by bd setup codex -->
## Beads Issue Tracker

Use Beads (`bd`) for durable task tracking in repositories that include it. Use the `beads` skill at `.agents/skills/beads/SKILL.md` (project install) or `~/.agents/skills/beads/SKILL.md` (global install) for Beads workflow guidance, then use the `bd` CLI for issue operations.

### Quick Reference

```bash
bd ready                # Find available work
bd show <id>            # View issue details
bd update <id> --claim  # Claim work
bd close <id>           # Complete work
bd prime                # Refresh Beads context
```

### Rules

- Use `bd` for all task tracking; do not create markdown TODO lists.
- Run `bd prime` when Beads context is missing or stale. Codex 0.129.0+ can load Beads context automatically through native hooks; use `/hooks` to inspect or toggle them.
- Keep persistent project memory in Beads via `bd remember`; do not create ad hoc memory files.

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.
<!-- END BEADS CODEX SETUP -->
