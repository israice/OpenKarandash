// Точка входа для вкладки Graph (vault): переэкспортирует всё из модулей по темам.
//
// Фактическая реализация разложена по файлам (DOCS/decisions/022):
//   graph-vault-core.js     — константы, пути, общее состояние
//   graph-vault-notes.js    — операции с заметками (запись, чтение, удаление)
//   graph-vault-project.js  — сканирование файлов проекта, разбор секций/функций
//   graph-vault-git.js      — история git
//   graph-vault-sessions.js — заметки о сессиях
//   graph-vault-sync.js     — синхронизация карты проекта (syncProjectMap)
//   graph-vault-graph.js    — построение графа из vault (buildVaultGraph)

const core = require('./graph-vault-core.js');
const notes = require('./graph-vault-notes.js');
const project = require('./graph-vault-project.js');
const git = require('./graph-vault-git.js');
const sessions = require('./graph-vault-sessions.js');
const sync = require('./graph-vault-sync.js');
const graph = require('./graph-vault-graph.js');

module.exports = {
    // core
    ROOT: core.ROOT,
    DATA_DIR: core.DATA_DIR,
    VAULT_DIR: core.VAULT_DIR,
    VAULT: core.VAULT,
    MAP_DIR: core.MAP_DIR,
    SESSION_DIR: core.SESSION_DIR,
    TEXT_FILES: core.TEXT_FILES,
    state: core.state,
    // notes
    collectNotes: notes.collectNotes,
    noteName: notes.noteName,
    writeNote: notes.writeNote,
    dropStaleNotes: notes.dropStaleNotes,
    resetWrittenNotes: notes.resetWrittenNotes,
    // project
    projectFiles: project.projectFiles,
    readText: project.readText,
    parseUnits: project.parseUnits,
    stripStringsAndComments: project.stripStringsAndComments,
    resolveRef: project.resolveRef,
    section: project.section,
    // git
    gitHistory: git.gitHistory,
    // sessions
    sessionNote: sessions.sessionNote,
    syncSessionNotes: sessions.syncSessionNotes,
    // sync
    syncProjectMap: sync.syncProjectMap,
    // graph
    buildVaultGraph: graph.buildVaultGraph,
    readFrontmatter: graph.readFrontmatter,
};