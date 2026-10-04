// Одна сессия в трёх отображениях: Sessions, Feed и Flow < TEMP < 321. Все три рисуют одни и
// те же строки /api/sessions/messages, и расхождение между ними — дефект. Сценарий открывает
// сессию в каждом из трёх и сверяет число строк с базой; разбивку по видам отдаёт как есть.
//
// Параметры:
//   session=<id>   какую сессию сверять; без него — самую новую (по createdOrder)
//   wait=<мс>      сколько ждать отрисовки каждого отображения (по умолчанию 3000)
//
// Что сценарий меняет: строк сессии не трогает. В Flow он выбирает сессию на канвасе «321» (канвас
// для того и заведён) и по окончании возвращает активным тот пункт меню Flow, что был до него.
// Активный пункт Flow хранится на сервере (/api/flow/state, ключ flowActiveFlow), поэтому на время
// сценария он меняется и у пользователя — до следующей загрузки его страницы это незаметно.
// Идущую сессию сверять бессмысленно: строки прибывают, пока сценарий переходит между вкладками.
async function scenario(P) {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const pause = Number(P.wait) || 3000;
    const post = async (url, body) => (await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })).json();
    const tally = (list) => list.reduce((acc, key) => { acc[key] = (acc[key] || 0) + 1; return acc; }, {});
    // вид строки — модификатор класса: chat-message--user, session-feed__card--tool, flow-node--kind-thinking
    const kindOf = (el, prefix, skip = []) => [...el.classList].filter((c) => c.startsWith(prefix)).map((c) => c.slice(prefix.length)).find((k) => !skip.includes(k)) || '?';
    // список сессий в Feed и Flow перечитывается по mousedown на самом select
    const pick = async (select, value) => {
        select.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        await wait(1500);
        if (![...select.options].some((o) => o.value === value)) return false;
        select.value = value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        await wait(pause);
        return true;
    };

    const { sessions = [] } = await post('/api/sessions');
    if (!sessions.length) return { ok: false, error: 'На сервере нет ни одной сессии' };
    const session = P.session ? sessions.find((s) => s.id === P.session) : sessions.reduce((a, s) => (s.createdOrder > a.createdOrder ? s : a));
    if (!session) return { ok: false, error: `Сессии ${P.session} нет`, latest: sessions.slice(0, 5).map((s) => `${s.id} ${String(s.title).slice(0, 60)}`) };
    const sid = session.id;

    const db = (await post('/api/sessions/messages', { id: sid })).messages || [];
    const out = { session: sid, title: String(session.title).slice(0, 80), running: session.running, db: { rows: db.length, roles: tally(db.map((m) => m.role)) } };

    // Sessions: строка базы — один .chat-message в #chatList (именно по id: .chat-list есть и у Home);
    // блоки Details, строка ожидания, черновик и пометка «ход прерван» строками базы не являются
    MissionTabs.show('chat');
    await wait(500);
    await App.openSession(sid, session.running);
    await wait(pause);
    const rows = [...document.querySelectorAll('#chatList > .chat-message')]
        .filter((el) => !['pending', 'draft', 'interrupted'].some((k) => el.classList.contains(`chat-message--${k}`)));
    out.sessions = { rows: rows.length, kinds: tally(rows.map((el) => kindOf(el, 'chat-message--', ['tool-plain']))) };

    // Feed: страница кнопки «+», карточка на строку плюс одна сводная (--meta)
    const feedButton = document.querySelector('.toolbar [data-folder="Feed"]');
    if (!feedButton) out.feed = { found: false };
    else {
        feedButton.click();
        await wait(2500); // модуль страницы грузится при первом открытии
        const select = document.getElementById('sessionFeedSelect');
        const listed = select ? await pick(select, sid) : false;
        document.getElementById('sessionFeedReset')?.click(); // отбор с прошлого раза скрыл бы часть карточек
        await wait(300);
        const page = document.getElementById(feedButton.dataset.page);
        const cards = [...(page || document).querySelectorAll('.session-feed__card:not(.session-feed__card--meta)')];
        out.feed = { found: Boolean(select), listed, rows: cards.length, counter: document.getElementById('sessionFeedCount')?.textContent.trim(),
            kinds: tally(cards.map((el) => kindOf(el, 'session-feed__card--', ['dense', 'error']))) };
    }

    // Flow: нода на строку (data-session + data-position); ноды файлов (data-file) — не строки
    const activeBefore = document.querySelector('#flowNav .side-nav__item--active')?.dataset.flow;
    MissionTabs.show('flow');
    await wait(800);
    const canvas = document.querySelector('#flowNav .side-nav__item[data-flow="321"]');
    if (!canvas) out.flow = { found: false, known: [...document.querySelectorAll('#flowNav .side-nav__item')].map((b) => b.dataset.flow) };
    else {
        canvas.click();
        await wait(800);
        const listed = await pick(document.getElementById('flowSessionSelect'), sid);
        const nodes = [...document.querySelectorAll('.flow-node')].filter((n) => n.dataset.session === sid);
        const messageNodes = nodes.filter((n) => n.dataset.position !== undefined && !n.dataset.file);
        out.flow = { found: true, listed, rows: messageNodes.length, fileNodes: nodes.filter((n) => n.dataset.file).length,
            kinds: tally(messageNodes.map((n) => kindOf(n, 'flow-node--kind-').replace(/^tool-.*/, 'tool'))) };
        if (activeBefore && activeBefore !== '321') {
            document.querySelector(`#flowNav .side-nav__item[data-flow="${CSS.escape(activeBefore)}"]`)?.click();
        }
    }

    // сверка: число строк везде равно базе; реплики человека и размышления все три показывают
    // отдельным видом, поэтому их счёт тоже обязан совпасть. Остальные виды у отображений
    // сгруппированы по-разному (Sessions рисует шагом всё, кроме реплик и размышлений)
    out.mismatch = [];
    for (const view of ['sessions', 'feed', 'flow']) {
        const v = out[view];
        if (!v || v.found === false) { out.mismatch.push(`${view}: отображение не найдено`); continue; }
        if (v.listed === false) { out.mismatch.push(`${view}: сессии нет в списке выбора`); continue; }
        if (v.rows !== out.db.rows) out.mismatch.push(`${view}: строк ${v.rows}, в базе ${out.db.rows}`);
        for (const kind of ['user', 'thinking']) {
            if ((v.kinds[kind] || 0) !== (out.db.roles[kind] || 0)) out.mismatch.push(`${view}: ${kind} ${v.kinds[kind] || 0}, в базе ${out.db.roles[kind] || 0}`);
        }
    }
    out.ok = out.mismatch.length === 0;
    return out;
}
