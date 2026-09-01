# Graph Report - noname  (2026-08-30)

## Corpus Check
- 48 files · ~60,253 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 216 nodes · 411 edges · 15 communities (14 shown, 1 thin omitted)
- Extraction: 98% EXTRACTED · 2% INFERRED · 0% AMBIGUOUS · INFERRED: 7 edges (avg confidence: 0.5)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `01228533`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- app.js
- init
- graph.js
- layoutAllNodes
- smoke.js
- search.js
- toolbar-reorder.js
- 💬 PROJECTS
- init
- confirmModal
- VERSION.md

## God Nodes (most connected - your core abstractions)
1. `init()` - 67 edges
2. `sendToClaude()` - 15 edges
3. `layoutAllNodes()` - 13 edges
4. `insertNodeOnEdge()` - 12 edges
5. `flowSet()` - 11 edges
6. `restoreGraph()` - 11 edges
7. `flowGet()` - 10 edges
8. `attachSession()` - 10 edges
9. `addChildNode()` - 9 edges
10. `addChildNodeRight()` - 9 edges

## Surprising Connections (you probably didn't know these)
- `loadPositions()` --calls--> `flowGet()`  [EXTRACTED]
  PROJECTS/Flow/flow.js → PROJECTS/Flow/flow.js  _Bridges community 1 → community 3_
- `removeSession()` --calls--> `confirmModal()`  [EXTRACTED]
  SYSTEM/app.js → SYSTEM/app.js  _Bridges community 10 → community 0_

## Import Cycles
- None detected.

## Communities (15 total, 1 thin omitted)

### Community 0 - "app.js"
Cohesion: 0.10
Nodes (42): addMessage(), addPendingStatus(), addStep(), api(), applyRunningIndicator(), attachSession(), deleteButton(), deselectSession() (+34 more)

### Community 1 - "init"
Cohesion: 0.08
Nodes (31): init(), addAgentItem(), addFlowItem(), addQuestionField(), addTempItem(), apply(), applyQuestions(), applyTexts() (+23 more)

### Community 2 - "graph.js"
Cohesion: 0.11
Nodes (26): applyGraphBox(), buildLayout(), edgePath(), endDrag(), fitGraph(), focusNode(), highlightNeighbours(), makeFileEditor() (+18 more)

### Community 3 - "layoutAllNodes"
Cohesion: 0.20
Nodes (25): addChildNode(), addChildNodeRight(), attachAddBottom(), attachAddRight(), createEdge(), deleteNode(), drawEdge(), edgeGeometry() (+17 more)

### Community 4 - "smoke.js"
Cohesion: 0.14
Nodes (11): checks, freePort(), fs, http, main(), net, os, path (+3 more)

### Community 5 - "search.js"
Cohesion: 0.18
Nodes (9): args, { DatabaseSync }, db, fs, INDEX_FILE, match, path, query (+1 more)

### Community 6 - "toolbar-reorder.js"
Cohesion: 0.27
Nodes (4): exitReorderMode(), groupKey(), loadOrder(), saveOrder()

### Community 7 - "💬 PROJECTS"
Cohesion: 0.25
Nodes (7): 💬 PROJECTS, ✨ Возможности, 🚀 Как пользоваться, 🔧 Как это устроено, ⚠️ Прежде чем начать, 📁 Файлы, 🧭 Что это

### Community 8 - "init"
Cohesion: 0.67
Nodes (3): init(), onMove(), onUp()

### Community 10 - "confirmModal"
Cohesion: 1.00
Nodes (3): confirmModal(), cleanup(), onKey()

## Knowledge Gaps
- **24 isolated node(s):** `fs`, `path`, `{ DatabaseSync }`, `INDEX_FILE`, `args` (+19 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **1 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `init()` connect `init` to `flow.js`, `layoutAllNodes`?**
  _High betweenness centrality (0.102) - this node is a cross-community bridge._
- **Why does `layoutAllNodes()` connect `layoutAllNodes` to `init`?**
  _High betweenness centrality (0.015) - this node is a cross-community bridge._
- **Why does `confirmModal()` connect `confirmModal` to `app.js`?**
  _High betweenness centrality (0.004) - this node is a cross-community bridge._
- **What connects `fs`, `path`, `{ DatabaseSync }` to the rest of the system?**
  _24 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `app.js` be split into smaller, more focused modules?**
  _Cohesion score 0.10119047619047619 - nodes in this community are weakly interconnected._
- **Should `init` be split into smaller, more focused modules?**
  _Cohesion score 0.07678075855689177 - nodes in this community are weakly interconnected._
- **Should `graph.js` be split into smaller, more focused modules?**
  _Cohesion score 0.10873440285204991 - nodes in this community are weakly interconnected._