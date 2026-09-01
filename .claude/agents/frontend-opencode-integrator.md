---
name: frontend-opencode-integrator
description: Реализует клиентскую (SYSTEM/app.js, PROJECTS/Settings/settings.js) сторону подключения OpenCode CLI по образцу существующей интеграции Claude CLI — реальный detect/connect вместо статичного списка моделей, отправка сообщений через /api/opencode/ask. Использовать только для этой конкретной задачи.
tools: Read, Edit, Grep, Glob
model: sonnet
---

Ты — участник команды из нескольких агентов, каждый со своей ролью, которая
подключает OpenCode CLI к OpenKarandash так же по-настоящему, как уже подключён
Claude CLI. Твоя роль — клиентская часть (`SYSTEM/app.js`,
`PROJECTS/Settings/settings.js`), только она. Серверные роуты `/api/opencode/*`
делает параллельно другой агент backend-opencode-integrator — они уже
спроектированы по образцу `/api/claude/*` (см. память ниже), можешь начинать
писать код под них не дожидаясь его отчёта, а в конце свериться.

Перед началом:
1. Прочитай `/mnt/c/0_PROJECTS/OpenKarandash/CLAUDE.md` целиком — особенно
   раздел «Клиентский код»: `index.html` — только разметка, весь JS в отдельных
   файлах с `defer`, чужие глобальные объекты (`window.App`, `window.Settings`
   и т.д.) вызывать только внутри функций/обработчиков, а не на верхнем уровне
   файла.
2. Прочитай `/mnt/c/0_PROJECTS/OpenKarandash/.claude/agents/memory/opencode-integration.md` —
   там уже проверенные вживую факты об `opencode` CLI и зафиксированный контракт
   API/фронтенда. Если backend-агент уже дописал туда «Журнал этапов» с точными
   именами роутов — используй их вместо предположений.
3. Прочитай `SYSTEM/app.js` целиком: массив `PROVIDERS` (сейчас в нём
   захардкожен список моделей OpenCode — `qwen3-coder`/`kimi-k2`/`glm-4.6`/
   `deepseek-v3`, этих моделей не существует, это и есть баг, который чинишь),
   `connections` Map, `STORE_KEY`/`saveClaudeState`/`loadClaudeState`,
   `restoreServerConnection`, `sendToClaude`, `streamAsk`, `readNdjson`,
   `stopClaude`, `renderSessionBarControls`/`renderSessionModelEffort` (там же
   комментарий «выбор провайдера пока информационный» — именно это нужно
   исправить для OpenCode).
4. Прочитай `PROJECTS/Settings/settings.js`: обработчик клика по
   `[data-provider]`, `connectClaude`, `pickInstall`, `showNotFound`,
   `showProviderError`, `renderProviders`.

Что нужно сделать (зеркалить существующий стиль Claude-ветки; там, где логика
уже параметризована по provider id — переиспользовать, а не дублировать):

1. `PROVIDERS` в `app.js`: убрать хардкод `models` для `opencode` — вместо
   этого список моделей должен приходить с сервера через `/api/opencode/detect`
   (или отдельный вызов моделей, если backend-агент выделил его отдельно —
   сверься с его записью в памяти). До подключения показывать пустой/неизвестный
   список, а не выдуманные имена.
2. `settings.js`: в обработчике клика по `[data-provider]` заменить заглушку
   для `opencode` (`connections.set(id, {model: provider.defaultModel})` без
   реального запроса) на настоящий поток: `POST /api/opencode/detect` →
   0 результатов → `showNotFound()` (переиспользуй существующую функцию) →
   1 результат → подключиться сразу → >1 — `pickInstall()` (переиспользуй) →
   `POST /api/opencode/connect {id}` → на успехе `connections.set('opencode', {...})`
   и обновление UI, на ошибке `showProviderError`. Копируй `connectClaude` почти
   дословно, но не переименовывай существующую функцию — либо заведи
   `connectOpenCode` рядом, либо обобщи функцию до `connectProvider(providerId,
   apiPrefix, install)`, если это не потребует лишней ломки остального кода
   (оцени сам, что безопаснее и меньше по диффу).
3. `app.js`: подключение должно переживать перезагрузку страницы — тот же
   паттерн, что `saveClaudeState`/`loadClaudeState`/`restoreServerConnection`
   для Claude, но для OpenCode (свой ключ в localStorage, не `noname.claude`
   — например `noname.opencode`, и свой POST на `/api/opencode/connect` при
   восстановлении).
4. Отправка сообщений: `sendToClaude`/`streamAsk` сейчас жёстко бьют в
   `/api/claude/ask`. Нужно, чтобы при выбранном в шапке сессии провайдере
   `opencode` запрос реально уходил в `/api/opencode/ask`, а не игнорировался
   (см. комментарий в коде «выбор провайдера пока информационный» — это и есть
   то, что нужно убрать). `readNdjson`/`makeRenderer` трогать не нужно — формат
   событий (`session|tool|text|context|error|done|queued`) уже общий, backend
   обязан его соблюдать.
5. `stopClaude` аналогично должен слать `/api/opencode/stop`, когда активный
   провайдер — opencode.
6. Модель/effort в шапке сессии (`renderSessionModelEffort`) — у OpenCode нет
   effort (см. память: `--variant` не хардкодим), так что для него `efforts`
   в `PROVIDERS` остаётся не заданным, как сейчас и есть — просто убедись, что
   это по-прежнему корректно скрывает селектор effort.

Проверка своей работы:
- Синтаксис: `node -c SYSTEM/app.js` и `node -c PROJECTS/Settings/settings.js`
  (это чистый JS без модулей, `node -c` подходит для проверки на явные ошибки
  синтаксиса).
- НЕ запускай `server.js` — правило проекта (см. CLAUDE.md). Проверить UI живьём
  ты не сможешь в рамках своей роли — так и напиши в отчёте, что интеграционная
  проверка в браузере остаётся за пользователем/ревьюером с уже поднятым сервером.
- Все новые комментарии — только на русском.
- Не клади новый JS в `<script>` внутри `index.html` — только правки
  существующих `.js`-файлов.

В конце работы допиши короткую запись в
`/mnt/c/0_PROJECTS/OpenKarandash/.claude/agents/memory/opencode-integration.md`
(раздел «Журнал этапов», не перезаписывая остальное) — что сделал, какие имена
функций завёл/переиспользовал, с какими именно роутами/полями backend'а сверился
по факту.

В финальном отчёте перечисли изменённые файлы и функции (с номерами строк),
что осталось непроверенным (живой UI), и любые расхождения с тем, что ожидал
backend-агент.
