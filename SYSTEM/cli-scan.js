// Что есть на этой машине из списка CLI.
//
// Уровень CLI в строке выбора перечисляет имена с сайта OpenRouter
// (SYSTEM/cli-agents.js) — там полсотни имён, а установлено бывает десяток.
// Разницы на экране не было: выбираешь несуществующее имя, Gateway/Provider/
// Model встают на прочерки, и ошибка приходит только при отправке хода. Здесь
// лежит ответ сервера на вопрос «кого из списка здесь можно звать» — чтобы
// строка выбора помечала доступное другим фоном, а недоступное гасила.
//
// Отдельный файл рядом с cli-agents.js, а не в нём: там список ИМЁН (откуда они
// взялись и как обновляются), здесь — ЧТО НА МАШИНЕ (и это спрашивается у
// сервера, а не выводится из списка имён). Смешались бы — и правка источника
// имён лезла бы в наличие.
//
// Метки, а не включённость пункта: недоступное имя остаётся видимым и
// выбираемым — человек может прямо сейчас поставить этот CLI, и выбор не должен
// исчезать у него из-под курсора. Гаснет только вид.
//
// Три состояния, и «неизвестно» от «нет» отличается намеренно:
//
//   ready   — CLI нашёлся и ответил (`--version` прошёл). Зелёный.
//   empty   — CLI ответил, а каталог моделей у него пуст (OpenClaw, Cline,
//             Codex на этой машине). Жёлтый: ход пойти может, но выбирать
//             модель пока не из чего.
//   missing — команды на машине нет. Серый, как и раньше.
//   unknown — сервер не ответил или ответил не про это имя. Вид обычный: гасить
//             пункт, о котором мы ничего не знаем, значит соврать.
const listeners = new Set();

// { [имя]: 'ready' | 'empty' | 'missing' } — то, что пришло с сервера
let marks = {};
// тот же ответ, но в localStorage: после перезагрузки страницы до первого ответа
// сервера строка уже знает, кого красить, и не мигает серым по всем
const KEY = 'noname.cliScan';

// Подписчики на смену разведки: строка выбора перерисовывается под неё, и по
// той же причине, что и под список имён с сайта (onCliAgents)
export function onCliScan(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

function notify() {
    for (const fn of [...listeners]) fn(marks);
}

function read() {
    try {
        const saved = JSON.parse(localStorage.getItem(KEY) || 'null');
        return saved && typeof saved === 'object' ? saved : {};
    } catch {
        return {};
    }
}

function write(value) {
    marks = value;
    try {
        localStorage.setItem(KEY, JSON.stringify(value));
    } catch {
        // приватный режим — работаем без сохранения, отметки живут до reload
    }
}

// Состояние имени CLI для интерфейса. 'unknown' — не «нет», а «сервер не
// ответил»: подсветка не врёт и не гасит то, о чём мы не знаем
export function scanMarkOf(name) {
    return marks[name] || 'unknown';
}

// Метка по ответу сервера. `installed: false` — команды на машине нет, и это
// единственный случай, когда пункт гасится. Установленный, но не ответивший на
// `--version`, — не «нет»: он виден человеку именно тем, что сломан, и прятать
// его от того, кто чинит, незачем
function markOf(entry) {
    return entry && entry.installed !== false ? 'ready' : 'missing';
}

// Список меток для имён с сайта: тем же запросом, каким строке нужны и имена,
// иначе она спросила бы про одно, а красила бы по другому
export async function refreshCliScan(names) {
    const list = Array.isArray(names) ? names.filter(Boolean) : [];
    if (!list.length) return marks;
    let data;
    try {
        data = await App.api('/api/agent/scan', { names: list });
    } catch {
        // сервер недоступен: оставляем то, что знали, — гасить строку в
        // предположении «ничего не установлено» было бы выдумкой
        return marks;
    }
    const results = data?.results;
    if (!results || typeof results !== 'object') return marks;
    // Имя, которого нет в ответе, — «неизвестно», а не «нет»: сервер спрашивал
    // о конкретном списке, и молчание про одно имя не значит, что команды нет
    const next = {};
    for (const name of list) next[name] = results[name] ? markOf(results[name]) : 'unknown';
    write(next);
    notify();
    return marks;
}

// Пустой каталог моделей известен только после подключения (connect его и
// привозит), поэтому строка помечает его сама, зная каталог у провайдера.
// Переводим в «empty» только того, кто и до этого был «ready»: у не установленного
// CLI каталог и не может быть непустым, а пустой каталог у «неизвестного» означил
// бы ровно то, чего мы не знаем
export function markEmptyCatalogue(name) {
    if (scanMarkOf(name) !== 'ready') return;
    write({ ...marks, [name]: 'empty' });
    notify();
}

// Первая загрузка: сначала отметки из прошлой проверки (страница показывается
// без мигания), затем сервер. Повторных проверок отсюда нет — ответ сервера сам
// лежит с TTL (SYSTEM/cli/scan-server.js), и спрашивать раньше бессмысленно:
// тот отдаст прошлый ответ и заново процессы запускать не станет
export function initCliScan(names) {
    if (marks && Object.keys(marks).length) return marks;
    write(read());
    refreshCliScan(names);
    return marks;
}