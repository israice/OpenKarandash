// Подсказка приёма из памяти работника: какой из записанных приёмов относится
// к текущему запросу. Транспорт — typesafe.js, пороги — judgment-config.js.
//
// Устройство — из cookbook «skill suggestion» документации TypeSafe: два
// запроса. Первый читает все приёмы одной строкой (заголовок и «когда
// применим») и сужает список до трёх, второй перечитывает этих троих с полным
// текстом «что делать» и решает по каждому отдельным вопросом. Один запрос на
// выбор из всех сразу не годится: список размёженной, как показывает замер.
//
// Перед ними — фильтр общих приёмов. Приём, применимый к любой работе, подсказкой
// быть не может: он и так в AGENTS.override.md, а в выдаче он вытесняет
// настоящие приёмы (замер: «Кайдзен-цикл» выигрывал у всех на запросах про
// восстановление вкладки и про подхват после обрыва).
//
// Каждая функция возвращает null или пустой список, когда ключа нет, сервис не
// ответил или приёмов ещё нет: подсказка — украшение хода, а не его условие.

const fs = require('fs');
const path = require('path');
const typesafe = require('./typesafe.js');
const { THRESHOLDS, PROMPT_LIMIT } = require('./judgment-config.js');

const ROOT = path.join(__dirname, '..', '..');
const PROFILES_DIR = path.join(ROOT, 'PROJECTS', 'Flow', 'profiles');
const MEMORY_FILE = path.join('memories', 'skills.md');

// чей опыт читаем: имя профиля знает только клиент Flow, а ход идёт через
// /api/agent/ask, и в нём профиля нет (этот разрыв описан в DOCS/decisions/035).
// Поэтому память привязана к CLI: у ходящего агента каталог реального агента
// «Backend developer» (PROJECTS/Flow/profiles/Backend developer/README.md),
// а каталог QA достался в наследство от прежнего коннектора pi и к ходу,
// который ведёт pi, отношения не имеет (DOCS/decisions/078, 094).
// Клиент, знающий профиль, присылает его полем profile — он важнее таблицы
const PROFILE_BY_AGENT = { pi: 'Backend developer' };

function profileFor(agent, asked) {
    const name = String(asked || '').trim();
    if (name) return name;
    return PROFILE_BY_AGENT[String(agent || '').trim().split('-')[0]] || null;
}

// сколько приёмов разбираем: файл растёт, а описания едут в вопросе, и
// документация прямо называет причиной падения точности лишнее в вопросе
const MAX_SKILLS = 60;
// длина «когда применим»: условие применения и есть описание приёма для выбора,
// а длинный текст «что делать» в первом запросе только размывает выбор
const WHEN_LIMIT = 220;
const HOW_LIMIT = 700;
// сколько приёмов перечитываем вторым запросом
const SHORTLIST = 3;

// ---------- чтение памяти ----------

// приёмы одного профиля: заголовок и поля записи. Разбор на блоки по «## », поля
// — по их названиям: файл нарочно обычный markdown (DOCS/decisions/035), и менять
// его формат ради разбора нельзя — его читает и человек, и агент
function parseSkills(text) {
    const out = [];
    for (const block of String(text || '').split(/^## /m).slice(1)) {
        const title = block.split('\n')[0].trim();
        // группа 1, а не всё совпадение: иначе в поле остаётся сам ярлык
        // «Когда применим:», и приём перестаёт узнаваться — на замере это уводило
        // все попадания на общий «Кайдзен-цикл», потому что его поле начинается
        // со слов «Любая работа», а с ярлыком рядом — уже не узнаётся
        const field = (name) => (block.match(new RegExp(`\\*\\*${name}:\\*\\*\\s*([\\s\\S]*?)(?=\\n- \\*\\*|\\n\\n|$)`)) || [, ''])[1]
            .replace(/\s+/g, ' ').trim();
        if (title && !title.includes('?')) out.push({ title, when: field('Когда применим'), how: field('Что делать') });
    }
    return out;
}

// файл читаем и перечитываем, только когда он изменился: приёмов полсотни, а
// каждый ход читать диск незачем. Метка — время правки файла
const cache = new Map();
// отсечённые общие приёмы помним отдельно: решение зависит только от файла, а не
// от запроса, и без этого фильтр платил бы отдельным запросом на каждом ходе
const specific = new Map();

function skillsOf(profile) {
    const name = String(profile || '');
    // имя профиля становится путём — пускаем только простое имя папки
    if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) return [];
    let stat;
    try {
        stat = fs.statSync(path.join(PROFILES_DIR, name, MEMORY_FILE));
    } catch {
        return [];
    }
    const hit = cache.get(name);
    if (hit && hit.mtimeMs === stat.mtimeMs) return hit.skills;
    let skills = [];
    try {
        skills = parseSkills(fs.readFileSync(path.join(PROFILES_DIR, name, MEMORY_FILE), 'utf8')).slice(-MAX_SKILLS);
    } catch {
        skills = [];
    }
    cache.set(name, { mtimeMs: stat.mtimeMs, skills });
    specific.delete(name); // файл изменился — прежнее решение фильтра больше не годится
    return skills;
}

// ---------- фильтр общих приёмов ----------

