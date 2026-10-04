// Клиент MCP Penpot: initialize -> notifications/initialized -> запрос.
//
// Нужен потому, что penpot-инструменты есть не в каждой сессии, а сервер из
// .mcp.json один и тот же: http://localhost:4401/mcp, streamable HTTP. Через
// него идут все вызовы execute_code — то есть рисование идёт через MCP и живой
// плагин в браузере, а не через API напрямую.
//
//   node TOOLS/penpot-mcp/design/mcp-client.mjs list
//   node TOOLS/penpot-mcp/design/mcp-client.mjs call '{"name":"execute_code","arguments":{"code":"..."}}'
const URL_ = process.env.PENPOT_MCP_URL || 'http://localhost:4401/mcp';
const H = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };

let sessionId = null;
async function rpc(method, params, id) {
    const res = await fetch(URL_, {
        method: 'POST',
        headers: sessionId ? { ...H, 'mcp-session-id': sessionId } : H,
        body: JSON.stringify(id ? { jsonrpc: '2.0', id, method, params } : { jsonrpc: '2.0', method, params }),
    });
    sessionId = res.headers.get('mcp-session-id') || sessionId;
    const text = await res.text();
    if (!res.ok) throw new Error(`${method}: HTTP ${res.status} ${text.slice(0, 300)}`);
    // Поток ответов приходит как SSE: собираем только строки data:.
    const out = [];
    for (const chunk of text.split('\n')) {
        if (chunk.startsWith('data:')) {
            try { out.push(JSON.parse(chunk.slice(5).trim())); } catch {}
        }
    }
    if (!out.length && text.trim()) out.push(JSON.parse(text));
    return out;
}

export async function open() {
    const init = (await rpc('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'openkarandash-design', version: '1' },
    }, 1))[0];
    await rpc('notifications/initialized', {});
    return init.result?.serverInfo ?? init.error;
}

export async function call(name, args = {}) {
    const r = (await rpc('tools/call', { name, arguments: args }, 2))[0];
    if (r.error) throw new Error(JSON.stringify(r.error));
    const text = r.result?.content?.map((c) => c.text).join('\n') ?? '';
    if (r.result?.isError) throw new Error(text);
    return { text, raw: r.result };
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`) {
    await open();
    const [, , mode, arg] = process.argv;
    if (mode === 'list') {
        const r = await call('execute_code', { code: 'return { ok: true };' });
        console.log(r.text);
    } else {
        console.log((await call(JSON.parse(arg).name, JSON.parse(arg).arguments ?? {})).text);
    }
}