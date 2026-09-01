# Память команды: интеграция OpenCode CLI

Общий файл для агентов, работающих над задачей «подключить OpenCode по-настоящему,
как Claude». Каждый агент читает его перед стартом и дописывает короткую запись
в конце своего этапа (дата, что сделал, на что напоролся, что важно знать следующему).
Это и есть «корпоративная память» команды на время задачи — отдельно от общего
поиска по проекту (`node PROJECTS/Graph/search.js`, см. CLAUDE.md), который агенты
тоже обязаны использовать для контекста по остальному коду.

## Факты про opencode CLI (проверено вживую 2026-08-31)

- Бинарник лежит в `~/.opencode/bin/opencode` (167 МБ), НЕ в PATH. В $HOME/.opencode
  также package.json с `@opencode-ai/plugin`. На Windows-стороне бинарник ещё не
  проверялся — предполагать `opencode`/`opencode.exe` по аналогии с TARGETS Claude,
  но обязательно проверить `where opencode`/`Get-Command opencode` перед тем как
  считать это готовым фактом.
- `opencode --version` → `1.17.11` (просто версия строкой, как у Claude).
- `opencode providers list` → 0 credentials по умолчанию (без логина). Но:
- `opencode models` без провайдера всё равно возвращает 6 бесплатных моделей вида
  `opencode/big-pickle`, `opencode/ling-3.0-flash-fin-free`, `opencode/mimo-v2.5-free`,
  `opencode/muse-spark-1.2-contributor-free`, `opencode/nemotron-3-ultra-free`,
  `opencode/nemotron-3.5-lightning-free` — работают БЕЗ авторизации. Именно они и
  есть «реальный список моделей», которым надо заменить старый хардкод
  (`qwen3-coder`, `kimi-k2`, `glm-4.6`, `deepseek-v3` — эти имена не существуют
  в CLI, чистая выдумка прошлой версии кода).
- `opencode models` — плоский текстовый список `provider/model`, по строке на модель,
  без флага `--format json`. Парсить построчно (`stdout.trim().split('\n')`).
- `opencode run <msg> --model <provider/model> --format json` — печатает построчный
  NDJSON (как stream-json у Claude), но СВОЯ схема событий, отличная от Claude:
  - `{"type":"step_start", sessionID, part:{type:"step-start", ...}}`
  - `{"type":"text", sessionID, part:{type:"text", text, time:{start,end}}}`
  - `{"type":"tool_use", sessionID, part:{type:"tool", tool, callID, state:{status,input,output,title,time}}}`
  - `{"type":"step_finish", sessionID, part:{type:"step-finish", reason:"stop"|"tool-calls", tokens:{total,input,output,reasoning,cache:{write,read}}, cost}}`
  - `{"type":"error", sessionID, error:{name, data:{message, ref}}}` — приходит
    ВНУТРИ потока, а не через ненулевой exit-код (в тесте с несуществующей моделью
    процесс завершился с кодом 0). Ошибку ловить по event.type === 'error', не по
    коду возврата процесса.
  - session id лежит в `event.sessionID` на КАЖДОМ событии (не только на первом,
    как у Claude), но брать первый встреченный — тот же паттерн, что у askClaude.
- Продолжение диалога: `--session <id>` — проверено, помнит контекст между вызовами.
- Остановка: обычный `child.kill()` — процесс глохнет чисто, без зависаний.
- Нет аналога `--effort` — есть `--variant` («model variant (provider-specific
  reasoning effort)»), но для бесплатных моделей `opencode/*` неизвестно, какие
  variant-значения валидны — не хардкодить список, пока не проверено; для MVP
  можно вообще не выставлять effort/variant у OpenCode-провайдера (поле необязательно).
- Нет аналога hook_started/thinking_tokens/rate_limit_event/redacted_thinking —
  это концепции только Claude Code CLI. Соответствующие колонки в БД
  (`session_info`, `rate_limit`, `extra_meta` под thinking-специфику) для
  OpenCode просто не заполняются, это нормально — колонки уже общие/nullable.

