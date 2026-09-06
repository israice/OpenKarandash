/* Claude Bridge console — a thin client over the bridge's own OpenAI API.
 * Deliberately dependency-free: it is served by the bridge itself, so it must
 * work with no CDN and no build step. */
"use strict";

const TOKEN = window.__BRIDGE_TOKEN__ || "";
const el = (id) => document.getElementById(id);
const log = el("log"), input = el("input"), thumbs = el("thumbs");

// Full OpenAI message history, exactly as sent to the bridge.
let history = [];
let pending = [];      // data URLs staged for the next message
let busy = false;

const DEMO_TOOLS = [{
  type: "function",
  function: {
    name: "get_weather",
    description: "Get the current weather for a city.",
    parameters: {
      type: "object",
      properties: { city: { type: "string" }, unit: { enum: ["c", "f"] } },
      required: ["city"],
    },
  },
}];

// ── rendering ───────────────────────────────────────────────
function bubble(role, opts = {}) {
  const div = document.createElement("div");
  div.className = "msg " + role + (opts.error ? " err" : "");
  div.innerHTML = `<div class="role">${opts.label || role}</div><div class="body"></div>`;
  log.appendChild(div);
  window.scrollTo(0, document.body.scrollHeight);
  return div;
}

function addImages(node, urls) {
  urls.forEach((url) => {
    const img = document.createElement("img");
    img.src = url;
    node.appendChild(img);
  });
}

function addToolCalls(node, calls) {
  calls.forEach((c) => {
    const box = document.createElement("div");
    box.className = "toolcall";
    let args = c.function.arguments;
    try { args = JSON.stringify(JSON.parse(args), null, 2); } catch { /* leave raw */ }
    box.innerHTML = `<span class="name">${c.function.name}</span>(${args})`;
    node.appendChild(box);
  });
}

function addMeta(node, parts) {
  const meta = document.createElement("div");
  meta.className = "meta";
  meta.textContent = parts.join("   ·   ");
  node.appendChild(meta);
}

// ── bridge calls ────────────────────────────────────────────
const MODE_HINTS = {
  agent: "Агент Hermes: свои инструменты (терминал, файлы, память) и скиллы — он может выполнять действия.",
  model: "Чистая модель Claude через мост: инструментов нет, только текст (плюс demo-инструмент ниже).",
};

function agentMode() {
  return el("mode").value === "agent";
}

async function post(body) {
  // Agent mode goes to Hermes through the bridge's proxy, so the page stays on
  // one origin and the Hermes API key never reaches the browser.
  const path = agentMode() ? "/agent/v1/chat/completions" : "/v1/chat/completions";
  return fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + TOKEN },
    body: JSON.stringify(body),
  });
}

/** Stream one assistant turn; returns {content, tool_calls, usage}. */
async function streamTurn(node, tools) {
  const started = performance.now();
  const res = await post({
    model: agentMode() ? "hermes-agent" : el("model").value,
    messages: history,
    stream: true,
    // Hermes brings its own toolbox; offering the demo tool there would only
    // compete with it.
    ...(tools && !agentMode() ? { tools } : {}),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);

  const body = node.querySelector(".body");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "", content = "", calls = [], usage = null, firstToken = null;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    let cut;
    while ((cut = buf.indexOf("\n\n")) !== -1) {
      const frame = buf.slice(0, cut).trim();
      buf = buf.slice(cut + 2);
      if (!frame.startsWith("data:")) continue;
      const payload = frame.slice(5).trim();
      if (payload === "[DONE]") continue;

      let ev;
      try { ev = JSON.parse(payload); } catch { continue; }
      if (ev.error) throw new Error(ev.error.message || "bridge error");

      const choice = (ev.choices || [])[0];
      if (!choice) continue;
      const delta = choice.delta || {};
      if (delta.content) {
        if (firstToken === null) firstToken = performance.now() - started;
        content += delta.content;
        body.textContent = content;
        window.scrollTo(0, document.body.scrollHeight);
      }
      if (delta.tool_calls) {
        calls = calls.concat(delta.tool_calls.map((c) => ({
          id: c.id, type: "function", function: { name: c.function.name, arguments: c.function.arguments },
        })));
      }
      if (ev.usage) usage = ev.usage;
    }
  }

  if (calls.length) addToolCalls(node, calls);
  const stats = [`${((performance.now() - started) / 1000).toFixed(1)} s`];
  if (firstToken !== null) stats.push(`first token ${(firstToken / 1000).toFixed(1)} s`);
  if (usage) stats.push(`${usage.prompt_tokens} in / ${usage.completion_tokens} out`);
  addMeta(node, stats);
  return { content, tool_calls: calls, usage };
}

