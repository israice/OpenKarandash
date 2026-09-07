// Серверная половина вкладки Kanban: в проект встроен beads-web — npm-пакет
// `beads-kanban-ui`, готовая доска Beads. Внутри пакета лежит Rust-бинарь со
// вшитым Next.js-интерфейсом; своей доски мы не рисуем, вкладка показывает его.
//
// Клиентская половина — PROJECTS/Kanban/kanban.js.
//
// Модуль делает две вещи:
//
// 1. Держит бинарь живым: поднимает по первому заходу на вкладку Kanban (не при
//    старте сервера — иначе второй слушающий процесс заводился бы всегда, даже
//    если доску не открывали) и регистрирует в нём папку проекта. Наш перезапуск
//    он переживает: доску мы не гасим и заново не заводим, а подхватываем ту же —
//    иначе каждое обновление сервера поднимало бы отдельный процесс доски и
//    отнимало у неё двадцать секунд на старт. Порт — BEADS_PORT из .env, `0`
//    выключает доску совсем. Браузер бинарь не открывает: это
//    делает только команда `bead-kanban` из пакета, а её мы не зовём — запускаем
//    сам бинарь.
// 2. Отдаёт его через наш порт. Это не украшение: пока кадр смотрел на
//    localhost:3008, он был чужого origin, и Karandash не мог заглянуть внутрь —
//    подсвечивал доску одним прямоугольником на весь экран. С нашего порта его
//    документ доступен, и карандаш указывает на кнопки и карточки самого beads.
//
// Подробности — DOCS/decisions/021.

const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');
const { readJson, sendJson } = require('../../SYSTEM/core/http.js');

const HEALTH_TIMEOUT_MS = 20_000;  // столько ждём, пока бинарь поднимется
const HEALTH_INTERVAL_MS = 300;

// адрес, по которому доска видна снаружи: кадр вкладки смотрит сюда
const MOUNT = '/kanban-ui';

// собственные разделы API beads-web — собраны из его же бандла (`"/api/...` в
// _next/static/chunks). С нашими не пересекаются: у нас agent/sessions/fragment/
// obsidian/search/file/pages/screenshot/flow/toolbar/kanban, у него — эти.
// Список явный, а не «всё неизвестное ему»: чужой раздел не должен молча
// перехватывать наш маршрут, если тот однажды опечатается
const BEADS_API = new Set([
    'agents', 'bd', 'beads', 'fs', 'git', 'health',
    'memory', 'projects', 'project-tags', 'tags', 'watch',
]);