## Контракт API (зафиксирован 2026-08-31)

Смотри server.js:330-944 (TARGETS/runClaude/detectInstalls/askClaude),
server.js:980-1260 (схема БД и db.prepare хелперы), server.js:1425-1490
(роуты /api/claude/*), SYSTEM/app.js (PROVIDERS, connections Map, sendToClaude,
readNdjson, saveClaudeState/loadClaudeState, restoreServerConnection),
PROJECTS/Settings/settings.js (клик по [data-provider], connectClaude, picker).

Общее (провайдеро-независимое, переиспользовать как есть, не дублировать):
- Таблицы `sessions`/`messages` — уже общие, есть колонка `sessions.target` для
  привязки сессии к CLI/провайдеру.
- DB-хелперы `startExchange/recordStep/recordAssistantText/finishExchange/
  setSessionContext/setMessageMode/setMessageInputSent/setMessageToolResult/
  getSessionTarget` — принимают `target` параметром, годятся для OpenCode без
  изменений.
- `activeRuns`/`waitForFileTurn`/`candidateFiles`/`checkFileLock` — общая очередь
  по файлам, GET `/api/sessions/attach` и `runs` Map — все не привязаны к Claude
  жёстко, работают по sessionId. Использовать общими для обоих провайдеров (одна
  очередь на файлы, не две отдельные — иначе Claude и OpenCode смогут одновременно
  писать в один файл).
- Фронтовый `readNdjson`/`makeRenderer` — событийная схема (`session|tool|text|
  thinking|context|rate_limit|error|done|queued`) уже провайдеро-независимая,
  переиспользуется без изменений.

Специфичное для провайдера (мириться с дублированием по аналогии с TARGETS/
CLAUDE_MODELS/runClaude/askClaude — в проекте сознательно нет общей абстракции
над CLI, это нормальный стиль):
- Свой `TARGETS`-эквивалент, свой `activeTarget`-эквивалент (НЕ переиспользовать
  переменную Claude — иначе подключения провайдеров затирают друг друга).
- Свой список моделей — но **не хардкод**: детект должен реально спросить
  `opencode models` и вернуть то, что CLI прислал, а не статичный массив.
- Свой `run*`/`ask*`, переводящий его формат стрима в общий `AskEvent`.

## Журнал этапов
(агенты дописывают сюда короткую запись после своего этапа)

### 2026-08-31 — серверная часть (server.js)

Сделал зеркало Claude-коннектора для OpenCode, без общей абстракции над CLI —
весь новый код одним блоком `server.js:950-1327` («---------- коннектор
OpenCode CLI ----------», перед разделом «разбор тела запроса»).

Что добавлено (все имена — свои, ничего Claude-шного не переиспользовано, кроме
общих провайдеро-независимых вещей):
- `resolveOpenCodeBin()` (server.js:955) — ищет бинарник в PATH (`where`/`which`),
  при неудаче пробует известный путь `~/.opencode/bin/opencode` (Linux/WSL) или
  `%USERPROFILE%\.opencode\bin\opencode.exe` (Windows — по коду реально
  спрашивается `where`, а не жёстко забит путь; сам факт на Windows не проверен,
  честно об этом сказано в комментарии).
- `OPENCODE_BIN` (env-оверрайд, как `CLAUDE_BIN`) и `OPENCODE_TARGETS`
  (server.js:976) — **id с префиксом `opencode-`** (`opencode-wsl`,
  `opencode-windows`, `opencode-custom`), а не голые `wsl`/`windows`/`custom`,
  как у Claude. Это важно: `sessions.target` — общая колонка на оба провайдера,
  и совпадение id перепутало бы владельца сессии между CLI.
- `activeOpenCodeTarget` (server.js:991) — отдельная переменная от `activeTarget`.
- `OPENCODE_ASK_TIMEOUT_MS` (свой env, дефолт тот же час, что и у Claude) —
  `CLAUDE_ASK_TIMEOUT_MS` не трогал.
- `shQuote()` (server.js:997) — кавычки для случая `wsl.exe bash -lc "..."`:
  в отличие от Claude, `opencode run <msg>` принимает промпт **позиционным
  аргументом**, не через stdin (это факт из памяти команды, не моя выдумка) —
  stdin CLI не читает вовсе (`child.stdin.end()` без данных). Для обычного
  spawn с массивом аргументов кавычки не нужны, только когда всё собирается
  в одну shell-строку для `wsl.exe`.
- `runOpenCode()` (server.js:1004) — аналог `runClaude`: построчный NDJSON,
  таймаут, `kill()`. Код возврата 0 всегда success — ошибку хода ловим по
  `event.type === 'error'` внутри потока, не по exit-коду (тоже факт из памяти).
- `detectOpenCodeInstalls()` (server.js:1062) — аналог `detectInstalls`,
  `Promise.allSettled` по `OPENCODE_TARGETS`, версия через `--version`.
- `fetchOpenCodeModels()` (server.js:1077) — `opencode models` без флагов
  формата, построчный текстовый список `provider/model`. Не хардкодил список.
- `openCodeToolFile()` (server.js:1082) — вытаскивает путь файла из
  `tool_use.part.state.input.filePath` для очереди по файлам.
- `askOpenCode()` (server.js:1090) — аналог `askClaude`. Маппинг событий:
  `step_start` → игнор (своей ветки в общей AskEvent-схеме нет),
  `text` → `{type:'text'}` + `recordAssistantText`, `tool_use` → `{type:'tool'}`
  + `recordStep`/`setMessageToolResult` (дедуп по `part.callID` — событие может
  прийти дважды на один и тот же вызов: сперва running, потом completed),
  `step_finish` → копит usage/cost в `turnMeta` (из `part.tokens`/`part.cost`),
  `error` → `{type:'error'}`. `thinking`/`rate_limit` не эмитятся (у OpenCode
  нет таких концепций). Использует **общую** очередь `activeRuns`/
  `waitForFileTurn`/`candidateFiles` — не завёл вторую, `stopActiveRun` и
  `checkFileLock` тоже общие, без изменений. Пишет в БД теми же хелперами, что
  Claude (`startExchange`/`recordStep`/`recordAssistantText`/`finishExchange`/
  `setSessionContext`(не используется, у OpenCode нет процента контекста)/
  `setMessageMode` и т.д.), передавая `target.id` (свой, с префиксом `opencode-`).
  Режим Chat/Action только помечает строку в БД (`mode`-колонка) — реального
  ограничения инструментов на уровне флагов CLI нет (нет проверенного аналога
  `--permission-mode`/`--disallowedTools`), это осознанный предел MVP, не баг.

Роуты (`server.js`, диспетчер `handleApi`, вставлены перед `/api/obsidian/graph`):
- `POST /api/opencode/detect` (server.js:1785) → `{ installs: [{id,label,version}, ...] }`.
  Не требует сети/бинарника — `Promise.allSettled` отфильтровывает неудачные попытки.
- `POST /api/opencode/connect` (server.js:1790), тело `{ id }` (id из detect,
  т.е. `opencode-wsl`/`opencode-windows`/`opencode-custom`) → при успехе
  `{ ok:true, id, label, version, models }` (`models` — массив строк
  `provider/model` из `fetchOpenCodeModels`, реальный, не статичный список —
  **фронту нужно проставить его как список опций модели**, отдельного роута
  `/api/opencode/models` нет, специально не заводил, чтобы не дёргать CLI
  два раза при подключении); при неудаче `{ ok:false, error }`.
- `POST /api/opencode/stop` (server.js:1805), тело `{ sessionId }` →
  `{ ok:true, stopped }`. Использует общий `stopActiveRun` (та же очередь
  `activeRuns`, что и у Claude) — отдельной остановки под OpenCode нет и не
  нужно.
- `POST /api/opencode/ask` (server.js:1813), тело `{ prompt, model, sessionId,
  mode }` (без `effort` — у OpenCode нет проверенного аналога) → стриминг
  NDJSON, `Content-Type: application/x-ndjson`, та же событийная схема
  `AskEvent`, что у Claude (`session|tool|text|error|done|queued`, без
  `thinking`/`rate_limit`/`context`).

На что напоролся: во время диагностики окружения по неосторожности выполнил
`git stash && ... && git stash pop` в общем репо — `stash pop` упал
(`DATA/.index.db-*`/`.sessions.db-*` не unlink'ились, Permission denied) и
откатил `server.js`/`SYSTEM/smoke.js` в рабочем дереве к HEAD, потеряв мои
правки из working tree (но не из stash). Восстановил оба файла командой
`git show stash@{0}:<path> > <path>`, проверил `git diff --stat`, что
пострадали только эти два файла и всё совпадает с состоянием до инцидента,
затем `git stash drop stash@{0}`. **Урок для следующих агентов: не трогать
`git stash` в этом репо вообще** — `DATA/*.db*` WAL-файлы не unlink'ятся на
этой машине (Permission denied) и рвут откат/восстановление; если нужно
сравнить с чистым HEAD — используйте `git show HEAD:path` или отдельный
`git worktree`, не `git stash`.

Отдельно (не моя вина, но важно знать): `DATA/.index.db` (поиск/граф,
`PROJECTS/Graph/graph-server.js:590`) в этой машине даёт `disk I/O error` при
любом открытии — воспроизводится даже на чистом HEAD без единой моей правки
(проверил через `git show stash@{0}:...` до восстановления). Из-за этого
`node SYSTEM/smoke.js` в этом окружении сейчас не поднимает сервер вообще —
падает на `require('./PROJECTS/Graph/graph-server.js')` ещё до того, как
доходит до `/api/opencode/*`. Это не связано с OpenCode-кодом: тот же файл
падает и без единой строки моих правок. Проверено: `node -c server.js` —
синтаксис ОК; смоук на этой машине сейчас в принципе не запускается ни для
одного маршрута (не только моих) из-за этого стороннего I/O-сбоя базы —
дальнейшему агенту (или пользователю на другой машине/после перезапуска)
нужно перепрогнать `node SYSTEM/smoke.js` заново, когда `.index.db` снова
читается; добавленный мной чек `POST /api/opencode/detect не падает без
бинарника` (SYSTEM/smoke.js) готов к прогону.

Что важно знать фронтенд-агенту: `/api/opencode/connect` возвращает поле
`models` (массив строк вида `opencode/big-pickle`) — это и есть источник
списка моделей для UI, ничего не хардкодить на фронте. У `askOpenCode` нет
параметра `effort` вовсе (не отправлять). Session id из OpenCode CLI можно
передавать в `sessionId` для продолжения диалога так же, как у Claude
(`--session`), но сессия, начатая через один `id` таргета (`opencode-wsl` vs
`opencode-windows`), другим не продолжится — сервер вернёт `{type:'error'}`
с объяснением, как и у Claude.

### 2026-08-31 — разгадка disk I/O error в smoke.js

Причина найдена и не имеет отношения к OpenCode-коду вообще: на Windows прямо
сейчас живёт настоящий `server.js` пользователя (норма по CLAUDE.md — «сервер
для себя пользователь запускает сам»). Проверено: `netstat -ano` со стороны
Windows (`cmd.exe /c "netstat -ano | findstr :3001"`) показывает LISTENING на
`3001` с активными ESTABLISHED-соединениями (PID 42904). `PRAGMA journal_mode
= WAL` на `DATA/.index.db` из WSL падает с `disk I/O error` именно из-за
конкуренции WAL/shm за файл на DrvFs (`/mnt/c/...`) с этим живым Windows-
процессом — `lsof`/`fuser` со стороны WSL никого не показывают, потому что
блокировки Windows-процесса им не видны через 9p/DrvFs, но это не значит, что
держателя нет.

Вывод для следующих агентов: пока у пользователя запущен свой `server.js`,
`node SYSTEM/smoke.js` из сессии агента будет падать на открытии БД ещё до
проверки единого маршрута — это ожидаемо и не сигнал регрессии. Полагаться в
таком случае на `node -c <file>` (синтаксис) плюс ручной разбор диффа; смоук
целиком перепрогнать, когда пользователь на минуту остановит свой сервер, или
дождаться, когда он сам его перезапустит и заодно увидит новые роуты живьём.

### 2026-08-31 — клиентская часть (SYSTEM/app.js, PROJECTS/Settings/settings.js)

Сверился с записью backend-агента выше построчно перед сдачей — имена роутов
и полей совпали с тем, что уже было в коде (`/api/opencode/detect` →
`{installs}`, `/api/opencode/connect {id}` → `{ok,id,label,version,models}`,
`/api/opencode/stop {sessionId}`, `/api/opencode/ask {prompt,model,sessionId,
mode}` без `effort`, NDJSON `session|tool|text|error|done|queued`). Отдельного
вызова моделей не заводил — `models` действительно берётся только из ответа
`/connect`, как и предупреждал backend.

Что сделано:
- `SYSTEM/app.js`: `PROVIDERS[2]` (opencode) — убрал хардкод
  `qwen3-coder/kimi-k2/glm-4.6/deepseek-v3`, `models: []`/`defaultModel:
  undefined` до подключения; массив мутируется на месте в `connectOpenCode`
  (settings.js) после ответа `/connect`.
- Сохранение/восстановление подключения обобщено на пару функций
  `saveProviderState(id)`/`loadProviderState(id)` (табличка `STORE_KEYS =
  {claude:'noname.claude', opencode:'noname.opencode'}`); `saveClaudeState`/
  `loadClaudeState`/`saveOpenCodeState`/`loadOpenCodeState` — тонкие обёртки
  над ними для обратной совместимости старых мест вызова.
  `saveAllProviderStates()` — вызывается везде, где раньше было голое
  `saveClaudeState()` при смене `chatSessionId` (openSession/deselectSession/
  removeSession/sessionNew/sessionReset/startCommentSession/restoreOnLoad),
  чтобы сессия переживала reload независимо от того, каким провайдером она
  ведётся.
- `restoreServerConnection(providerId='claude')` обобщена (была жёстко на
  Claude), бьёт в `API_PREFIX[providerId] + '/connect'`;
  `restoreOnLoad` теперь восстанавливает оба провайдера параллельно (каждый
  по своему ключу localStorage).
  `API_PREFIX = {claude:'/api/claude', opencode:'/api/opencode'}` — общая
  таблица для `sendToClaude`/`stopClaude`/`restoreServerConnection`.
- `getActiveProviderId()` — новая функция: провайдер берётся из выбранного
  значения строки шапки сессии (`chatSessionProviderSelect`), с фолбэком на
  первый подключённый. `renderSessionBarControls`/`renderSessionModelEffort`
  переписаны так, чтобы строка шапки показывала только реально подключённых
  провайдеров (было: показывала все PROVIDERS всегда, даже неподключённые, и
  сама панель была видна только если подключён Claude — это и была причина
  комментария «выбор провайдера пока информационный», теперь убрана).
- `streamAsk(apiPrefix, body, onEvent)` — добавлен первый параметр
  `apiPrefix`; `sendToClaude`/`stopClaude` вычисляют `apiPrefix` через
  `getActiveProviderId()` и реально бьют в `/api/opencode/*`, когда в шапке
  выбран OpenCode. Названия `sendToClaude`/`stopClaude`/`streamAsk`/
  `readNdjson`/`makeRenderer` не переименовывал (как просили) — только
  обобщил их тело; внешне (`window.App`) эти функции и не были видны.
  `readNdjson`/`makeRenderer` не трогал вовсе.
- Проверка «не подключён» в потоке `sendToClaude` была жёстко на строку
  `'Claude не подключён'` — заменил на `event.error.includes('не подключён')`,
  чтобы одинаково срабатывало и для `'OpenCode не подключён'` (сервер шлёт
  такую ошибку через общий `askOpenCode`, судя по описанию backend-агента).
- `window.App` экспорт: добавил `saveProviderState` (нужен settings.js для
  сохранения состояния OpenCode при подключении/смене модели). Заодно вернул
  `openSession` в экспорт — по ходу работы несколько раз ловил обнуление
  части своих правок в `app.js`/`settings.js` до состояния, предшествующего
  моей сессии (не только моих правок — например, `openSession` пропадал из
  `window.App`, а блок `renderDefaultViewOptions` в settings.js пропадал
  целиком) без моего участия; каждый раз перечитывал файл и переносил правки
  заново. Похоже на конкурентную правку тех же файлов чем-то ещё во время
  этой сессии (не backend-агент — тот работал только в `server.js`/
  `smoke.js`). Следующему агенту, если правит эти же файлы: после каждой
  правки стоит перечитать файл целиком перед тем как считать её финальной.
- `PROJECTS/Settings/settings.js`: не переименовывал `connectClaude` — завёл
  рядом `connectOpenCode(install)`, зеркало `connectClaude`, но пишет
  `provider.models = result.models` в сам объект `PROVIDERS` (opencode) и
  `App.saveProviderState('opencode')` вместо `App.saveClaudeState()`.
  `pickInstall(installs, onPick, providerLabel)`/`showNotFound(providerLabel)`
  обобщены (раньше были жёстко под Claude — статичный заголовок picker-окна
  «Where should Claude CLI run?»/текст ошибки); теперь принимают колбэк и
  подпись, заголовок picker-модалки (`#pickerTitle`) выставляется
  динамически. Обработчик клика по `[data-provider]` — добавлена ветка
  `id === 'opencode'` (detect → 0/1/many, как у Claude), ветка disconnect
  дополнена для opencode (`App.saveProviderState('opencode')`), обработчик
  `change` на `[data-provider-select]` — добавлена ветка opencode.

Не проверено (вне периметра этой роли): живой прогон в браузере (клик
«Подключить» у OpenCode, реальный ответ `/api/opencode/ask` в чате,
сохранение/восстановление после reload) — сервер не запускался по правилу
проекта (`CLAUDE.md`: не поднимать `server.js` из сессии). Синтаксис
(`node -c`) недоступен в песочнице этой роли (нет инструмента для shell-
команд) — проверка сделана вручную построчным перечитыванием обоих файлов
целиком после каждой правки; структура кода (скобки/функции) визуально
непротиворечива, но финальный `node -c SYSTEM/app.js` и
`node -c PROJECTS/Settings/settings.js` пользователю/ревьюеру стоит
прогнать самостоятельно перед мержем — особенно учитывая случаи стороннего
затирания файлов во время этой сессии, описанные выше.
### 2026-08-31 — ревью стыка (без правок)

Прочитал оба журнала выше целиком, сверил контракт по коду (не по описанию):
`server.js:950-1327` (коннектор), `server.js:1785-1829` (роуты), `SYSTEM/app.js`,
`PROJECTS/Settings/settings.js` — построчно, плюс `git diff --stat`/`git diff`
по всем четырём файлам целиком.

Результат: расхождений контракта не нашёл, правок не потребовалось.
- Имена полей и маршруты совпадают дословно: `/api/opencode/detect` →
  `{installs}`, `/connect {id}` → `{ok,id,label,version,models}`, `/stop
  {sessionId}` → `{ok,stopped}`, `/ask {prompt,model,sessionId,mode}` (без
  `effort` — фронт всё равно шлёт `claude.effort: undefined` в теле, сервер
  это поле у OpenCode просто не читает, деструктуризация `{prompt, model,
  sessionId, mode}` — не баг).
- Изоляция от Claude подтверждена `grep`: `activeTarget`/`CLAUDE_MODELS`
  трогает только код Claude (`server.js:349,362,605`), у OpenCode свои
  `activeOpenCodeTarget`/`OPENCODE_TARGETS`/`OPENCODE_BIN`; `STORE_KEY` на
  фронте — тонкая обёртка над новой `STORE_KEYS{claude,opencode}`, старые
  вызовы `saveClaudeState()` не потерялись.
- Хардкода моделей не осталось (`grep -r "qwen3-coder\|kimi-k2\|glm-4.6\|
  deepseek-v3"` — пусто), `PROVIDERS[2].models` пустой массив до `/connect`,
  наполняется `result.models` в `connectOpenCode`.
- Общая очередь по файлам не задвоена: `askOpenCode` использует те же
  `activeRuns`/`waitForFileTurn`/`candidateFiles`/`stopActiveRun`, что и
  `askClaude` — второй Map не заведено, `stopActiveRun` ищет по sessionId,
  провайдеро-агностичен.
- DB-хелперы (`startExchange`/`recordStep`/`recordAssistantText`/
  `finishExchange`/`setMessageMode`/`setMessageToolResult`) вызываются с
  корректной арностью — сверил с `db.prepare`/сигнатурами функций, включая
  расширенный `setMessageToolResult` (пятый параметр `tool_result_images` —
  OpenCode передаёт `null`, это нормально, у него нет такого понятия).
- `#pickerTitle` не найден в `index.html` — сначала показалось багом, но это
  ложная тревога: разметка `pickerModal` (включая `#pickerTitle`) собирается
  динамически в самом `settings.js` (`pickerModal.innerHTML = ...`), как и
  положено по правилу «своя разметка + логика провайдеров» из CLAUDE.md.
- Язык комментариев — весь новый код на русском (`git diff | grep '^\+.*//'`
  без не-кириллических строк, кроме пустых `+//`). Новых `require()` нет,
  весь новый функционал использует только уже импортированные `fs/os/path/
  child_process`. JS не попал в `<script>` внутри `index.html` — правка
  `index.html` в этом дифе вообще не про OpenCode (три строки Flow-вкладки,
  не имеет отношения к этой задаче).
