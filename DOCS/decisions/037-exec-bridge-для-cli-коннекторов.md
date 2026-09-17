# 037. exec-bridge — общий host-мост для CLI-коннекторов

Продолжение `DOCS/план-докеризации-коннекторов.md` (этап 1 — дизайн, зафиксирован там же).
Этап 2 — пилот: сам мост (`exec-bridge/`) и подключение к нему одного коннектора
(`runOpenCode`), чтобы проверить схему живым ходом прежде, чем переводить остальные три.

## Почему один мост, а не пять

`runClaude`, `runOpenCode`, `runCodex`, `runPi` и скриншот Karandash — везде одна и та же
форма: `spawn(cmd, args)`, построчный NDJSON из stdout, таймаут, `killProcessTree` (умеет
gasit и дерево процессов Windows, и процесс внутри WSL по PID-маркеру `REMOTE_PID_MARK`).
Claude уже получил отдельный мост (`claude-bridge/`, решение `029`) — но это
OpenAI-совместимый шim специально под формат Hermes, остальным трём коннекторам такая
обёртка не нужна, им нужен голый удалённый exec. Поэтому — один универсальный сервис
(`exec-bridge/`, Python на стандартной библиотеке, тот же подход, что у `claude-bridge`),
а не четыре копии одной и той же обвязки.

## Контракт

`POST /exec` принимает уже полностью собранные сервером `cmd`/`args` (весь выбор цели,
`wsl.exe`-обёртка, флаги модели остаются в `server.js` — мост про конкретный CLI ничего не
знает) и отвечает NDJSON-потоком: `{type:"started", runId}` → `{type:"line", text}`* →
`{type:"done", code, stderr, timedOut}`. `POST /exec/<runId>/kill` — то же самое, что
`killProcessTree` делает локально сейчас: если исходная цель была `viaShell` (`wsl.exe`),
мост переиздаёт `kill -TERM <pid>` внутри той же виртуалки по PID-маркеру, иначе на Windows
добавляет `taskkill /T /F`. Полный протокол — `exec-bridge/README.md`.

На стороне `server.js` завёден клиент `execViaBridge(cmd, args, {timeoutMs, onLine, onSpawn,
shellPrefix})` с тем же внешним контрактом, что у локального `spawn`-пути (Promise,
`onLine`, `onSpawn` отдаёт объект с `.kill()`), только `onSpawn` получает не настоящий
`ChildProcess`, а объект-обёртку, которая на `.kill()` шлёт мосту `POST
/exec/<runId>/kill` — `killProcessTree`/`stopActiveRun` не видят разницы и не менялись.

## Что подключено пилотом

Только `runOpenCode` — самый полно реализованный из некитайских коннекторов после Claude
(порядок этапов зафиксирован в плане). Переключатель — `EXEC_MODE=remote` в `.env`
(+ `EXEC_BRIDGE_URL`, по умолчанию `http://host.docker.internal:8789`, `EXEC_BRIDGE_TOKEN`
для общего секрета). Без `EXEC_MODE` поведение не меняется вовсе — `runOpenCode` идёт
прежним локальным `spawn`. `runClaude`, `runCodex`, `runPi` и скриншот Karandash пока не
тронуты — это следующие шаги плана (3–5), а не эта задача.

## Проверка

`node --check server.js` — синтаксис в порядке. Живой прогон (контейнерный `server.js` →
мост → `opencode` на хосте → настоящий ответ) — отдельный шаг: `exec-bridge/` ещё не
заведён в стек сторожа (`SYSTEM/core/hermes-stack.js`), пока запускается вручную на хосте,
что и написано в `exec-bridge/README.md`. Дальше по плану — этап 3 (проверка пилота живым
ходом), только после него имеет смысл двигаться к `pi`/`codex`.