// Заголовок «Manage Your Beads Projects» на списке проектов: убираем его правилом,
// дописанным в конец её же таблицы стилей. Место выбрано не от красоты — это
// единственная точка, где можно вмешаться до первого кадра и мимо React.
// Разметку доска отдаёт с сервера уже с заголовком, поэтому он успевает
// отрисоваться; убирать его из документа кадра (kanban.js) можно только после
// гидратации, и человек видит, как он появляется и пропадает. Вырезать <h1> из
// проксируемого HTML нельзя — React сверяет документ со своим деревом и вставит
// его обратно; вставить свой <style> в <head> — тоже ненадёжно по той же причине.
// А содержимое .css-файла React не смотрит вовсе, и таблица стилей блокирует
// первую отрисовку — заголовка не видно ни кадра. Специфичности `main>h1.font-heading`
// (0,1,2) хватает поверх утилитных классов Tailwind (0,1,0)
//
// Строка под этим заголовком — чужая рекомендация поставить Beads Orchestration
// Skill со ссылкой наружу — убрана тем же способом и в те же два шага: к нашей
// работе она отношения не имеет. Зацепиться, кроме утилитных классов, не за что —
// ни роли, ни подписи у абзаца нет, поэтому селектор держится за позицию
// (единственный прямой <p> списка проектов) и за цвет текста
//
// Тем же правилом убрана панель быстрых фильтров доски (поиск, тип, статусы,
// «Today», Memory, Agents) — она нам не нужна. Узел здесь только прячется, а не
// вынимается из документа, как заголовок: в отличие от него, панель — живая часть
// дерева React, её родитель перерисовывается на каждое обновление доски, и
// удалённый руками узел вернулся бы обратно. Цепляемся за роль и подпись
// (`role="toolbar"`, `aria-label="Quick filters"`), а не за утилитные классы:
// набор классов меняется от вёрстки, роль с подписью — часть доступности
//
// Так же убрана и плавающая кнопка «Start feedback mode» — свой карандаш
// beads-web: для комментариев к интерфейсу у нас есть Karandash, и вторая такая
// кнопка поверх доски только мешает. Она тоже живая часть дерева React, поэтому
// прячется, а не удаляется. Класс у неё хэшированный (CSS-модуль внутри бинаря)
// и после обновления пакета сменится — цепляемся за неизменную часть имени плюс
// запасной селектор по title свёрнутого состояния. `!important` обязателен: своё
// правило кнопка держит в другой таблице стилей, и чья окажется позже — не от нас
//
// И тем же правилом убран поиск по проектам на списке проектов: проект у доски
// заведён ровно один — наш, искать среди него нечего. Прячется не сам <input>, а
// его обёртка (`:has(>input[aria-label="Search projects"])`) — иначе от поля
// осталась бы висеть лупа, она лежит в том же контейнере абсолютом. Узел живой:
// значение поля — состояние React, родитель перерисовывается на фильтрах по
// тегам, поэтому только прячем. Зацепка — `aria-label`, а не утилитные классы
//
// Ещё одно правило убирает нижнюю панель доски со ссылками на чужие репозитории
// (Beads Kanban UI, Beads CLI): к работе она отношения не имеет, а место внизу
// вкладки занимает. Узел живой (часть дерева React) — поэтому прячем, а не
// вынимаем. Зацепка — сам тег `footer` плюс его `mt-auto`: подписи или роли у
// панели нет, а тег с классом весит больше одиночных утилит Tailwind
//
// Ещё одно правило убирает верхнюю панель списка проектов — полосу с одной
// шестерёнкой «Settings»: настройки доски (теги и опции PR) нам не нужны, а
// полоса липкая и занимает верх кадра. Прячется вся `nav` целиком, а не её
// внутренний контейнер: у самой полосы своя нижняя граница и фон, и от скрытого
// содержимого осталась бы пустая черта. Узел живой (часть дерева React) —
// поэтому прячем, а не вынимаем. Зацепка — подпись ссылки внутри
// (`aria-label="Settings"`), а не утилитные классы полосы
//
// Последнее правило снимает отступ у строки разделов доски (All/Epics/Tasks/
// Today/Memory/Agents): её обёртка приходит с `px-4 pb-3`, и нижние 12 пикселей
// отодвигают саму доску от вкладок без нужды. Селектор из четырёх утилитных
// классов весит больше одиночных утилит Tailwind, и наши правила дописаны в
// конец их таблицы — `!important` здесь не нужен
//
// И последнее — не про то, что убрать, а про то, как назвать: колонка «Open» у
// нас называется «New». Слово вшито в бинарь, а поменять текст узла руками
// нельзя — заголовок колонки живая часть дерева React, и любая перерисовка
// доски вернёт прежнее. Поэтому подменяем не текст, а его показ: своё слово
// рисует `::after`, чужое гасится нулевым кеглем (сам узел остаётся на месте, и
// React ничего не замечает). Высоту строки задаём явно — от нулевого кегля
// строчный бокс схлопнулся бы и колонка поехала вверх. Зацепиться, кроме
// утилитных классов, не за что: ни роли, ни подписи у заголовка нет, а цвет
// (`text-blue-400`) отличает эту колонку от соседних. Тот же текст дублируется
// в FRAME_CSS (kanban.js) — таблицу стилей доски браузер держит в кэше и на
// перезагрузку получает 304, ответ без нашей дописки
//
// Тем же способом и по тем же причинам переименована колонка «Closed» — у нас
// она «Done». Отличает её от соседних тоже цвет: `text-green-400` из четырёх
// колонок носит только закрытая (остальные — blue/amber/cyan). Дубль в
// FRAME_CSS обязателен и здесь
const EXTRA_CSS = '\nmain>h1.font-heading{display:none}\nmain>p.text-center.text-zinc-400{display:none}\n[role="toolbar"][aria-label="Quick filters"]{display:none}\n[class*="toolbarContainer"],[title="Start feedback mode"]{display:none!important}\n:has(>input[aria-label="Search projects"]){display:none}\nfooter.mt-auto{display:none}\nnav:has(>div>a[aria-label="Settings"]){display:none}\ndiv.flex.justify-center.px-4.pb-3{padding:0}\nh2.font-semibold.text-sm.text-blue-400{font-size:0;line-height:1.25rem}\nh2.font-semibold.text-sm.text-blue-400::after{content:"New";font-size:0.875rem}\nh2.font-semibold.text-sm.text-green-400{font-size:0;line-height:1.25rem}\nh2.font-semibold.text-sm.text-green-400::after{content:"Done";font-size:0.875rem}\n';

function isBoardCss(urlPath) {
    return urlPath.startsWith('/_next/static/css/') && urlPath.endsWith('.css');
}

function binaryPath(root) {
    const name = process.platform === 'win32' ? 'beads-server.exe' : 'beads-server';
    return path.join(root, 'node_modules', 'beads-kanban-ui', 'bin', name);
}

