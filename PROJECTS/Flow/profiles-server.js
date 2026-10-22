// Память навыков работника: удачные приёмы, которые профиль накопил за прошлые
// задания. Смысл — не начинать похожую работу с нуля: в конце задачи агент
// дописывает сюда приём, а в начале следующей читает, что уже сработало.
//
// Живёт в каталоге самого профиля (PROJECTS/Flow/profiles/<Роль>/memories/skills.md),
// потому что профиль — это каталог агента (DOCS/decisions/028, 033), и память
// работника принадлежит работнику, а не проекту. Память проекта — отдельная и
// общая, она в DATA/vault (AGENTS.md).
//
// Файл нарочно обычный markdown, а не таблица в базе: его читает и человек, и
// агент. Заводить под это ещё одну базу значило бы завести вторую систему
// памяти рядом с vault.

const fs = require('node:fs');
const path = require('node:path');
const { readJson, sendJson } = require('../../SYSTEM/core/http.js');
const PROFILES_DIR = path.join(__dirname, 'profiles');
const MEMORY_FILE = path.join('memories', 'skills.md');

// имя профиля приходит с клиента и становится путём — пускаем только простое имя
// папки: без разделителей и без «..», иначе запись ушла бы за пределы profiles/
function profileDir(name) {
    if (typeof name !== 'string' || !name.trim()) return null;
    if (name.includes('/') || name.includes('\\') || name.includes('..')) return null;
    const dir = path.join(PROFILES_DIR, name);
    return fs.existsSync(dir) ? dir : null;
}

function listProfiles() {
    if (!fs.existsSync(PROFILES_DIR)) return [];
    return fs.readdirSync(PROFILES_DIR, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
}

// весь файл памяти как есть: разбирать markdown на структуры не нужно — его
// потребитель либо человек, либо модель, оба читают текст
function readMemory(name) {
    const dir = profileDir(name);
    if (!dir) return null;
    const file = path.join(dir, MEMORY_FILE);
    try {
        return fs.readFileSync(file, 'utf8');
    } catch {
        return ''; // приёмов ещё нет — это не ошибка, а пустая память
    }
}

// сколько приёмов записано: считаем заголовки второго уровня, чтобы карточка
// работника могла показать число, не вчитываясь в текст
function countSkills(text) {
    return (text || '').split('\n').filter((line) => line.startsWith('## ')).length;
}

const HEADER = [
    '# Память навыков',
    '',
    'Приёмы, которые уже сработали в этом проекте. Дописывает агент в конце задачи,',
    'читает — в начале следующей, чтобы не выводить заново то, что однажды вывели.',
    'Запись стоит делать, только если приём проверен: не «наверное, помогает», а',
    '«сделал так — получилось, вот чем подтверждено».',
    '',
].join('\n');

// добавление приёма: файл заводится по первой записи, новые идут в конец —
// хронология важнее сортировки, по ней видно, как рос опыт работника
function appendSkill(name, { title, when, how, proof, session }) {
    const dir = profileDir(name);
    if (!dir) return { ok: false, error: `Unknown profile: ${name}` };
    if (!title?.trim() || !how?.trim()) return { ok: false, error: 'title and how are required' };

    const file = path.join(dir, MEMORY_FILE);
    fs.mkdirSync(path.dirname(file), { recursive: true });

    const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : HEADER;
    const stamp = new Date().toISOString().slice(0, 10);
    const entry = [
        '',
        `## ${title.trim()}`,
        '',
        `- **Когда применим:** ${when?.trim() || 'не указано'}`,
        `- **Что делать:** ${how.trim()}`,
        `- **Чем подтверждён:** ${proof?.trim() || 'не указано'}`,
        `- **Записано:** ${stamp}${session ? ` (сессия ${session})` : ''}`,
        '',
    ].join('\n');

    fs.writeFileSync(file, existing.trimEnd() + '\n' + entry);
    return { ok: true, file: path.relative(path.join(__dirname, '..', '..'), file) };
}

function createRoutes() {
    return {
        // список работников и объём их опыта — для карточек на канвасе
        '/api/flow/profiles': (req, res) => {
            const profiles = listProfiles().map((name) => ({
                name,
                skills: countSkills(readMemory(name)),
            }));
            sendJson(res, { ok: true, profiles });
        },

        '/api/flow/profile/memory': async (req, res) => {
            const { profile } = await readJson(req);
            const text = readMemory(profile);
            if (text === null) {
                sendJson(res, { ok: false, error: `Unknown profile: ${profile}` });
                return;
            }
            sendJson(res, { ok: true, profile, text, skills: countSkills(text) });
        },

        '/api/flow/profile/memory/add': async (req, res) => {
            const body = await readJson(req);
            sendJson(res, appendSkill(body.profile, body));
        },
    };
}

module.exports = { createRoutes, listProfiles, readMemory, appendSkill, countSkills };
