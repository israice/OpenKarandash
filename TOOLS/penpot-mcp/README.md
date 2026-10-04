---
name: penpot-mcp
description: Подключение плагина Penpot к MCP-серверу без ручной возни и без кнопки Connect — скрипт входит под сервисным аккаунтом, открывает нужный файл, запускает плагин и соединяет его сам. Нужен перед любой работой через MCP: без подключённого плагина сервер отвечает «No Penpot plugin instances are currently connected», потому что операции над макетом выполняет не сервер, а JS-рантайм плагина в браузере.
---

# Плагин Penpot для MCP

MCP-сервер Penpot не рисует ничего сам: он передаёт код в плагин, запущенный в браузере, и ждёт ответа. Пока плагин не подключён, любой инструмент (`execute_code`, `export_shape`) падает с «No Penpot plugin instances are currently connected». Подключение в интерфейсе — один клик, но кликает человек, а агент, который рисует макет, кликать не умеет.

`connect.mjs` делает это целиком: поднимает отдельный безголовый Edge со своим профилем `C:\Users\Public\penpotmcp\profile` (профиль владельца не трогаем — так же, как `SYSTEM/live-check.mjs`), входит под сервисным аккаунтом из `.env`, открывает файл из `PENPOT_FILE_ID`/`PENPOT_TEAM_ID`/`PENPOT_PAGE_ID`, открывает Plugins → Penpot MCP Plugin и соединяет плагин.

```bash
node TOOLS/penpot-mcp/connect.mjs
```

Браузер остаётся жить намеренно: пока вкладка открыта, плагин на связи. Уронить его потом можно по профилю:

```bash
Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like '*penpotmcp*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

## Почему кнопка Connect не нужна

Три вещи должны сойтись, иначе соединение не проходит:

1. **MCP-сервер без `--multi-user`.** В многоимённом режиме плагин требует `userToken`, а он есть только у того, кто сам сгенерировал MCP-ключ в Integrations; локальному стенду с одним пользователем ключ не нужен. В `deploy/penpot/docker-compose.yaml` у сервиса `penpot-mcp` стоит `command: ["node", "index.js"]` — без флага.
2. **Прокси `/mcp/ws`.** Плагин, получив кнопку Connect без адреса, берёт относительный путь `/mcp/ws` на origin самого Penpot (`plugins/mcp/index.js`). Прокси на этот путь уже есть в образе фронтенда (`/etc/nginx/overrides/server.d/mcp-locations.conf`), ничего дописывать не нужно.
3. **Клик из изолированного мира.** Обработчик кнопки в 2.18 не ловит ни `click()` из контекста страницы, ни синтетические события CDP по координатам — ловит только `dispatchEvent` из отдельного execution context. Поэтому скрипт создаёт isolated world кадра плагина и шлёт событие через `Runtime.callFunctionOn`.

Соблазнительно решить, что дело в прокси, и дописать свой `location /mcp/ws` в nginx: не нужно, такой location уже есть, и лишний файл падает nginx'ом с «duplicate location».

## Доступ человека к макету без приглашения

`grant-access.mjs` выдаёт браузерному аккаунту права редактора в команде макета:

```bash
node TOOLS/penpot-mcp/grant-access.mjs                       # e-mail из PENPOT_VIEWER_EMAILS
node TOOLS/penpot-mcp/grant-access.mjs someone@example.com   # свой список
```

Без этого Penpot отдаёт всякому, кто не в команде файла, текст «You don't have access to this file. To access this file, you can ask the team owner» — в том числе канвасу, встроенному в `PROJECTS/Penpot/page.js`, потому что iframe открывается в сессии браузера человека. Официальный путь (`create-team-invitations`) требует письма и клика по ссылке, а скрипт пишет членство прямо в `team_profile_rel`: права появляются сразу, по обычному обновлению страницы. Аккаунт должен уже существовать в Penpot (он появляется при первом входе); если его нет — скрипт скажет об этом и ничего не сломает.

## Если соединение не поднялось

Проверь по порядку: статус плагина в окне (или в `status` на выходе скрипта), `docker logs penpot-penpot-mcp-1` — там должен появиться `PluginBridge`, и сам адрес `ws://localhost:9001/mcp/ws` (через прокси фронтенда) — его стоит проверить отдельно, если Penpot переехал на другой порт.

## Если MCP нужен вообще без браузера

Рисовать можно и без плагина — напрямую через API Penpot (`update-file`, токен `PENPOT_ACCESS_TOKEN`). Зависимостей и браузера нет, но координаты, метрики текста и id фигур приходится считать самому; плагин-API делает это сам и даёт ещё библиотеки, токены и автолэйаут.