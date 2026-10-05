# CHECKPOINT — OpenKarandash Continuous Engineering Loop

**Date:** 2026-10-05  
**Session:** Initial assessment per continuous engineering protocol  
**Protocol:** `AGENTS.md` + `local://paste-1.md` (Universal Continuous Engineering Loop)

---

## MIGRATION PROGRESS (2026-10-06, v0.0.161)

**Выполнена миграция 1:** разметка вкладки Flow переехала из `SYSTEM/index.html` в `PROJECTS/Flow/flow.eta` (маршрут `/api/fragment/flow`, контейнер `#flowBody` с `hx-get`/`hx-swap="innerHTML"` в index.html). `flow.js` и `flow-session-sync.js` ждут `#flowCanvas`/`#flowNav` (опрос 50 мс, потолок 10 с). Проверки: `node --check` чист, `npm run check` EXIT=0 (4 файла >400 строк — прежнее предупреждение), `npm run ui` без замечаний (flow: 9673 элементов), живой `SYSTEM/live-check.mjs`: `#flowCanvas` ✅, `#flowNav` ✅, у `#flowSessionSelect` 14 пунктов, `data-booting` снят. Версия: v0.0.161, записка `DOCS/decisions/104`.

**Следующая миграция (та же очередь, `DOCS/целевая-архитектура.md` п.3):** остальные компоненты — лента Sessions/Feed (сейчас разметку вкладки строит `PROJECTS/Sessions/sessions-view.js` в JS), Kanban, Settings-подвкладка Sandglass и т.п.; та же целевая схема: `<компонент>.eta` + `/api/fragment/<компонент>` + один контейнер.

**Открытые незакоммиченные артефакты от предыдущей сессии (не часть этой миграции, в коммит не входят):** `package.json`/`package-lock.json` — добавлены `robotjs@0.9.1` и `screenshot-desktop@1.15.6` без завершённого кода (предполагаемая незавершённая миграция замены PowerShell-скриншота); `AGENTS.md`/`AGENTS.override.md` модифицированы; `AUDIT_TARGET_ARCHITECTURE.md`, `AUDIT_VERIFICATION.md`, `CURRENT_TARGET_DIFF.md` — untracked; `PROJECTS/Flow/flow.eta` станет tracked в этом коммите.

---

## CURRENT PROJECT STATE

### Version
- **Current:** v0.0.160 (per VERSION.md)
- **Verified baseline:** v0.0.7 (per AUDIT_TARGET_ARCHITECTURE.md)

### Architecture Status (Verified)
| Domain | Status | Notes |
|--------|--------|-------|
| **Core (SYSTEM/core/)** | ✅ Healthy | 34 modules, no circular deps (madge passes), well-defined boundaries |
| **Dispatcher (server.js)** | ✅ Healthy | 289 lines, pure orchestrator, no feature logic |
| **Features (PROJECTS/)** | ✅ Healthy | 16 features, each with `createRoutes(deps)` pattern |
| **UI (index.html)** | ✅ Healthy | 849 lines, only containers + importmap + boot script |

