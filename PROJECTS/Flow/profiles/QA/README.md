# Профиль QA для pi

Папка — настоящий каталог агента pi (`PI_CODING_AGENT_DIR`), а не описание для
человека. Всё, что здесь лежит, pi читает сам, если запустить его так:

```bash
PI_CODING_AGENT_DIR=PROJECTS/Flow/profiles/QA pi -p --mode json -- "…"
```

У каждого работника канваса Flow — своя такая папка рядом (`profiles/<Работник>/`):
свой промпт, своя модель, свой набор инструментов, свои MCP-серверы. Почему
именно так — `DOCS/decisions/028`.

## Что чем является

| Файл | Кто его читает | Панель ноды |
|---|---|---|
| `settings.json` | pi (`docs/settings.md`) | **Thinking** (`defaultThinkingLevel`), **Permissions** (`defaultTools`, `defaultProjectTrust`), **Model** (`defaultProvider`, `defaultModel`) |
| `SYSTEM.md` | pi — заменяет системный промпт (`docs/usage.md`) | **System Prompt** |
| `APPEND_SYSTEM.md` | pi — дописывается к промпту | **Soul** |
| `mcp.json` | пакет `pi-mcp-adapter` (`<agent dir>/mcp.json`) | **MCP** |
| `extensions/permission-gate.ts` | pi — расширение подхватывается само из `extensions/` | **Permissions** |
| `sessions/`, `auth.json` | pi заводит их сам при первом запуске | — |

## Что в pi считается «разрешениями»

Режимов разрешений, окон подтверждения и песочницы у pi нет (`docs/security.md`,
`docs/usage.md`). Рычагов ровно четыре, и все они здесь:

1. **Список инструментов.** Встроенные: `read`, `bash`, `powershell`, `edit`,
   `write`, `grep`, `find`, `ls`. Стартовый набор — `defaultTools` в
   `settings.json`; разово перебивается флагами `--tools` (строгий allowlist
   сразу для всех инструментов, включая расширения), `--exclude-tools`,
   `--no-builtin-tools`, `--no-tools`. У QA нет `write` и `edit`: тестировщик
   читает и запускает, но не правит.
2. **Что грузится в сессию:** `--no-extensions`, `-e <путь>`, `--skill`,
   `--no-skills`, `--no-context-files`.
3. **Доверие проекту.** `.pi/settings.json`, `.pi/SYSTEM.md`, `.pi/extensions`,
   `.agents/skills` грузятся только у доверенной папки. В неинтерактивных
   режимах (`-p`, `--mode json`, `--mode rpc`) диалога доверия нет, поэтому при
   дефолтном `"ask"` они молча игнорируются — здесь стоит
   `"defaultProjectTrust": "always"`, разовая замена — флаг `-a`/`--approve`.
4. **Изоляция.** Ограничить сеть или пути можно только снаружи pi: Gondolin
   micro-VM, Docker, OpenShell (`docs/containerization.md`). Внутри процесса
   граница одна — гейт `extensions/permission-gate.ts`, возвращающий
   `{ block: true, reason }` на вызов инструмента.

## Чего пока нет

- Поля панелей ноды QA (`flowQaPrompt`, `flowQaSoul`, `flowQaThinking`,
  `flowQaPermissions`, `flowQaMcp`, `flowQaModel`) в эти файлы не пишутся: панель хранит текст
  в состоянии Flow, а файлы правятся руками через иконку 📄 у заголовка панели.
- Панели **Skills**, **Agents** и **Memory** ноды QA своего файла в профиле не
  имеют вовсе: навыки pi берёт из `.agents/skills` проекта, а субагентов и памяти
  между сессиями у него нет — текст этих панелей живёт только в состоянии Flow
  (`flowQaSkills`, `flowQaAgents`, `flowQaMemory`).
- Сервер (`askPi` в `server.js`) `PI_CODING_AGENT_DIR` ещё не выставляет — ходы
  идут на общем каталоге `~/.pi/agent`. Пока это так, профиль применяется только
  при ручном запуске из строки выше. Учесть при подключении: ключ провайдера
  сервер пишет в `~/.pi/agent/auth.json` (`savePiOpenRouterKey`), а в своём
  каталоге профиля pi будет искать его рядом — `PROJECTS/Flow/profiles/QA/auth.json`.
