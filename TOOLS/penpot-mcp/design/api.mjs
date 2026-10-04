import { open, call } from './mcp-client.mjs';
await open();
const what = process.argv[2];
const { text } = await call('penpot_api_info', JSON.parse(what));
console.log(text);