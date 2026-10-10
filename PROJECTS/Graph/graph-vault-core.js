// Общие константы, пути и состояние для вкладки Graph.
//
// Здесь только то, что не зависит от других модулей вкладки. Остальная
// логика разложена по темам: graph-vault-notes.js, graph-vault-project.js,
// graph-vault-git.js, graph-vault-sessions.js, graph-vault-sync.js,
// graph-vault-graph.js.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

const DATA_DIR = process.env.DATA_DIR || 'DATA';
const VAULT_DIR = `${DATA_DIR}/vault`;
fs.mkdirSync(path.join(ROOT, DATA_DIR), { recursive: true });

const VAULT = process.env.OBSIDIAN_VAULT || path.join(ROOT, VAULT_DIR);

const MAP_DIR = 'Project';
const UNIT_DIR = 'Секции';
const API_SUBDIR = 'API';
const SESSION_DIR = 'Sessions';

const TEXT_FILES = /\.(js|mjs|cjs|ts|tsx|jsx|json|html|css|md|txt|yml|yaml|sh|py|sql)$/i;
const MAX_SCAN_BYTES = 512 * 1024;

const VAULT_SKIP = new Set(['.obsidian', '.trash', '.git']);

const scan = require('../../SYSTEM/core/scan.js');
const MAP_SKIP = new Set([...scan.SKIP_NAMES, DATA_DIR]);

const NOTE_NAME_LIMIT = 120;

const BIG_FILE_LINES = 200;

const SECTION = /^\s*\/\/ -{3,} (.+?) -{3,}\s*$/;
const TOP_FUNCTION = /^(\s*)(?:async )?function ([A-Za-z0-9_$]+)\s*\(/;

const EDITING_TOOLS = /^(Edit|Write|NotebookEdit) (.+)$/;
const SESSION_TITLE_LIMIT = 80;

const API_REF = /['"`](\/api\/[a-z0-9\/_-]+)['"`]/gi;
const API_ROUTE = /urlPath\s*===\s*'(\/api\/[a-z0-9\/_-]+)'|['"](\/api\/[a-z0-9\/_-]+)['"]\s*:/g;
const HTML_REF = /(?:src|href)\s*=\s*["']([^"':#?]+)["']/gi;
const MODULE_REF = /(?:require\(|from\s+|import\()\s*['"](\.[^'"]+)['"]/g;

const state = { deps: null };

module.exports = {
    ROOT,
    DATA_DIR,
    VAULT_DIR,
    VAULT,
    MAP_DIR,
    UNIT_DIR,
    API_SUBDIR,
    SESSION_DIR,
    TEXT_FILES,
    MAX_SCAN_BYTES,
    VAULT_SKIP,
    MAP_SKIP,
    NOTE_NAME_LIMIT,
    BIG_FILE_LINES,
    SECTION,
    TOP_FUNCTION,
    EDITING_TOOLS,
    SESSION_TITLE_LIMIT,
    API_REF,
    API_ROUTE,
    HTML_REF,
    MODULE_REF,
    state,
};