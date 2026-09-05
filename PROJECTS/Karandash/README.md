# ✏️ Karandash — an interface that edits itself

Point at any element on the page, write what is wrong with it, and the assistant goes and fixes the sources. No DevTools, no grepping through the code, no "where does this button even live".

## 🎯 What this is

Karandash is a commenting mode for interface elements. The pencil button `karandashButton` in the toolbar turns on a crosshair: hovering highlights an element with a red frame, a click opens a comment field, and "Save" sends the assistant a ready-made task — the element's CSS selector plus your text — in a new chat session that is allowed to edit files right away.

The result is a short loop: you see a problem in the interface → you point at it and say so → the interface rewrites itself.

## ⚡ Features

- **The frame follows the cursor in real time.** Every frame (`requestAnimationFrame`) the mode checks what sits under the last known cursor position. That is why elements that appeared after load are highlighted too, as are ones that popped up under a motionless cursor, and the frame travels along with a moving element.
- **The wheel raises the selection to the parent.** `elementFromPoint` returns only the topmost element, so a container fully covered by its children (a kanban column, the composer form, the view itself) would otherwise be unreachable. Wheel up — one level higher, wheel down — back to the element under the cursor; it does not go above `body`, and page scrolling is disabled in Karandash mode.
- **Icons are clickable as a whole.** A click on a `<path>` inside an `<svg>` bubbles up to the nearest `button` or `a`. Standalone SVG shapes (the arrows in Flow) are left as they are — otherwise there would be nothing to click on them.
- **Everything can be commented on.** Only the mode's own layer is excluded from selection — the `.hover-frame` frame and the `.comment-popover` window. The settings menu, modals, toolbars — everything else is available.
- **It goes inside embedded frames.** The beads-web board on the Kanban tab is a separate `<iframe>`, and two things used to break there. A foreign frame keeps mouse events to itself, so neither `pointermove` nor `click` reached our page — the outline froze and clicks went into the frame; while the mode is on, iframes are transparent to the pointer (`body.karandash-mode iframe { pointer-events: none }`). And because a transparent frame is not what `elementFromPoint` returns, everything resolved to its container — one rectangle across the whole tab. So the mode hit-tests the frame itself (`frameAt`), descends into its document (`elementAt`), draws the outline and the comment window with the frame's offset (`documentOffset`), and keeps the wheel inside the frame document's own `body`. Elements from another document also need care with cross-document identity: `resolve()` checks the SVG namespace rather than `instanceof SVGElement`, since the frame's window has its own constructors. This works only for a frame of our own origin — the board is served through our port for exactly that reason (`DOCS/decisions/021`); for a genuinely foreign frame `contentDocument` is null and the container is what gets selected.
- **Even the native scrollbar.** The browser does not turn a click on the scrollbar into a `click` event, so such an element is caught through `pointerup` — the selection is completed if `click` never arrived.
- **A screenshot for the session thumbnail.** Before sending, the comment window is hidden while the frame stays — so the shot captures exactly the selected element, but not the popup.
- **One key to leave.** `Esc` turns off the mode and closes an open comment window.

## 🚀 How to use it

1. Click the pencil `karandashButton` in the toolbar — the cursor becomes a crosshair across the whole page (`body.karandash-mode`).
2. Hover over the element you need: it gets outlined with a red frame.
3. If you need its container rather than the element itself, scroll the wheel up. Down goes back.
4. Click. A comment window opens; the selector of the chosen element is shown at the top in a monospace font, with the input field below.
5. Describe what to change: "make the button wider", "this heading should be on the left", "remove this frame".
6. Press **Save** (or `Ctrl` + `Enter`). The mode turns off and the Chat tab opens with a new session in which the assistant has already received the task.