// приём, написанный как «любая работа по любой части проекта», — это правило
// проекта, а не приём под ситуацию. Отсекаем его отдельным вопросом на каждый
// приём: список известен заранее, вопросы независимы и едут одним запросом.
// Результат помним по имени профиля: файл не менялся — решение не меняется
async function dropGeneral(profile, skills) {
    // id проставляем здесь и всегда: дальше по ним строятся критерии вопросов, и
    // без них все приёмы схлопываются в один ключ `undefined` — вопрос вырождается,
    // а подсказка молча пропадает. Отказ фильтра не должен ломать подбор.
    const ids = skills.map((s, i) => ({ ...s, id: `s${i + 1}` }));
    const hit = specific.get(profile);
    if (hit && hit.length) return hit;
    if (ids.length < 3) return ids;
    const state = { skills: {} };
    const questions = {};
    for (const s of ids) {
        state.skills[s.id] = { title: s.title, applies_when: s.when.slice(0, WHEN_LIMIT) };
        questions[s.id] = {
            type: 'noul',
            instructions: `Is \`skills.${s.id}\` a rule for any work at all, rather than a technique for one particular situation?`,
            criteria: {
                true: { what: 'It tells how to work in general and fits any request.', examples: ['Любая работа по любой части проекта'] },
                false: { what: 'It applies to one described situation: a named file, a specific error, a particular kind of task.', examples: ['Задача добавляет колонки в DATA/.sessions.db'] },
            },
        };
    }
    const res = await typesafe.systemOne(state, questions);
    // нет ответа — фильтровать нечем, и запоминать нечего: в следующий раз спросим снова
    if (!res?.answers) return ids;
    const left = ids.filter((s) => (typesafe.noul(res.answers, s.id) ?? 0) < THRESHOLDS.skillGeneral);
    // отсекло всё — значит фильтр отвечает ерундой, и верить ему нельзя: берём всё
    if (left.length) specific.set(profile, left);
    return left.length ? left : ids;
}

// ---------- подбор приёма ----------

// { title, when, how, match } либо null — подсказки нет
async function pickSkill({ request, agent, profile }) {
    const name = profileFor(agent, profile);
    const text = String(request || '').trim();
    const all = skillsOf(name);
    if (!typesafe.isEnabled() || text.length < 20 || !all.length) return null;

    const skills = await dropGeneral(name, all);
    if (!skills.length) return null;

    // первый запрос: все приёмы одной строкой, ответ — три кандидата
    const short = { request: text.slice(0, PROMPT_LIMIT), skills: {} };
    const criteria = { none: { what: 'No technique recorded here applies to this request; the general rules of the project are enough.' } };
    for (const s of skills) {
        const when = s.when.slice(0, WHEN_LIMIT);
        short.skills[s.id] = `${s.title}. Applies when: ${when}`;
        criteria[s.id] = { what: `The technique "${s.title}", which applies when: ${when}` };
    }
    const first = await typesafe.systemOne(short, {
        pick: {
            type: 'choice',
            instructions: {
                question: 'Which recorded technique is most relevant to `request`?',
                focus: 'Each is a technique that already worked on this project in one described situation.',
            },
            criteria,
        },
    });
    if (!first?.answers) return null;

    const top = Object.entries(first.answers.pick?.probabilities || {})
        .filter(([id, p]) => id !== 'none' && p > 0)
        .sort((a, b) => b[1] - a[1])
        .slice(0, SHORTLIST);
    if (!top.length) return null;

    // второй запрос: те же три с полным текстом, решение по каждому отдельно.
    // Один выбор на троих снова размазал бы вероятность — вопросы независимы
    const full = { request: short.request, skills: {} };
    const questions = {};
    for (const [id] of top) {
        const s = skills.find((one) => one.id === id);
        if (!s) continue;
        full.skills[id] = { title: s.title, applies_when: s.when.slice(0, WHEN_LIMIT), how: s.how.slice(0, HOW_LIMIT) };
        questions[id] = {
            type: 'noul',
            instructions: `Is \`request\` the very situation \`skills.${id}\` was written for, rather than a neighbouring one?`,
            criteria: {
                true: { what: 'The request is in the situation the technique describes.' },
                false: { what: 'A neighbouring situation: same words or the same tool, but not the case the technique was written for.' },
            },
        };
    }
    const second = await typesafe.systemOne(full, questions);
    if (!second?.answers) return null;

    // порядок — сперва насколько уверенно это тот самый случай, потом рейтинг
    const ranked = top
        .map(([id, p]) => ({ id, rank: p, match: typesafe.noul(second.answers, id) }))
        .filter((one) => one.match !== null)
        .sort((a, b) => (b.match - a.match) || (b.rank - a.rank));
    const best = ranked[0];
    if (!best || best.match < THRESHOLDS.skillMatch) return null;
    return { ...skills.find((s) => s.id === best.id), match: best.match };
}

// строка в запрос агента. Подсказка не приказ: приём может оказаться лишним, и
// агент решает сам — поэтому «если подходит», а не «сделай»
function skillPreamble(skill) {
    if (!skill) return '';
    return `[OpenKarandash] Из памяти работника к этой задаче: «${skill.title}». `
        + `Когда применим: ${skill.when}. Что делать: ${skill.how} `
        + 'Это подсказка, а не обязательное правило: если случай не тот — забудь её и работай как обычно.\n\n';
}

// что из подбора приёма пишется в result_meta хода — тем же полем, что и
// подсказки записок (DOCS/decisions/089): заголовок, оценка совпадения и
// уверенность. По этим числам пороги перемеряются на живых данных
function skillTrace(skill) {
    if (!skill) return null;
    return { title: skill.title, match: skill.match };
}

module.exports = { pickSkill, skillPreamble, skillTrace, parseSkills, skillsOf };