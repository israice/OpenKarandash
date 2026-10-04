// Список провайдеров (CLI-агентов) с сайта OpenRouter для вкладки «New projects»
// на странице Page 3. Список приходит не из нашего кода, а с чужого сайта, и
// меняется там без нашего ведома, поэтому здесь три правила:
//
//   1. Сайт не дёргаем лишний раз. Снимок лежит в DATA/openrouter-cli-agents.json,
//      и пока он свежий (TTL), мы отдаём его вообще без сети.
//   2. Когда обновление всё-таки нужно, сначала спрашиваем условным запросом
//      (If-None-Match / If-Modified-Since). Ответ 304 означает «список не поменялся» —
//      тело не качаем, разбор не делаем.
//   3. Свой список заменяем только если он действительно отличается от того, что
//      лежит в снимке: иначе в DATA продолжает лежать старый список с новой
//      датой проверки, и по дате нельзя понять, что содержимое другое.
//
// Модуль у страницы свой — как page.js/page.css, только серверная половина.

const fs = require('fs');
const path = require('path');
const { readJson, sendJson } = require('../../SYSTEM/core/http.js');

const SOURCE_URL = 'https://openrouter.ai/apps/category/coding/cli-agent';
const CACHE_FILE = 'openrouter-cli-agents.json';
// как часто мы вообще готовы сходить на сайт. Список там меняется раз в дни,
// а страницу открывают часто — с TTL в 30 минут сайт увидит не больше двух
// запросов в час, и почти все они закончатся 304-м без тела
const TTL_MS = 30 * 60 * 1000;
const TIMEOUT_MS = 15_000;
// Разбор страницы OpenRouter: в <head> лежит микроразметка
// <script type="application/ld+json"> с типом ItemList, где itemListElement —
// [{position, name, item}] в порядке выдачи сайта. Это единственное место, где
// список отдан целиком и без оформления, поэтому разбираем именно его, а не
// видимый текст карточек (тот меняется от вёрстки, этот — от данных).
function parseApps(html) {
    const scripts = html.match(/<script type="application\/ld\+json">[\s\S]*?<\/script>/g) || [];
    let best = [];
    for (const raw of scripts) {
        const body = raw.replace(/^<script[^>]*>/, '').replace(/<\/script>$/, '');
        let data;
        try {
            data = JSON.parse(body);
        } catch {
            continue; // не разобрался — берём следующий скрипт
        }
        for (const list of (Array.isArray(data) ? data : [data])) {
            // itemListElement есть и у хлебных крошек (BreadcrumbList), поэтому
            // берём только явный ItemList и из всех — самый длинный: кроме
            // списка приложений ItemList на этой странице не встречается
            if (list?.['@type'] !== 'ItemList' || !Array.isArray(list.itemListElement)) continue;
            const apps = [];
            for (const item of list.itemListElement) {
                const name = String(item?.name || '').trim();
                if (!name) continue;
                // item — абсолютная ссылка на карточку приложения; у части
                // приложений это /apps/url/<encoded>, но нам важна сама ссылка
                apps.push({
                    position: Number(item.position) || apps.length + 1,
                    name,
                    url: String(item.item || '').trim(),
                });
            }
            if (apps.length > best.length) best = apps;
        }
    }
    return best;
}

// списки сравниваем по содержимому, а не по JSON-строкам: перестановка строк
// без изменения состава — тоже изменение, его видно и человеку, и нам
function sameList(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((app, i) => (
        app.position === b[i].position && app.name === b[i].name && app.url === b[i].url
    ));
}

function readCache(file) {
    try {
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        return Array.isArray(data.apps) ? data : null;
    } catch {
        return null; // снимка ещё нет или он битый — пойдём на сайт
    }
}
function createRoutes({ root }) {
    const cachePath = path.join(root, 'DATA', CACHE_FILE);

    function load() {
        return readCache(cachePath) || { apps: [], etag: '', lastModified: '', checkedAt: 0 };
    }

    function save(next) {
        try {
            fs.mkdirSync(path.dirname(cachePath), { recursive: true });
            fs.writeFileSync(cachePath, JSON.stringify(next, null, 2), 'utf8');
        } catch { /* DATA может быть недоступна — список тогда живёт только в ответе */ }
    }

    // Сходим на сайт и возвращаем список. refresh=true — снимок устарел (или
    // человек попросил руками), иначе берём из снимка.
    //
    // Что происходит при обновлении:
    //   304                              → тело не качаем, снимок прежний,
    //                                       меняется только checkedAt (дата проверки)
    //   200 и список отличается от нашего → пишем новый снимок (changed: true)
    //   200 и список тот же              → старый снимок не трогаем (changed: false),
    //                                       обновляя только отметку времени проверки
    //   сеть/разбор не удались            → отдаём что есть, страница не остаётся пустой
    async function fetchApps(cache, { force } = {}) {
        if (!force && cache.apps.length && Date.now() - cache.checkedAt < TTL_MS) {
            return { apps: cache.apps, changed: false, source: 'cache', checkedAt: cache.checkedAt };
        }

        const headers = { 'user-agent': 'OpenKarandash/1.0 (+local)', accept: 'text/html' };
        if (cache.etag) headers['if-none-match'] = cache.etag;
        if (cache.lastModified) headers['if-modified-since'] = cache.lastModified;

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
        let response;
        let html = '';
        try {
            response = await fetch(SOURCE_URL, { headers, signal: controller.signal });
            if (response.status !== 304) html = await response.text();
        } finally {
            clearTimeout(timer);
        }

        const checkedAt = Date.now();
        const meta = {
            etag: response?.headers?.get('etag') || cache.etag,
            lastModified: response?.headers?.get('last-modified') || cache.lastModified,
            checkedAt,
        };

        if (response && response.status === 304) {
            const next = { ...cache, ...meta, apps: cache.apps };
            save(next);
            return { apps: next.apps, changed: false, source: 'not-modified', checkedAt };
        }
        if (!response || !response.ok) {
            return {
                apps: cache.apps,
                changed: false,
                source: 'stale',
                checkedAt: cache.checkedAt,
                error: `OpenRouter: ${response ? `HTTP ${response.status}` : 'сеть недоступна'}`,
            };
        }

        const apps = parseApps(html);
        if (!apps.length) {
            return {
                apps: cache.apps,
                changed: false,
                source: 'stale',
                checkedAt: cache.checkedAt,
                error: 'OpenRouter: список на странице не найден',
            };
        }
        if (sameList(apps, cache.apps)) {
            // список не отличается от нашего — не заменяем его: иначе в DATA
            // продолжит лежать то же содержимое с новой датой, и по дате
            // нельзя будет понять, что список всё-таки менялся
            const next = { ...cache, ...meta, apps: cache.apps };
            save(next);
            return { apps: next.apps, changed: false, source: 'same', checkedAt };
        }
        const next = { source: SOURCE_URL, ...meta, apps };
        save(next);
        return { apps, changed: true, source: 'updated', checkedAt };
    }

    return {
        // POST /api/openrouter/cli-agents  { refresh: true } — обновить принудительно
        '/api/openrouter/cli-agents': async (req, res) => {
            const body = await readJson(req);
            const result = await fetchApps(load(), { force: body.refresh === true });
            sendJson(res, {
                ok: !result.error || result.apps.length > 0,
                apps: result.apps,
                source: result.source,
                changed: result.changed,
                checkedAt: result.checkedAt,
                url: SOURCE_URL,
                ...(result.error ? { error: result.error } : {}),
            });
        },
    };
}

module.exports = { createRoutes, parseApps, sameList };