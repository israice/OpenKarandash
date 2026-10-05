# 100. Hermes Agent — свой ход и свой учёт, а не `run`

## Проблема

Сессия `hermesagent-local-muur2fcu` («ты тут?») закончилась ошибкой:

```
hermes: 'run' is not a `hermes` command.
Run `hermes --help` to see all commands.
```

Ход уходил в общий коннектор (`SYSTEM/cli/any.js`), тот определял семейство по
тексту `--help` (`familyOf`, `SYSTEM/cli/any-parse.js`) и относил hermes к
**plain**: подкоманды `run [message]` в его справке нет, `--format` тоже нет, а
признаки pi (`--mode` + `--print`) и openclaw (`--message-file`) не совпали.
Дальше plain собирал args по единственному правилу — `{ args: ['run', text] }`,
то есть `hermes run "ты тут?"`. Подкоманды `run` у hermes нет вовсе.

Проверено на живой машине (`hermes 0.21.5`, `%LOCALAPPDATA%\hermes\bin\hermes.exe`):
его подкоманды — `chat`, `model`, `serve`, `acp`, `sessions`, `doctor` и прочие
сервисные; ход на один промпт делает **флаг** `-z/--oneshot PROMPT`.

## Что оказалось у hermes

| Что | Как у hermes |
|---|---|
| ход | `-z/--oneshot PROMPT` — подкоманды нет |
| ответ | весь stdout: «только итоговый текст, без баннера, спиннера, превью инструментов и session_id» |
| учёт | отдельный файл `--usage-file PATH`: токены, цена, `session_id`, `turn_exit_reason`; пишется всегда, в том числе при отказе |
| модель | двумя флагами: `--provider openrouter -m stealth/space-bunny-alpha` |
| глубина | `--reasoning LEVEL`: none, minimal, low, medium, high, xhigh, max, ultra |
| продолжение | `--resume SESSION` — свой `session_id` из отчёта |
| каталог | `hermes model` — интерактивный выборщик; годятся только `hermes config get model` (default + provider) |

Разделение модели на два флага — не украшение: с путём целиком
(`-m openrouter/stealth/space-bunny-alpha`) CLI **не отвечает вовсе**, уходит
искать шлюз по такому имени и возвращается только по сторожу молчания
(`SYSTEM/cli/spawn.js`). Наш путь трёхуровневый (шлюз/поставщик/модель,
`SYSTEM/model-path.js`), поэтому первый уровень уходит в `--provider`, остаток —
в `-m`.

## Решение

1. **Новое семейство `hermes`** в `familyOf` (`SYSTEM/cli/any-parse.js`):
   признак — `--oneshot PROMPT` / `--usage-file PATH`. Проверка стоит до pi и
   opencode: у hermes нет ни `run`, ни `--format`, и по общим признакам он
   неотличим от plain — а именно в plain он и проваливался.
2. **Новый модуль `SYSTEM/cli/any-hermes.js`** — по образцу `any-openclaw.js`:
   флаги хода, ключ модели, каталог и разбор хода. Ответом считается весь
   stdout, учёт берётся из отчёта, `session_id` оттуда же уходит в `ctx.begin`
   (у первого хода его не у кого взять, поэтому begin после чтения отчёта).
3. **`plain` остаётся для настоящих заглушек.** Это последнее семейство, где ход
   идёт как `run "…"`, и оно по-прежнему означает «у этого CLI нет ни одного из
   известных признаков». Перечень семейств в `DOCS/decisions/095` этим решением
   дополняется: hermes переезжает из plain в своё семейство.

## Проверено вживую

- `familyOf(hermes --help)` → `hermes`;
- каталог: `["openrouter/stealth/space-bunny-alpha"]` (из `config get model`);
- первый ход: `-z "say ok" --usage-file … --provider openrouter -m stealth/space-bunny-alpha --reasoning medium` → ответ `ok`, отчёт дал 25072 input / 2 output / 1231 cache_read, `stopReason` = `text_response(finish_reason=stop)`;
- второй ход с `--resume` того же `session_id` — сессия hermes продолжена, а не заведена заново;
- каталоги `%TEMP%\karandash-hermes-*` после хода не остаются (уборка в `finally`).

## Что осталось за рамками

- Промпт идёт аргументом: у hermes нет `--message-file`, а ход у нас — это
  пересказ истории на сотни килобайт, который командная строка Windows не берёт.
  Это ограничение общее для всех семейств (pi, opencode тоже кладут текст в
  аргументы), отдельной правки здесь не делалось.
- Неизвестная модель уводит hermes в собственный долгий перебор шлюзов: поймает
  сторож молчания в `SYSTEM/cli/spawn.js`, и это тот же класс поведения, что
  описан в его шапке для исчерпанных лимитов OpenRouter.
- Потока событий (шагов, мыслей) у `-z` нет: ответ приходит целиком в конце
  хода, как у plain.