/** Answer a tool call locally so the round trip is visible end to end. */
function runDemoTool(call) {
  let args = {};
  try { args = JSON.parse(call.function.arguments || "{}"); } catch { /* ignore */ }
  if (call.function.name === "get_weather") {
    return { city: args.city || "unknown", temp: args.unit === "f" ? 70 : 21,
             unit: args.unit || "c", sky: "clear", source: "demo tool in the browser" };
  }
  return { error: `no local implementation for ${call.function.name}` };
}

// ── main flow ───────────────────────────────────────────────
async function send() {
  const text = input.value.trim();
  if ((!text && !pending.length) || busy) return;

  const content = pending.length
    ? [{ type: "text", text }, ...pending.map((url) => ({ type: "image_url", image_url: { url } }))]
    : text;
  history.push({ role: "user", content });

  const userNode = bubble("user", { label: "Вы" });
  userNode.querySelector(".body").textContent = text;
  if (pending.length) addImages(userNode, pending);
  input.value = ""; pending = []; thumbs.innerHTML = "";

  busy = true; el("send").disabled = true;
  const tools = !agentMode() && el("usetools").checked ? DEMO_TOOLS : null;

  try {
    let node = bubble("assistant", { label: "Claude" });
    let turn = await streamTurn(node, tools);

    // One follow-up hop: run the requested tool, feed the result back.
    if (turn.tool_calls.length) {
      history.push({ role: "assistant", content: null, tool_calls: turn.tool_calls });
      for (const call of turn.tool_calls) {
        const result = runDemoTool(call);
        history.push({ role: "tool", tool_call_id: call.id, name: call.function.name,
                       content: JSON.stringify(result) });
        const tnode = bubble("assistant", { label: "результат инструмента" });
        tnode.querySelector(".body").textContent = JSON.stringify(result, null, 2);
      }
      node = bubble("assistant", { label: "Claude" });
      turn = await streamTurn(node, tools);
    }
    history.push({ role: "assistant", content: turn.content });
  } catch (err) {
    const node = bubble("assistant", { label: "ошибка", error: true });
    node.querySelector(".body").textContent = String(err.message || err);
  } finally {
    busy = false; el("send").disabled = false; input.focus();
  }
}

// ── wiring ──────────────────────────────────────────────────
el("send").onclick = send;
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
});
el("attach").onclick = () => el("file").click();
el("file").onchange = (e) => {
  [...e.target.files].forEach((file) => {
    const reader = new FileReader();
    reader.onload = () => {
      pending.push(reader.result);
      const img = document.createElement("img");
      img.src = reader.result;
      thumbs.appendChild(img);
    };
    reader.readAsDataURL(file);
  });
  e.target.value = "";
};
input.addEventListener("paste", (e) => {
  [...(e.clipboardData?.items || [])].forEach((item) => {
    if (item.type.startsWith("image/")) {
      const reader = new FileReader();
      reader.onload = () => {
        pending.push(reader.result);
        const img = document.createElement("img");
        img.src = reader.result;
        thumbs.appendChild(img);
      };
      reader.readAsDataURL(item.getAsFile());
    }
  });
});
el("clear").onclick = () => { history = []; log.innerHTML = ""; };

function syncMode() {
  const agent = agentMode();
  el("modehint").textContent = MODE_HINTS[agent ? "agent" : "model"];
  el("toolslabel").style.display = agent ? "none" : "";
  el("model").style.display = agent ? "none" : "";
}
el("mode").onchange = () => { syncMode(); };

(async function boot() {
  try {
    const health = await (await fetch("/health")).json();
    el("dot").className = "dot ok";
    el("target").textContent = `CLI: ${health.target} · backend: ${health.backend}`;
    const models = await (await fetch("/v1/models", {
      headers: { Authorization: "Bearer " + TOKEN } })).json();
    el("model").innerHTML = models.data.map((m) => `<option>${m.id}</option>`).join("");
    syncMode();
  } catch (err) {
    el("dot").className = "dot bad";
    el("hint").textContent = "Мост недоступен: " + err;
  }
  input.focus();
})();