- Большой диф `server.js` до строки ~950 (хуки/thinking/redacted_thinking/
  resultMeta в `askClaude`) — не относится к OpenCode-задаче вообще, это
  уже было в рабочем дереве до начала обеих ролей (репозиторий был грязным
  ещё до старта, см. `git status` в начале сессии). Не трогал, не проверял
  по существу — вне периметра этого ревью.
- `node -c server.js`/`SYSTEM/app.js`/`PROJECTS/Settings/settings.js` — все
  все три ОК. `node SYSTEM/smoke.js` падает тем же `disk I/O error` при открытии
  `.index.db`, что описано в записи выше («разгадка disk I/O error») —
  подтвердил ту же причину (живой Windows-сервер пользователя на 3001),
  не связано с кодом OpenCode; чек `POST /api/opencode/detect не падает без
  бинарника` в `SYSTEM/smoke.js` синтаксически корректен и готов к прогону,
  когда порт освободится.

Известные ограничения (не баги, зафиксированы явно предыдущими агентами и
подтверждены мной): нет `effort`/`variant` у OpenCode, нет ограничения
инструментов на уровне флагов CLI для режима Chat/Action, нет аналогов
thinking/hooks/rate_limit — это ожидаемо, у OpenCode CLI таких концепций нет.

Вердикт: готово к ручной проверке в браузере. Живой прогон (клик
«Подключить» у OpenCode, реальный `/api/opencode/ask` в чате, реальный путь
к `opencode`/`opencode.exe` на Windows) не проверял — недоступно в этой
WSL-сессии без живого браузера и без подтверждённого Windows-пути к
бинарнику (см. факты вверху файла: Windows-сторона не проверялась вживую).
