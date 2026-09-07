# 026. Протокол оркестрации на beads подключён поверх наших правил

Дата: 2026-09-05

## Что решили

Поставили [The Claude Protocol](https://github.com/AvivK5498/The-Claude-Protocol) — набор
агентов, хуков и рабочего процесса «одна задача = один бид = один worktree» поверх beads CLI.
Исходник скилла лежит в `.agents/skills/create-beads-orchestration/` (папка в `.gitignore`),
источник и хеш зафиксированы в `skills-lock.json`, сам скилл подключён копией
`SKILL.md` в `.claude/skills/create-beads-orchestration/`.

## Почему так, а не запуском bootstrap «как есть»

`bootstrap.py` рассчитан на пустой проект и три наших файла перезаписывает целиком:

- `CLAUDE.md` — заменяется шаблоном оркестратора. Мы вернули свой, а шаблон положили
  рядом справкой: `.claude/protocol-orchestrator.md`.
- `.claude/settings.json` — заменяется на свой набор хуков (`shutil.copy2`, без слияния).
  Мы восстановили свой файл и **дописали** в него 14 хуков протокола, поэтому наши пять
  (`context-files-node`, `language-reminder`, `language-check`, `no-bg-server`,
  `syntax-check`) остались на месте.
- `install_rams()` и `install_web_interface_guidelines()` тянут `curl … | bash` с чужих
  сайтов (rams.ai, vercel.com). Мы их пропустили заглушками в `PATH`: инструменты нужны
  только фронтенд-супервизорам протокола, а живой интерфейс у нас проверяет свой агент
  `ui-checker` через Playwright MCP (`AGENTS.md`, «Проверка изменений»).

Резервные копии до установки — `DATA/_backup-before-protocol/`.

## Что появилось в проекте

- `bd` 1.2.2 глобально (`npm i -g @beads/bd`) и `jq` в `~/.local/bin` — на `jq` завязаны
  13 из 14 хуков протокола, без него они молча ломаются.
- `.beads/` — задачи (Dolt), плюс собственная секция в `AGENTS.md`: `bd` вместо TodoWrite
  и markdown-списков. Дубль той же секции в `CLAUDE.md` убран — общее правило живёт
  в `AGENTS.md`, там ему и место.
- `.claude/agents/` — семь агентов протокола (scout, detective, architect, scribe,
  code-reviewer, merge-supervisor, discovery) рядом с нашими тремя.
- `.claude/hooks/*.sh` — 14 хуков дисциплины; `.claude/skills/` — react-best-practices
  и subagents-discipline.
- `.codex/` — хуки beads для Codex CLI (их завёл сам `bd init`).

`bd init` сделал это отдельным коммитом от имени пользователя (`bd init: initialize beads
issue tracking`) — это его штатное поведение, а не наша команда.

## Чем это меняет работу

Главное последствие: `block-orchestrator-tools.sh` запрещал Edit/Write на ветке `main` —
либо ветка под задачу, либо полный цикл «бид → worktree → супервизор → ревью». Это и есть
смысл протокола, но он задевал и сессии, запущенные из интерфейса: они ходят тем же CLI и
упирались в тот же запрет. В итоге хук сняли — см. раздел ниже.

Второе: хуки протокола — bash со `jq`. WSL-claude их выполнит, Windows-claude — только
если у него в `PATH` есть `bash` и `jq` (`CLAUDE.md`, «Claude из WSL»). У двух наших CLI
поведение здесь расходится.

Откат — вернуть три файла из `DATA/_backup-before-protocol/` и удалить `.claude/hooks/*.sh`.

## Что изменилось после первой задачи

Discovery создал двух супервизоров под наш стек — `node-backend-supervisor` (сервер,
`node:sqlite`, шаблоны) и `vanilla-js-supervisor` (клиент без фреймворка, htmx). Ни
react/vue, ни infra/mobile/ML супервизоров не заводили: в проекте нет ни фреймворка,
ни Docker/CI/Terraform.

**Блокировку правок на `main` сняли** — из `.claude/settings.json` убраны
`block-orchestrator-tools.sh` и `enforce-branch-before-edit.sh`. Сами файлы хуков
лежат на месте, вернуть их — строчка в настройках. Причина: у репозитория нет
`origin`, и цикл протокола на нём буксует — `validate-completion.sh` ждёт `git push`,
которого некуда сделать, а ветку под каждую задачу всё равно приходится сливать
руками. Плюс правки идут не только из терминала, но и из сессий интерфейса — они
ходят тем же CLI и упирались бы в тот же запрет.

Что осталось от дисциплины: бид на каждую задачу, ревью перед закрытием, worktree под
работу супервизора, запрет TodoWrite в пользу `bd`. Это соблюдается договорённостью и
хуками `enforce-bead-for-supervisor` / `validate-completion`, а не запретом на запись.

Ещё две вещи протокола к нашему проекту не прикладываются: `validate-completion.sh`
требует `git push` при отсутствующей удалёнке, а `code-reviewer` требует DEMO с
запуском приложения — запускать сервер из сессии у нас нельзя (`AGENTS.md`, хук
`no-bg-server.js`), живой интерфейс смотрит пользователь.