function createRoutes({ root }) {
    const port = Number(process.env.BEADS_PORT ?? 3008);
    const base = `http://127.0.0.1:${port}`;
    const state = { running: false, error: null, projectId: null };

    async function health() {
        try {
            const res = await fetch(`${base}/api/health`);
            return res.ok;
        } catch {
            return false; // никто не слушает — это не ошибка, а «ещё не поднялся»
        }
    }

    async function waitForHealth() {
        const deadline = Date.now() + HEALTH_TIMEOUT_MS;
        while (Date.now() < deadline) {
            if (await health()) return true;
            await new Promise((resolve) => setTimeout(resolve, HEALTH_INTERVAL_MS));
        }
        return false;
    }

    // папка проекта в списке beads-web: путь только со слэшами — обратные
    // косые он не принимает. Повторный запуск ничего не дублирует.
    // id проекта запоминаем в state.projectId: он у нас всего один, и кадр
    // сразу открывает его — без лишнего клика по списку проектов
    async function registerProject() {
        const projectPath = root.replace(/\\/g, '/');
        try {
            const list = await (await fetch(`${base}/api/projects`)).json();
            const existing = Array.isArray(list) && list.find((item) => item.path === projectPath);
            if (existing) {
                state.projectId = existing.id;
                return;
            }
            const created = await (await fetch(`${base}/api/projects`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: path.basename(root), path: projectPath }),
            })).json();
            state.projectId = created?.id ?? null;
        } catch (err) {
            console.error('beads-web: не удалось зарегистрировать проект:', err.message);
        }
    }

    // на порту уже кто-то отвечает: это либо тот же бинарь, переживший наш
    // перезапуск, либо поднятый пользователем руками. Подхватываем его как есть,
    // второго не заводим. id проекта после нашего перезапуска забыт — спрашиваем
    // заново, иначе кадр открылся бы на списке проектов вместо самого проекта
    async function adopt() {
        state.running = await health();
        if (state.running && !state.projectId) await registerProject();
        return state.running;
    }

    async function start() {
        if (!port) return; // BEADS_PORT=0 — доска выключена (headless-прогон)
        state.error = null; // прошлая неудача не должна висеть вечно: пробуем заново

        if (await adopt()) return;

        const bin = binaryPath(root);
        if (!fs.existsSync(bin)) {
            state.error = 'beads-web не установлен: выполните npm install';
            return;
        }

        const child = spawn(bin, [], {
            windowsHide: true,
            detached: true, // отвязан от нас: наш перезапуск его не гасит
            stdio: 'ignore',
            env: { ...process.env, PORT: String(port) },
        });
        child.on('error', (err) => { state.error = `beads-web не запустился: ${err.message}`; });
        child.unref();

        if (await waitForHealth()) {
            state.running = true;
            await registerProject();
        } else if (!state.error) {
            state.error = `beads-web не ответил на порту ${port} за ${HEALTH_TIMEOUT_MS / 1000} с`;
        }
    }

    // Доска поднимается по первому заходу на вкладку, а не при старте сервера.
    // Иначе `node server.js` заводил в системе второй слушающий процесс всегда —
    // даже если Kanban в этот раз не открывали ни разу. Параллельные запросы
    // ждут один и тот же запуск, а не плодят по бинарю на каждый
    let starting = null;

    function ensureStarted() {
        if (!starting) starting = start().finally(() => { starting = null; });
        return starting;
    }

    // ---------- отдача beads-web через наш порт ----------

    // Что из адресов принадлежит доске. Три группы, и все три обязательны:
    // разметку он отдаёт по MOUNT, статику просит от корня (`/_next/...`),
    // свой API зовёт тоже от корня и абсолютными путями — под префиксом он не живёт
    function owns(req, urlPath) {
        if (!port || !state.running) return false;
        if (urlPath === '/') return ownsRoot(req);
        if (urlPath === MOUNT || urlPath.startsWith(MOUNT + '/')) return true;
        if (urlPath.startsWith('/_next/')) return true;
        if (urlPath.startsWith('/api/')) return BEADS_API.has(urlPath.split('/')[2]);
        return false;
    }

    // Отдельный случай — его же ссылка «назад к проектам»: она ведёт на `/`, а это
    // адрес нашей страницы. Поменять её мы не можем — доска собрана без префикса и
    // все свои адреса пишет от корня. Поэтому корень делим не по пути, а по тому,
    // кто спрашивает: клиентский переход Next просит разметку заголовком `RSC`, а
    // перезагрузка самого кадра приходит с `Sec-Fetch-Dest: iframe`. Обычный заход
    // человека на нашу страницу — ни то, ни другое, и он получает index.html.
    // Без этого клик по кнопке грузил в кадр наш же интерфейс вместо списка проектов
    function ownsRoot(req) {
        if (req.method !== 'GET') return false;
        return Boolean(req.headers.rsc) || req.headers['sec-fetch-dest'] === 'iframe';
    }

    // Его собственная навигация (клик по проекту) меняет адрес кадра на путь вида
    // `/project?id=<id>` — уже нашего origin. Такие адреса тоже его, но перечислить их
    // заранее нельзя: маршруты знает только он. Поэтому добираем их по остаточному
    // признаку — GET за путём без расширения, которого у нас на диске нет.
    // Файлы (`/no-such-file.txt`) и наш `/api/*` под это правило не попадают
    function ownsFallback(req, urlPath) {
        if (!port || !state.running) return false;
        if (req.method !== 'GET') return false;
        if (urlPath.startsWith('/api/')) return false;
        return !path.extname(urlPath);
    }

    function proxy(req, res, urlPath) {
        // MOUNT — только наш внешний адрес: внутри у доски это её корень
        const inner = urlPath === MOUNT || urlPath.startsWith(MOUNT + '/')
            ? (urlPath.slice(MOUNT.length) || '/')
            : urlPath;
        const search = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';

        const headers = { ...req.headers, host: `127.0.0.1:${port}` };
        // сжатое тело дописать нечем, а таблицы стилей у нас ходят по локальной петле
        if (isBoardCss(inner)) {
            delete headers['accept-encoding'];
            // и никаких условных запросов: 304 браузер понял бы как «твоя копия
            // годится», а его копия — с прежним набором наших правил. Имя файла
            // доски содержит хэш её собственного содержимого и от правки EXTRA_CSS
            // не меняется, поэтому за свежесть тут отвечаем только мы
            delete headers['if-none-match'];
            delete headers['if-modified-since'];
        }

        const upstream = http.request({
            host: '127.0.0.1',
            port,
            path: inner + search,
            method: req.method,
            headers,
        }, (up) => {
            // единственный ответ, который мы не пропускаем как есть: в конец
            // таблицы стилей дописаны наши правила (EXTRA_CSS). Условные заголовки
            // для неё сняты выше, так что 304 сюда прийти уже не должен — проверка
            // на всякий случай, как и на сжатое тело: дописывать там не к чему
            if (isBoardCss(inner) && up.statusCode === 200 && !up.headers['content-encoding']) {
                const chunks = [];
                up.on('data', (chunk) => chunks.push(chunk));
                up.on('end', () => {
                    const body = Buffer.concat([...chunks, Buffer.from(EXTRA_CSS)]);
                    // заголовки свежести отдаём свои: у Next статика помечена
                    // `immutable` на год, и с ними браузер за файлом больше не
                    // придёт — новое правило в EXTRA_CSS не доехало бы до него
                    // ни после перезапуска сервера, ни после перезагрузки страницы.
                    // etag и last-modified описывают тело доски, а не наше
                    const patched = { ...up.headers, 'content-length': String(body.length), 'cache-control': 'no-cache' };
                    delete patched.etag;
                    delete patched['last-modified'];
                    res.writeHead(200, patched);
                    res.end(body);
                });
                return;
            }
            res.writeHead(up.statusCode, up.headers);
            up.pipe(res); // потоком: у доски есть длинные ответы (слежение за файлами)
        });

        upstream.on('error', (err) => {
            if (res.headersSent) { res.end(); return; }
            res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end(`502 beads-web недоступен: ${err.message}`);
        });

        req.pipe(upstream);
    }

    return {
        routes: {
            // клиент спрашивает, куда смотреть. Живость перепроверяем каждый раз:
            // бинарь мог упасть уже после старта
            '/api/kanban/status': async (req, res) => {
                if (!port) {
                    sendJson(res, { ok: false, disabled: true, error: 'BEADS_PORT=0 — доска выключена в .env' });
                    return;
                }
                // не отвечает — значит либо ещё не поднимали, либо упал: пробуем
                // поднять прямо сейчас. Это единственное место, где он заводится.
                // probe: true — вопрос без просьбы (вкладку не выбирали, а вернули
                // после перезагрузки страницы): живую доску подхватим, мёртвую
                // поднимать не станем, решает человек кнопкой
                const { probe } = await readJson(req);
                if (!await adopt() && !probe) await ensureStarted();
                if (!state.running) {
                    sendJson(res, { ok: false, error: state.error || `beads-web не отвечает на порту ${port}` });
                    return;
                }
                // адрес нашего же origin: только так кадр остаётся доступен Karandash.
                // проект у нас один — открываем его доску сразу, минуя список проектов
                // и лишний клик по карточке. Адрес доски у beads-web — `/project?id=<id>`
                // (страница читает id из query, пути `/project/<id>` у него нет)
                const page = state.projectId ? `/project?id=${state.projectId}` : '/';
                sendJson(res, { ok: true, url: MOUNT + page });
            },
        },
        owns,
        ownsFallback,
        proxy,
    };
}

module.exports = { createRoutes };
