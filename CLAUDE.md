Общие правила проекта — в `AGENTS.md`, читать в первую очередь: их должен знать и соблюдать любой агент, а не только Claude. Здесь — только то, что специфично именно для Claude Code.

**`AGENTS.md` обязателен целиком, а не выборочно.** Перечитывай его полностью в начале сессии (а не полагайся на память о прошлых сессиях) и соблюдай каждый пункт до конца диалога, включая язык ответа в чате (раздел «Конвенции» в `AGENTS.md`) — это обязательное условие, а не рекомендация, и оно не отменяется длиной разговора, сжатием истории или тем, что правило уже когда-то применялось раньше.

## Claude из WSL

Сервер умеет звать не только Windows-CLI, но и WSL (`server.js`, `TARGETS`): `wsl.exe bash -lc "claude ..."`, cwd при этом становится `/mnt/c/...`. Поведение там **не полностью совпадает** с Windows — что важно знать:

- Папку проекта в WSL нужно один раз пометить доверенной, иначе `.claude/settings.json` (permissions и хуки) игнорируется целиком. Проверка — запустить `claude` в `/mnt/c/...` и принять диалог, либо выставить `projects["/mnt/c/0_PROJECTS/OpenKarandash"].hasTrustDialogAccepted: true` в `~/.claude.json` **внутри WSL** (у Windows и WSL это разные файлы).
- Файловых блокировок между сессиями больше нет: сервер (`server.js`, `activeRuns`/`waitForTurn`) выполняет задания всех CLI строго по очереди, поэтому конфликтующей записи в один файл одновременно быть не может. WSL-адрес серверу больше отдельно не нужен — из виртуалки всё API, кроме локального, по-прежнему отвечает 403, но править файлы WSL-claude и так может напрямую, через `/mnt/c/...`.
- Сессию можно продолжить любым CLI, а не только тем, что её начал. Наш id сессии и id внутри CLI — разные вещи: второй лежит в таблице `session_cli` по паре «сессия + цель» и используется только для `--resume` этого же CLI. У кого своей записи нет — начинает свою сессию, а контекст получает пересказом последних ходов из нашей базы.
- История запусков у каждого CLI своя: `~/.claude/projects/C--0-PROJECTS-OpenKarandash` (Windows) и `-mnt-c-0-PROJECTS-OpenKarandash` (WSL) — то есть даже у двух Claude она разная. Поэтому `--resume` уходит только с тем id, который выдал этот же CLI (см. пункт выше про `session_cli`), а не с нашим id сессии.
- Глобальные `~/.claude/settings.json` у Windows и WSL свои: язык ответа, набор хуков, плагинов, скиллов и субагентов различается. Модель и effort расхождением не будут — сервер передаёт их флагами на каждый запуск.
- Команды PowerShell из `AGENTS.md` (поиск зомби) в WSL не работают — там `ps aux | grep server.js`.


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
