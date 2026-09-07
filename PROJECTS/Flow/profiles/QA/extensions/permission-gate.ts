/**
 * QA permission gate.
 *
 * The tool list in ../settings.json already decides what the QA agent may use
 * (no `write`, no `edit`). Everything finer than that is only expressible as a
 * `tool_call` hook — pi has no permission modes, no allow/deny rules and no
 * sandbox (docs/security.md, docs/usage.md). This is that hook: it blocks the
 * shell commands a tester must never run.
 *
 * Auto-discovered because it lies in <agent dir>/extensions/ — the agent dir is
 * this profile folder (PI_CODING_AGENT_DIR).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const BLOCKED = [
	{ pattern: /\brm\s+(-[a-z]*r|--recursive)/i, reason: "recursive delete" },
	{ pattern: /\bsudo\b/i, reason: "elevation" },
	{ pattern: /\b(chmod|chown)\b.*\b777\b/i, reason: "world-writable permissions" },
	{ pattern: /\bgit\s+(push|commit|reset\s+--hard|clean\s+-[a-z]*f)/i, reason: "writing to the repository" },
	{ pattern: /\bnode\s+server\.js\b/i, reason: "starting the server (AGENTS.md: the user starts it)" },
];

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash" && event.toolName !== "powershell") return undefined;

		const command = String(event.input.command ?? "");
		const hit = BLOCKED.find((rule) => rule.pattern.test(command));
		if (!hit) return undefined;

		if (ctx.hasUI) ctx.ui.notify(`Blocked for QA: ${hit.reason}`, "warning");
		return { block: true, reason: `QA may not run this — ${hit.reason}` };
	});
}
