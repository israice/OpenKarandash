# Graph Report - OpenKarandash  (2026-09-02)

## Corpus Check
- 89 files · ~90,917 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 350 nodes · 620 edges · 20 communities (17 shown, 3 thin omitted)
- Extraction: 98% EXTRACTED · 2% INFERRED · 0% AMBIGUOUS · INFERRED: 15 edges (avg confidence: 0.5)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `8858e110`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- app.js
- init
- graph.js
- server.js
- smoke.js
- search.js
- toolbar-reorder.js
- askClaude
- init
- handleApi
- runOpenCode
- runTurn
- 💬 PROJECTS
- ✏️ Karandash — интерфейс, который правит сам себя
- server
- flow-session-sync.js
- Chat/VERSION.md
- Karandash/VERSION.md

## God Nodes (most connected - your core abstractions)
1. `init()` - 67 edges
2. `askClaude()` - 19 edges
3. `sendToClaude()` - 15 edges
4. `layoutAllNodes()` - 13 edges
5. `insertNodeOnEdge()` - 12 edges
6. `handleApi()` - 12 edges
7. `flowSet()` - 11 edges
8. `restoreGraph()` - 11 edges
9. `clip()` - 11 edges
10. `flowGet()` - 10 edges

## Surprising Connections (you probably didn't know these)
- `handleApi()` --calls--> `listScreens()`  [EXTRACTED]
  server.js → PROJECTS/Karandash/screenshot.js
- `handleApi()` --calls--> `captureScreenshot()`  [EXTRACTED]
  server.js → PROJECTS/Karandash/screenshot.js

## Import Cycles
- None detected.

## Communities (20 total, 3 thin omitted)

### Community 0 - "app.js"
Cohesion: 0.09
Nodes (45): addMessage(), addPendingStatus(), addStep(), api(), applyRunningIndicator(), attachSession(), confirmModal(), cleanup() (+37 more)

### Community 1 - "init"
Cohesion: 0.06
Nodes (56): init(), addAgentItem(), addChildNode(), addChildNodeRight(), addFlowItem(), addQuestionField(), addTempItem(), apply() (+48 more)

### Community 2 - "graph.js"
Cohesion: 0.11
Nodes (26): applyGraphBox(), buildLayout(), edgePath(), endDrag(), fitGraph(), focusNode(), highlightNeighbours(), makeFileEditor() (+18 more)

### Community 3 - "server.js"
Cohesion: 0.03
Nodes (59): activeRuns, AGENTS, { captureScreenshot, listScreens }, CHAT_DENIED_TOOLS, CLAUDE_MODELS, clients, countMessages, { DatabaseSync } (+51 more)

### Community 4 - "smoke.js"
Cohesion: 0.14
Nodes (11): checks, freePort(), fs, http, main(), net, os, path (+3 more)

### Community 5 - "search.js"
Cohesion: 0.18
Nodes (9): args, { DatabaseSync }, db, fs, INDEX_FILE, match, path, query (+1 more)

### Community 6 - "toolbar-reorder.js"
Cohesion: 0.27
Nodes (4): exitReorderMode(), groupKey(), loadOrder(), saveOrder()

### Community 7 - "askClaude"
Cohesion: 0.17
Nodes (20): askClaude(), askHermes(), askOpenCode(), askPlannedByClaude(), camelKey(), clip(), contextWindowFor(), handoffPreamble() (+12 more)

### Community 8 - "init"
Cohesion: 0.67
Nodes (3): init(), onMove(), onUp()

### Community 9 - "handleApi"
Cohesion: 0.17
Nodes (12): captureScreenshot(), fs, listScreens(), os, path, { spawn }, agentByName(), deleteSession() (+4 more)

### Community 10 - "runOpenCode"
Cohesion: 0.24
Nodes (11): detectInstalls(), detectOpenCodeInstalls(), fetchOpenCodeModels(), killProcessTree(), parseVersion(), runClaude(), runOpenCode(), shellLaunch() (+3 more)

### Community 11 - "runTurn"
Cohesion: 0.18
Nodes (11): extractTitle(), finishExchange(), notifyClients(), {
    prepareVault, buildVaultGraph, searchProject, readProjectFile, writeProjectFile, projectFiles, MAX_EDIT_BYTES,
}, runTurn(), scheduleMapUpdate(), sessionTitle(), setBusy() (+3 more)

### Community 14 - "💬 PROJECTS"
Cohesion: 0.25
Nodes (7): 💬 PROJECTS, ✨ Возможности, 🚀 Как пользоваться, 🔧 Как это устроено, ⚠️ Прежде чем начать, 📁 Файлы, 🧭 Что это

### Community 15 - "✏️ Karandash — интерфейс, который правит сам себя"
Cohesion: 0.29
Nodes (6): ✏️ Karandash — интерфейс, который правит сам себя, ⚡ Возможности, 🚀 Как пользоваться, 🔧 Как это устроено, 📁 Файлы, 🎯 Что это

### Community 16 - "server"
Cohesion: 0.50
Nodes (4): currentVersion(), isLocalRequest(), server, versionHistory()

## Knowledge Gaps
- **93 isolated node(s):** `🧭 Что это`, `✨ Возможности`, `🚀 Как пользоваться`, `⚠️ Прежде чем начать`, `🔧 Как это устроено` (+88 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **3 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **What connects `🧭 Что это`, `✨ Возможности`, `🚀 Как пользоваться` to the rest of the system?**
  _93 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `app.js` be split into smaller, more focused modules?**
  _Cohesion score 0.09351432880844646 - nodes in this community are weakly interconnected._
- **Should `init` be split into smaller, more focused modules?**
  _Cohesion score 0.0627027027027027 - nodes in this community are weakly interconnected._
- **Should `graph.js` be split into smaller, more focused modules?**
  _Cohesion score 0.10873440285204991 - nodes in this community are weakly interconnected._
- **Should `server.js` be split into smaller, more focused modules?**
  _Cohesion score 0.03125 - nodes in this community are weakly interconnected._
- **Should `smoke.js` be split into smaller, more focused modules?**
  _Cohesion score 0.14166666666666666 - nodes in this community are weakly interconnected._