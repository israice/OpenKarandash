// Страница и файл в Penpot переименовываются по-разному: имя страницы
// writable, имя файла в plugin API только для чтения — поэтому rename-page.mjs
// пробует оба и честно падает на втором.
import { open, call } from './mcp-client.mjs';
await open();
const { text } = await call('execute_code', { code: `
const out = { page: penpot.currentPage?.name ?? null, file: penpot.currentFile?.name ?? null };
try {
    if (penpot.currentPage) penpot.currentPage.name = 'Penpot';
    out.pageAfter = penpot.currentPage?.name ?? null;
} catch (e) { out.pageErr = e.message.slice(0, 80); }
try {
    if (penpot.currentFile) penpot.currentFile.name = 'Penpot';
    out.fileAfter = penpot.currentFile?.name ?? null;
} catch (e) { out.fileErr = e.message.slice(0, 80); }
out.fileId = penpot.currentFile?.id ?? null;
return out;` });
console.log(text);