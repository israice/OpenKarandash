// Список CLI-агентов с сайта OpenRouter — один на страницу «New projects»
// (PROJECTS/Page 3) и на уровень CLI в каскаде выбора модели
// (SYSTEM/model-cascade.js). Лежит он здесь, а не в странице, потому что список
// теперь нужен двум местам, а тянуть его из страницы в шапку сессии нельзя:
// страница грузится динамическим import и может быть ещё не открыта.
//
// Список лежит в этом файле (SNAPSHOT ниже) и виден сразу. Сервер обновляет его
// условным запросом раз в час (loadCliAgents): если список на сайте другой —
// новый кладётся в localStorage и читается оттуда, если тот же — остаётся
// прежний, и страница об этом пишет. Проверку запускает кнопка страницы, а
// раз в час она же дёргает и сама; те, кому список нужен для показа, читают
// его одним движением через cliAgentNames.

const SOURCE_URL = 'https://openrouter.ai/apps/category/coding/cli-agent';

// Снимок списка на момент последней проверки сайта. Порядок — как на сайте.
// Меняется только если сервер вернул другой список (см. loadCliAgents).
export const SNAPSHOT = [
    'Hermes Agent', 'Claude Code', 'Kilo Code', 'Cline', 'Codex', 'omp', 'pi', 'Command Code',
    'OpenClaw', 'OpenHands', 'Strix', 'Proto Agent', 'Cursor', 'Letta', 'CodeGPT', 'goose',
    'Digen AI', 'Trenzel', 'mimocode', 'Crush', 'Traycer', 'Qwen Code', 'Ekko Studio',
    'AtomCode', 'OpenConfig', 'JONI', 'Aider', 'Kern Agent', 'r', 'Favur', 'babelfish',
    'Rayline', 'Vellum Assistant', 'op', 'Beast', 'Zorya', 'Gajae-Code', 'Minara', 'Nemo',
    'Junie', 'jinn', 'Gihanga CLI', 'AutoGov', 'folk landing chat draft', 'Andromity',
    'Hermes Web UI', 'PostQode', 'Mage', 'JiuwenSwarm',
];

// Наши собственные CLI: не с сайта, а наши. Такой стоит в уровне CLI всегда и
// первым, независимо от того, назвал его сайт или нет, а из списка сайта он
// убирается: иначе в раскрытом списке шапки оказалось бы две одинаковые строки
// подряд, и выбор между ними ничего бы не менял. Список сайта он не портит —
// сравнение с ним идёт по тому, что пришло с сайта (changed в loadCliAgents), а
// не по нашему списку
export const OWN_CLI = ['opencode'];

const LIST_KEY = 'noname.cliAgents';
const CHECKED_KEY = 'page3.checkedAt';
const HOUR = 60 * 60 * 1000;

// Показатели последней проверки — странице «New projects» есть что написать под
// списком. Проверку зовёт она же (кнопкой и по часу), а список забирают все
let lastCheck = { at: 0, changed: false, error: '' };

// Сохранённый список, иначе снимок из файла. Дубли с сайта убираем: список
// приходит именами, и повтор в раскрытом списке CLI читался бы как два разных
// агента с одинаковым названием
export function cliAgentNames() {
    try {
        const saved = JSON.parse(localStorage.getItem(LIST_KEY) || 'null');
        if (Array.isArray(saved) && saved.length) return [...new Set(saved.filter(Boolean))];
    } catch {
        // приватный режим или запрет на хранилище — читаем снимок из файла
    }
    return SNAPSHOT;
}

// Список имён для уровня CLI в каскаде: сперва наши собственные, потом сайт без
// них, потом (по словам вызывающего) подключённый CLI. Наборы сливаются в один
// без повторов: свой CLI, названный сайтом, иначе стоял бы в списке дважды
export function cliLevelNames(extra = []) {
    const fromSite = cliAgentNames().filter((name) => !OWN_CLI.includes(name));
    return [...new Set([...OWN_CLI, ...fromSite, ...extra])];
}

// Пункт списка CLI, у которого нет своего коннектора: название как есть, но
// за ним пока ничего не стоит. Каскад модели такие пункты знает, чтобы не
// выдавать им чужую строку модели, и чтобы место выбора не путало их с
// настоящим CLI (см. SYSTEM/model-cascade.js)
export function isStubCli(id) {
    return cliAgentNames().includes(id);
}

// Подписчики на смену списка: оба места, где список виден, перерисовываются под
// новый — иначе список в шапке сессии остался бы старым до перезагрузки
const listeners = new Set();

export function onCliAgents(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

function notify() {
    for (const fn of [...listeners]) fn(cliAgentNames());
}

// Проверка списка на сайте: сервер ходит условным запросом и отвечает «не
// изменилось» без скачивания тела (PROJECTS/Page 3/openrouter-cli-agents-server.js).
// Раз в час, самому сайту зря не ходим. Возвращает текущий список и показатели
// проверки — их страница пишет под списком
export async function loadCliAgents() {
    const since = Number(localStorage.getItem(CHECKED_KEY) || 0);
    if (since && Date.now() - since < HOUR) {
        return { names: cliAgentNames(), skipped: true, ...lastCheck };
    }
    let data;
    try {
        data = await App.api('/api/openrouter/cli-agents', {});
    } catch {
        lastCheck = { at: since, changed: false, error: 'сервер недоступен, список прежний' };
        return { names: cliAgentNames(), skipped: false, ...lastCheck };
    }
    if (!Array.isArray(data?.apps) || !data.apps.length) {
        lastCheck = { at: since, changed: false, error: data?.error || 'список не пришёл' };
        return { names: cliAgentNames(), skipped: false, ...lastCheck };
    }
    const fresh = [...new Set(data.apps.map((app) => app.name).filter(Boolean))];
    const names = cliAgentNames();
    const changed = fresh.join('\n') !== names.join('\n');
    try {
        localStorage.setItem(CHECKED_KEY, String(Date.now()));
        if (changed) localStorage.setItem(LIST_KEY, JSON.stringify(fresh));
    } catch {
        // хранилище запрещено — список останется снимком из файла
    }
    lastCheck = { at: Date.now(), changed, error: '' };
    if (changed) notify();
    return { names: changed ? fresh : names, skipped: false, ...lastCheck };
}