| Action | What happens |
|---|---|
| Click on `karandashButton` | Turn Karandash mode on/off |
| Hover | Highlight the element with a frame |
| Wheel up / down | Raise the selection to the parent / go back |
| Click on an element | Open the comment window (the page's own handler does not fire) |
| `Enter` in the field | New line |
| `Ctrl` + `Enter` / `Cmd` + `Enter` | Send the comment |
| `Esc` | Leave the mode and close the window |
| The "Cancel" button | Same as `Esc` |

## 🔧 How it works

**The selector.** The `describe(el)` function builds a string from the tag name, the `#id` (if there is one) and every class joined by dots — for example `button.icon-button.toolbar__item`. The same string is shown in the comment window header and goes into the prompt.

**The prompt.** `buildCommentPrompt` assembles up to three lines:

```
UI element: <selector>
Element text: <text, if it is no longer than 120 characters>
Comment: <what you wrote>
```

The text is taken only from short elements: for containers, `textContent` holds all of their content, and such an "element text" would only add noise to the task.

**The screenshot.** `POST /api/screenshot` — the shot is taken by the server: a `canvas` in the browser sees only the tab, not the whole screen. On the `server.js` side this is PowerShell plus `System.Drawing`: a shot of the entire virtual screen, downscaled to `SCREENSHOT_WIDTH` and turned into a JPEG `data:` URL. If it fails, `null` is returned and the session simply keeps a placeholder. The "Save" button is disabled during the capture so a second click cannot overtake the first shot.

**Always a new session.** `App.startCommentSession(prompt, thumb)` resets `chatSessionId` to `null`, clears the feed, deselects the session list and sets `Action` mode. A comment is never mixed into the current conversation — it is a separate task from a clean slate. The tab is not switched: if you are not sitting in Chat, you can go there and pick the session whenever you want.

**Edits are applied immediately.** The request goes to `POST /api/claude/ask`, where `Action` mode runs the Claude CLI with `--permission-mode bypassPermissions` (unlike `Chat`, which goes through `plan` and changes nothing). The answer arrives as an NDJSON stream.

**The thumbnail.** The session id is only known from the first stream event, so the shot waits in `pendingThumb` and goes to `POST /api/sessions/thumb` as soon as the id appears. The server checks the data-URL format and the size (up to 300 KB), after which the thumbnail is visible in the Sessions panel.

**Layers.** The frame is drawn as a separate fixed element with `pointer-events: none` — the mode does not touch the page's own styles. `z-index`: the frame is 1510, the comment window 1520 — above `.topbar` and the screenshot lightbox (1500), otherwise the highlight would hide underneath them. The window sits below the element, or above it when there is not enough room below, with a 10 px gap from the element and 8 px from the screen edge; every frame the frame and the window recompute their position to follow the element.

## 📁 Files

The whole Karandash button lives in this folder — client, styles and the server half alike:

| File | What is in it |
|---|---|
| `PROJECTS/Karandash/karandash.js` | The entire mode: its own markup (button, frame, comment window), cursor tracking, wheel-based raising, prompt assembly, screenshot capture |
| `PROJECTS/Karandash/karandash.css` | Styles for `body.karandash-mode`, `.hover-frame`, `.comment-popover` and its parts |
| `PROJECTS/Karandash/karandash-server.js` | The server half: its routes (`createRoutes`) plus `captureScreenshot()`: PowerShell plus `System.Drawing`, `SCREENSHOT_WIDTH`, a JPEG `data:` URL |

Only the wiring stays outside — three lines that cannot be moved out of the shared files:

| File | What it contains about Karandash |
|---|---|
| `SYSTEM/index.html` | A `<link>` to `karandash.css` and a `<script defer>` for `karandash.js` |
| `server.js` | Only wires the folder in: `require('./PROJECTS/Karandash/karandash-server.js').createRoutes(...)`. The `/api/screenshot*` routes themselves live in the folder |
| `PROJECTS/Chat/chat.js` | `App.startCommentSession` — declared by the Chat tab and added to `window.App` by it (it used to be in `SYSTEM/app.js`, `DOCS/decisions/022`); also used by the `+` button on the Kanban board (`PROJECTS/Kanban/kanban.js`) and by `SYSTEM/home-tasks.js` |

The `karandash.js` file is self-contained: it creates its own toolbar and inserts it before `#settings`, which is why `index.html` contains neither the button, nor the frame, nor the popup.

---

License — MIT.