### Security Status (Verified Against PLAN.md §2)
| Issue | PLAN.md Claim | Verified State | Status |
|-------|---------------|----------------|--------|
| Server binds to 0.0.0.0 | Yes | **Fixed**: `server.listen(PORT, '127.0.0.1')` in server.js:276 | ✅ RESOLVED |
| No Origin check on /api/* | Yes | **Fixed**: `sameOrigin()` in api.js:14-23 | ✅ RESOLVED |
| Hidden files served (.env, .git, DATA/, .kilo/) | Yes | **Fixed**: `DENY_STATIC` regex in http-server.js:51 | ✅ RESOLVED |
| PowerShell screenshot AV flag | Yes | **OPEN**: karandash-server.js uses PowerShell `System.Drawing` | ⚠️ OPEN |
| Session ID injection | Historical | **Fixed**: No injection vector found in current code | ✅ RESOLVED |

### File Size Compliance (Decision 022: ~150-300 lines, divide at 400)
| File | Lines | Status |
|------|-------|--------|
| PROJECTS/Graph/graph-vault.js | 609 | ⚠️ EXCEEDS |
| PROJECTS/Settings/settings-sandglass.js | 538 | ⚠️ EXCEEDS |
| PROJECTS/Sessions/sessions-feed.js | 460 | ⚠️ EXCEEDS |
| PROJECTS/Karandash/karandash.js | 454 | ⚠️ EXCEEDS |
| All other files | < 400 | ✅ COMPLIANT |

### Testing
- **Automated tests:** ZERO (explicitly stated in PLAN.md)
- **Quality gates:** `npm run check` — file sizes, vh/vw location, madge circular deps — all PASS
- **Runtime/integration tests:** NONE

### Empty/Stub Features
- Page 4, 5, 6, 7, 8 — only `page.css`, `page.js`, `README.md` (no server, no purpose)
- Kanban — placeholder only, no server routes
- Penpot — external container reference only

---

## COMPLETED MIGRATIONS (Historical)

Per VERSION.md dev log, major completed migrations include:
- v0.0.120-v0.0.124: Element click reporting, model badge in feed, reasoning capture, skill suggestions
- v0.0.125: Home tab deletion (complete)
- v0.0.126: Hot reload three-stage (element/window/section)
- v0.0.127: Details block removal from Sessions
- v0.0.128: Page boot gate (SYSTEM/boot.js)
- v0.0.129: Topbar button deduplication
- v0.0.130: Thinking block tag alignment
- v0.0.145-v0.0.152: Session memory, turn-based measurement, report quality, coverage
- v0.0.153-v0.0.155: CLI/model selection in session header, no executor fallback
- v0.0.156: Session pointer copy command
- v0.0.157: Turn completion without permission prompts (auto-approve flag)
- v0.0.158: Full page gate (all content before show)
- v0.0.159: Pre-strict-rules baseline
- v0.0.160: Security boundary (decision 103) — loopback, Host, Origin, DENY_STATIC

---

## ARCHITECTURAL INVARIANTS VERIFIED

1. **No circular dependencies** — `npx madge --circular server.js` → "No circular dependency found"
2. **Core → Feature dependency direction** — Core passes deps to `createRoutes()`, features never require core internals directly
3. **Feature isolation** — Each feature in `PROJECTS/<feature>/` with own server, template, styles, client script
4. **UI structure** — index.html contains ONLY 5 view containers + importmap + boot script + CSS links + module scripts
5. **Decision-driven governance** — 19 decision files in `DOCS/decisions/` document all architectural choices

---

## OPEN RISKS & ISSUES

| Risk | Severity | Description |
|------|----------|-------------|
| PowerShell AV flag | HIGH | karandash-server.js screenshot triggers AV heuristic (ScriptContainedMaliciousContent) |
| 4 files > 400 lines | MEDIUM | Violates decision 022 norm; harder to maintain |
| Zero automated tests | MEDIUM | No regression protection beyond `npm run check` |
| 5 empty feature folders | LOW | Clutter, no purpose; should be removed or implemented |
| No CI pipeline | LOW | Quality gates only run locally |

---

## DECISIONS REQUIRED (None blocking)

- Whether to replace PowerShell screenshot with alternative (puppeteer? native node? drop feature?)
- Whether to split 4 large files now or defer
- Whether to add test framework (vitest/jest) or keep minimal smoke tests
- Whether to remove empty Page 4-8 folders or implement them

---

## NEXT MIGRATION CANDIDATES (Priority Order)

### 1. **Security: Replace PowerShell Screenshot** (HIGHEST — security/ops risk)
- **Problem:** PowerShell `System.Drawing` screenshot flagged by AV as screen-scraping heuristic
- **Owner:** PROJECTS/Karandash/karandash-server.js
- **Options:** 
  - A) Node-based screenshot (e.g., `@nut-tree/nut-js`, `screenshot-desktop`) — cross-platform
  - B) Puppeteer/Playwright headless — heavyweight
  - C) Drop server-side screenshot; use client-side canvas (but can't capture outside browser tab)
  - D) Sandbox PowerShell (sign script, allowlist) — Windows-only, maintenance burden
- **Recommended:** Option A — lightweight Node screenshot library

### 2. **Architecture: Split 4 Large Files** (MEDIUM — maintainability)
- graph-vault.js (609) → split vault build vs note generation
- settings-sandglass.js (538) → split sandglass logic from server routes
- sessions-feed.js (460) → split feed rendering from message cards
- karandash.js (454) → split UI logic from element hook index

### 3. **Quality: Add Basic Smoke Tests** (MEDIUM — regression prevention)
- Minimum: endpoint smoke tests for `/api/*` routes
- Tooling: vitest (fast, ESM native) or keep minimal custom

### 4. **Cleanup: Remove Empty Feature Folders** (LOW — hygiene)
- Remove Page 4, 5, 6, 7, 8 folders (or implement if roadmap demands)

---

## PROTOCOL COMPLIANCE CHECK

| Requirement | Status |
|-------------|--------|
| CHECKPOINT saved in project state | ✅ This file |
| PROJECT STATE > SESSION MEMORY | ✅ Based on actual file inspection |
| No architectural changes without decision | ✅ All current state per documented decisions |
| One migration at a time | ✅ Will execute sequentially |
| Continuous continuation | ✅ Will proceed to next migration after verification |

---

## VERIFICATION METHOD FOR NEXT MIGRATION

For PowerShell screenshot replacement:
1. Identify current screenshot API contract (captureScreenshot, listScreens)
2. Implement replacement with same interface
3. Verify: `npm run check` passes, no AV flag on test run, screenshot quality acceptable
4. Remove PowerShell code
5. Update CHECKPOINT

---

*This checkpoint enables any executor to continue without prior session context.*