# 026. Hermes в Docker подключается к Claude через claude-bridge, а не через ANTHROPIC_API_KEY

Цель — дать серверу доступ ко всему потенциалу Hermes (память, скиллы, крон,
суб-агенты) под тем же UI, которым уже пользуется этот проект, не заводя
отдельного биллинга поверх уже оплаченной подписки Claude Code.

## Решение

- `hermes/` — `hermes-agent` (NousResearch) подключён как git submodule, а не
  скопирован файлами: сохраняется история апстрима и возможность обновляться
  `git submodule update --remote`.
- `claude-bridge/` — OpenAI-совместимый HTTP-шим (`/v1/models`,
  `/v1/chat/completions`) поверх уже установленного `claude` CLI. Живёт **на
  хосте**, не в контейнере — он сам управляет CLI, который стоит на хосте.
  Готовый рабочий код (не написан с нуля): исчерпывающий `--disallowed-tools`,
  эмуляция tool-calling через системный промпт, картинки, стриминг. Подробности
  и измерения — `claude-bridge/README.md`.
- Hermes поднимается в Docker (`docker-compose.hermes.yml` поверх
  `hermes/docker-compose.yml`, запуск — `./hermes-start.sh`). Контейнер видит
  бридж через `host.docker.internal:8787` (не `network_mode: host` и не
  `127.0.0.1` — под Docker Desktop «host» означает сеть VM самого Docker, а не
  машину WSL/Windows).
- Внутри контейнера Hermes сам поднимает свой OpenAI-совместимый agent API
  (порт 8642, ключ в `API_SERVER_KEY`) — это ПОЛНЫЙ агент со своими
  инструментами и памятью, а не голая модель. Поэтому коннектор `server.js`
  (`OpenKarandash-ykb.4`) будет ходить именно сюда обычным HTTP, а не
  реализовывать ACP JSON-RPC по stdio — тот путь сложнее и не даёт ничего
  сверх того, что уже отдаёт agent API.
- `claude` CLI остаётся вне Docker (Windows/WSL, как и раньше) — только он
  трогает подписку.

## Что не переносится в репозиторий

- `hermes-home/` — данные конкретного запуска Hermes (сессии, история) не
  копируются: заводится пустой каталог, своя копия для этого проекта.
- Секреты (`CLAUDE_BRIDGE_TOKEN`, `API_SERVER_KEY`, логин/пароль дашборда) —
  только в `.env` (не коммитится), в репозитории — `.env.example` с пустыми
  полями, как и с остальными секретами проекта (`AGENTS.md`, «Конвенции»).
- `claude-bridge/claude-config/` — кеш аккаунта Claude Code для
  экспериментального ACP-бэкенда шима (`CLAUDE_BRIDGE_BACKEND=acp`), содержит
  email и org id владельца подписки. Бэкенд по умолчанию и рекомендованный —
  `cli`, ему этот каталог не нужен.

## Переменные окружения стека

`claude-bridge/.env` — по образцу `claude-bridge/.env.example`. Корневой
`.env` (тот же файл, что уже создаёт себе `server.js` с `PORT`) должен
дополнительно нести: `CLAUDE_BRIDGE_TOKEN` (тот же, что в
`claude-bridge/.env`), `API_SERVER_KEY`, `HERMES_DASHBOARD_BASIC_AUTH_USERNAME`
/ `_PASSWORD` / `_SECRET`, опционально `HERMES_UID`/`HERMES_GID` (по умолчанию
свои `id -u`/`id -g`, `hermes-start.sh` подставляет их сам).

## Почему не ACP-клиент в самом server.js

Изначальный план (пока не проверили, что уже есть у Hermes) — держать в
`server.js` постоянный процесс `hermes acp` и разговаривать с ним по JSON-RPC
(тот же протокол, что использует Zed). От этого отказались, когда нашли, что
Hermes в Docker уже отдаёт готовый OpenAI-совместимый API со всем тем же
функционалом — обычный HTTP-коннектор в стиле уже существующих
(`runClaude`/`runOpenCode`/`runCodex`) сильно проще и ничего не теряет.
