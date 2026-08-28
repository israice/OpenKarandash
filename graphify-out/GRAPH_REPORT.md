# Graph Report - noname  (2026-08-27)

## Corpus Check
- 13 files · ~34,962 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 191 nodes · 291 edges · 15 communities (14 shown, 1 thin omitted)
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `28b9712a`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- server.js
- graph.js
- syncProjectMap
- Hello World
- smoke.js
- handleApi
- План уборки кода
- search.js
- askClaude
- syntax-check.js
- server
- VERSION.md
- buildVaultGraph
- checkFileLock
- CLAUDE.md

## God Nodes (most connected - your core abstractions)
1. `handleApi()` - 17 edges
2. `Hello World` - 15 edges
3. `askClaude()` - 12 edges
4. `syncProjectMap()` - 10 edges
5. `rebuildSearchIndex()` - 9 edges
6. `План уборки кода` - 8 edges
7. `renderGraph()` - 7 edges
8. `prepareVault()` - 7 edges
9. `syncSessionNotes()` - 7 edges
10. `2. Разведка безопасности` - 5 edges

## Surprising Connections (you probably didn't know these)
- `watchFiles()` --calls--> `snapshot()`  [EXTRACTED]
  server.js → server.js  _Bridges community 8 → community 2_
- `handleApi()` --calls--> `scheduleMapUpdate()`  [EXTRACTED]
  server.js → server.js  _Bridges community 2 → community 5_
- `askClaude()` --calls--> `runClaude()`  [EXTRACTED]
  server.js → server.js  _Bridges community 5 → community 8_
- `askClaude()` --calls--> `waitForFileTurn()`  [EXTRACTED]
  server.js → server.js  _Bridges community 13 → community 8_
- `handleApi()` --calls--> `checkFileLock()`  [EXTRACTED]
  server.js → server.js  _Bridges community 13 → community 5_

## Import Cycles
- None detected.

## Communities (15 total, 1 thin omitted)

### Community 0 - "server.js"
Cohesion: 0.06
Nodes (32): activeRuns, CHAT_DENIED_TOOLS, CLAUDE_MODELS, clients, countMessages, { DatabaseSync }, db, DB_FILE (+24 more)

### Community 1 - "graph.js"
Cohesion: 0.13
Nodes (24): applyGraphBox(), buildLayout(), edgePath(), endDrag(), fitGraph(), focusNode(), highlightNeighbours(), nodeByPath() (+16 more)

### Community 2 - "syncProjectMap"
Cohesion: 0.17
Nodes (20): dropStaleNotes(), gitHistory(), noteName(), notifyClients(), parseUnits(), prepareVault(), projectFiles(), readText() (+12 more)

### Community 3 - "Hello World"
Cohesion: 0.12
Nodes (15): Hello World, Автообновление, Если страница не обновляется сама, Запуск, Карта знаний (Obsidian), Коннектор Claude CLI, Остановка, Поиск по проекту (+7 more)

### Community 4 - "smoke.js"
Cohesion: 0.14
Nodes (11): checks, freePort(), fs, http, main(), net, os, path (+3 more)

### Community 5 - "handleApi"
Cohesion: 0.18
Nodes (14): deleteSession(), detectInstalls(), ftsQuery(), handleApi(), parseVersion(), readJson(), readProjectFile(), resetSessions() (+6 more)

### Community 6 - "План уборки кода"
Cohesion: 0.15
Nodes (12): 1. Страховка перед уборкой, 2.1. Инъекция команд через `sessionId` (критично), 2.2. Нет защиты от запросов со сторонней страницы (высокий), 2.3. Сервер слушает на всех интерфейсах (высокий), 2.4. Скрытые файлы раздаются по HTTP (средний), 2. Разведка безопасности, 3. Разведка дефектов, 4. Архитектурное решение (+4 more)

### Community 7 - "search.js"
Cohesion: 0.18
Nodes (9): args, { DatabaseSync }, db, fs, INDEX_FILE, match, path, query (+1 more)

### Community 8 - "askClaude"
Cohesion: 0.22
Nodes (9): askClaude(), broadcast(), candidateFiles(), finishExchange(), recordStep(), setBusy(), snapshot(), startExchange() (+1 more)

### Community 9 - "syntax-check.js"
Cohesion: 0.33
Nodes (6): { execFileSync }, fs, inlineJs(), main(), path, WRITE_TOOLS

### Community 10 - "server"
Cohesion: 0.40
Nodes (5): currentVersion(), escapeHtml(), isLocalRequest(), server, versionHistory()

### Community 11 - "VERSION.md"
Cohesion: 0.40
Nodes (4): DEV LOG, RECOVERY, RUN, UPDATE

### Community 12 - "buildVaultGraph"
Cohesion: 0.50
Nodes (3): buildVaultGraph(), collectNotes(), readFrontmatter()

### Community 13 - "checkFileLock"
Cohesion: 0.50
Nodes (4): checkFileLock(), conflictingRuns(), sleep(), waitForFileTurn()

## Knowledge Gaps
- **83 isolated node(s):** `fs`, `path`, `{ execFileSync }`, `WRITE_TOOLS`, `Карта проекта и память` (+78 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **1 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `buildVaultGraph()` connect `buildVaultGraph` to `server.js`, `handleApi`?**
  _High betweenness centrality (0.005) - this node is a cross-community bridge._
- **Why does `handleApi()` connect `handleApi` to `server.js`, `syncProjectMap`, `askClaude`, `server`, `buildVaultGraph`, `checkFileLock`?**
  _High betweenness centrality (0.004) - this node is a cross-community bridge._
- **What connects `fs`, `path`, `{ execFileSync }` to the rest of the system?**
  _83 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `server.js` be split into smaller, more focused modules?**
  _Cohesion score 0.06060606060606061 - nodes in this community are weakly interconnected._
- **Should `graph.js` be split into smaller, more focused modules?**
  _Cohesion score 0.13118279569892474 - nodes in this community are weakly interconnected._
- **Should `Hello World` be split into smaller, more focused modules?**
  _Cohesion score 0.125 - nodes in this community are weakly interconnected._
- **Should `smoke.js` be split into smaller, more focused modules?**
  _Cohesion score 0.14166666666666666 - nodes in this community are weakly interconnected._