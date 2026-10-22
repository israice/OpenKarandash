const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const { collect } = require(path.join(ROOT, 'TOOLS', 'homework', 'collect.js'));
const { anchorsOf } = require(path.join(ROOT, 'TOOLS', 'homework', 'anchors.js'));
const REPORT_LIMIT = 12000;
const MIN_CHARS = 600;
const WORK_QUESTION = {};
const maps = new Map();

function clipReport(report) {
    const text = String(report || '');
    if (text.length <= REPORT_LIMIT) return text;
    const cut = text.slice(0, REPORT_LIMIT);
    return `${cut.slice(0, cut.lastIndexOf('\n'))}\n…(отчёт обрезан)`;
}

function mapOf(report) {
    return String(report || '')
        .split('\n')
        .filter((line) => line.startsWith('## Файл'))
        .slice(0, 12)
        .map((line) => line.replace(/^##\s*/, '').trim())
        .join('\n');
}

function bindSession(sessionId, homework) {
    if (!sessionId || !homework || !homework.map) return;
    maps.set(sessionId, { map: homework.map, kind: homework.kind, files: homework.files, chars: homework.chars });
}

async function pickHomework({ request, sessionId }) {
    const text = String(request || '').trim();
    if (!text || text.length < 10) return null;
    const known = sessionId ? maps.get(sessionId) : null;
    if (known && !anchorsOf(text).code.length) {
        return { ...known, report: null, work: null, reused: true, sent: known.map.length };
    }
    let built;
    try {
        built = collect(text);
    } catch {
        return null;
    }
    if (!built.code.length || !built.files.length || built.chars < MIN_CHARS) return null;
    const found = { map: mapOf(built.report), kind: built.kind?.id || null, files: built.files.length, chars: built.chars };
    if (sessionId) maps.set(sessionId, found);
    const clipped = clipReport(built.report);
    return { ...found, report: clipped, sent: clipped.length, work: null, reused: false };
}

function homeworkPreamble(homework) {
    if (!homework) return '';
    if (homework.reused) {
        return `[OpenKarandash] По этой сессии отчёт уже собран, вот его карта — файлы и строки, `
            + `где смотреть (${homework.files} файлов, ${homework.kind || 'тип не определён'}):\n\n${homework.map}\n\n`
            + 'Кусков кода здесь нет намеренно: полный отчёт был в первом запросе этой сессии.\n\n';
    }
    return `[OpenKarandash] Домашняя работа по этому запросу уже собрана (${homework.files} файлов, `
        + `${homework.kind || 'тип не определён'}), искать то же самое ещё раз не нужно:\n\n${homework.report}\n\n`
        + 'Отчёт указывает, где смотреть, но решение и правка за тобой: он мог указать не туда.\n\n';
}

module.exports = { pickHomework, homeworkPreamble, bindSession, clipReport, WORK_QUESTION };
