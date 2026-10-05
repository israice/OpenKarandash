// Заслон на время первой сборки страницы: пока перечисленные разделы не
// дорисовали своё содержимое, страница не показывается вовсе и открывается сразу
// целиком. Без этого вкладка Sessions (да и любая другая) открывалась раньше,
// чем доехали список сессий и лента: первая отрисовка страницы — 128 мс, а
// данные приходят на сотни миллисекунд позже (замер: /api/sessions на 460 мс, а
// когда сервер восстанавливает окружение CLI — и на 3800 мс), и человек видел, как
// страница достраивается на глазах.
//
// Метку data-booting ставит скрипт в <head> (SYSTEM/index.html) ещё до разбора
// тела — иначе успела бы мелькнуть пустая страница. Пока метка стоит, тело страницы
// скрыто через visibility (SYSTEM/styles/base.css): именно visibility, а не
// display, — скрытый таким способом элемент сохраняет размеры, и разделы, которые
// до первой отрисовки меряют холст и поля (Flow центрируется, редакторы файлов
// пересчитывают ширину), получают настоящую геометрию.
//
// Раздел сообщает о готовности одним вызовом MissionBoot.task(имя, промис) —
// заслон снимается, когда дошли все зарегистрированные задачи и страница
// загрузилась (load). Страховка по времени одна (IDLE_MS и CEIL_MS): зависший
// запрос не должен оставить человека перед пустым экраном навсегда.
//
// Отдельно учтены серверные фрагменты htmx (список сессий панели Sessions и
// лента Telegram — /api/fragment/*). Их подмена приходила уже после снятия
// заслона: замер показывал список сессий через 10 мс после показа страницы, а
// ленту Telegram — через 2,5 с. Оба приезжают с запросом по hx-trigger="load",
// то есть ровно тогда, когда страница ещё собирается, и учёт их в общем счётчике
// даёт «сначала всё, потом разом». Учитывается первая подмена от каждого
// инициатора: опрос раз в 5 с (hx-trigger="every 5s") относится уже к живой
// странице, а не к её сборке.
//
// Состояние лежит на window, а не в замыкании: файл подключают ещё и горячей
// перезагрузкой (SYSTEM/hot-reload.js), и повторное выполнение не должно завести
// второе независимое состояние.

// Страховка живёт по простою, а не от начала сборки: пока задачи идут, счёт
// перезапускается на каждом движении (задача началась или закончилась).
// Общий предел прежних трёх секунд резал медленный сервер пополам — страница
// показывалась на 3,0 с, а лента Telegram доезжала на 5,4 с, то есть ровно то,
// что заслон и должен прятать. Замер: холодный сервер отдаёт список сессий и
// ленту за 0,5 с, а восстановление окружения CLI — на 5,3 с, и страница ждёт
// именно его: раньше она показывалась, а лента Sessions доезжала после.
const IDLE_MS = 8000;
// и общий предел на всю сборку: счёт по простоу перезапускается, а страница не
// должна ждать вечно из-за одного запроса, который не кончается никогда
const CEIL_MS = 30000;

// состояние общее на все выполнения файла (см. шапку)
const state = window.__okBoot || (window.__okBoot = {
    tasks: new Set(), loaded: false, revealed: false, idleTimer: 0, startedAt: 0,
});
if (!state.startedAt) state.startedAt = performance.now();

// перенос счёта простоя: каждое движение сборки начинает отсчёт заново
function arm() {
    clearTimeout(state.idleTimer);
    if (performance.now() - state.startedAt > CEIL_MS) return;
    state.idleTimer = setTimeout(reveal, IDLE_MS);
}

// снять метку со <html> — страница показана
function reveal() {
    if (state.revealed) return;
    state.revealed = true;
    clearTimeout(state.idleTimer);
    document.documentElement.removeAttribute('data-booting');
}

// показать можно, когда страница загрузилась и все разделы дорисовали своё
function check() {
    if (state.revealed || !state.loaded || state.tasks.size) return;
    reveal();
}

// задача раздела: промис первой его отрисовки. Ошибка запроса задачей не
// считается: показать страницу надо в любом случае
export function bootTask(name, promise) {
    if (state.revealed) return promise;
    const tracked = Promise.resolve(promise).catch(() => {});
    state.tasks.add(tracked);
    arm();
    tracked.then(() => {
        state.tasks.delete(tracked);
        arm();
        check();
    });
    return promise;
}

// Подмена фрагмента — тоже содержимое страницы: показывать страницу раньше
// подмены нельзя. Задача заводится на первом запросе от инициатора и снимается
// на htmx:afterSettle либо на любой ошибке запроса — иначе зависший запрос
// держал бы заслон до потолка по времени. Фильтра по элементу нет: на первой
// сборке страницы идут только эти запросы, а подмена oob меняет не тот узел,
// на котором висит инициатор, и сверять тут нечего.
const htmxTracked = new WeakSet();
document.addEventListener('htmx:beforeRequest', (event) => {
    const elt = event.detail?.elt;
    if (state.revealed || !elt || htmxTracked.has(elt)) return;
    htmxTracked.add(elt);
    const swapped = new Promise((resolve) => {
        const done = () => {
            document.removeEventListener('htmx:afterSettle', done);
            for (const failure of ['htmx:responseError', 'htmx:sendError', 'htmx:timeout']) {
                document.removeEventListener(failure, done);
            }
            resolve();
        };
        document.addEventListener('htmx:afterSettle', done);
        for (const failure of ['htmx:responseError', 'htmx:sendError', 'htmx:timeout']) {
            document.addEventListener(failure, done);
        }
    });
    const path = event.detail?.requestConfig?.path || 'fragment';
    bootTask('htmx:' + path, swapped);
});

if (!state.loaded) {
    window.addEventListener('load', () => {
        state.loaded = true;
        check();
    });
    // страховка на случай, когда ни одна задача так и не началась: иначе заслон
    // держал бы только что загрузившаяся пустая страница
    arm();
}

// разделы, у которых нет промисов (импорт не нужен, а разделы подключены обычным
// тегом), зовутwindow.MissionBoot.task — например Flow и кнопка «+»
window.MissionBoot = {
    task: bootTask,
    revealed: () => state.revealed,
};
