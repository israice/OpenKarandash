// Предпросмотр ветки исполнителя: страница `/branch/<ветка>/` отдаёт клиент
// из рабочей копии этой ветки, а всё API остаётся главным.
//
// Почему так, а не второй сервер: порт один и при занятом сервер выходит
// (DOCS/decisions/001), а база сессий лежит в папке запуска — второй сервер
// в ветке расколол бы ленту на отдельные базы. Клиент же весь ссылается на
// свои файлы относительными путями, а на сервер — абсолютными `/api/...`,
// поэтому смена корня статики сама по себе даёт ветку живьём с общей лентой.
// Подробности и чем платим — DOCS/decisions/042.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { sendJson, escapeHtml } = require('./http.js');

const PREFIX = '/branch/';

// список веток запоминаем на несколько секунд: страница предпросмотра тянет
// десятки файлов, и `git worktree list` на каждый из них (синхронный, ~0,2 с
// на /mnt/c) держал бы весь сервер. Новая ветка появится в пределах срока
const LIST_TTL_MS = 5000;
let cached = { at: 0, root: null, list: [] };

function listBranches(root) {
    const now = Date.now();
    if (cached.root === root && now - cached.at < LIST_TTL_MS) return cached.list;
    cached = { at: now, root, list: readBranches(root) };
    return cached.list;
}

// живые рабочие копии веток. Берём у самого git, а не из своей таблицы:
// ветку заводит помощник у себя, и знать о ней заранее мы не можем
function readBranches(root) {
    let out;
    try {
        out = execFileSync('git', ['worktree', 'list', '--porcelain'], {
            cwd: root,
            encoding: 'utf8',
            timeout: 10_000,
        });
    } catch {
        return []; // не репозиторий или git недоступен — предпросмотра просто нет
    }

    const found = [];
    let current = null;

    for (const line of out.split('\n')) {
        const text = line.trimEnd();
        if (text.startsWith('worktree ')) {
            current = { dir: text.slice('worktree '.length), branch: null };
            continue;
        }
        if (!current) continue;
        if (text.startsWith('branch refs/heads/')) current.branch = text.slice('branch refs/heads/'.length);
        else if (text === '') {
            found.push(current);
            current = null;
        }
    }
    if (current) found.push(current);

    // пометке prunable не верим: git ставит её и живой копии, заведённой из
    // другой системы (сервер на Windows видит копию из WSL по пути /mnt/c/…
    // и считает её удалённой). Живость решает наличие файлов по пути,
    // переведённому в форму своей системы
    return found
        .map((w) => ({ ...w, dir: localPath(w.dir) }))
        // главную копию показывать незачем — она и так открыта по «/»
        .filter((w) => w.branch && !samePath(w.dir, root))
        .filter((w) => fs.existsSync(path.join(w.dir, 'SYSTEM', 'index.html')))
        .map((w) => ({ branch: w.branch, dir: path.resolve(w.dir) }));
}

// путь рабочей копии в форме своей системы: git пишет его так, как видела
// система, которая копию заводила. /mnt/c/x ↔ C:/x
function localPath(dir) {
    if (process.platform === 'win32') {
        const m = dir.match(/^\/mnt\/([a-z])\/(.*)$/i);
        return m ? `${m[1].toUpperCase()}:/${m[2]}` : dir;
    }
    const m = dir.match(/^([a-z]):[\\/](.*)$/i);
    return m ? `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}` : dir;
}

function samePath(a, b) {
    const norm = (p) => path.resolve(p).replace(/[\\/]+$/, '');
    return process.platform === 'win32'
        ? norm(a).toLowerCase() === norm(b).toLowerCase()
        : norm(a) === norm(b);
}

// `/branch/<ветка>/<путь>` → в какой копии и какой файл искать.
// Имя ветки сверяем со списком живых копий, а не режем адрес на сегменты:
// в имени ветки бывает слэш, и заодно ни один чужой путь сюда не пролезет
function resolveRequest(root, urlPath) {
    if (!urlPath.startsWith(PREFIX)) return null;
    const rest = urlPath.slice(PREFIX.length);

    for (const { branch, dir } of listBranches(root)) {
        // без завершающего слэша браузер считал бы имя ветки файлом и искал
        // соседей на уровень выше — все относительные пути клиента сломались бы
        if (rest === branch) return { branch, dir, redirect: `${PREFIX}${branch}/` };
        if (!rest.startsWith(`${branch}/`)) continue;

        const tail = rest.slice(branch.length + 1);
        const asked = tail === '' ? 'SYSTEM/index.html' : tail;

        // зависимости в git не лежат, и в копии ветки их нет: htmx страница тянет
        // относительным путём, и без этой поблажки предпросмотр остался бы без него.
        // Берём их из главной копии — версии всё равно пинятся в package.json
        const base = asked.startsWith('node_modules/') ? path.resolve(root) : dir;

        const file = path.join(base, asked);
        // за пределы копии не выпускаем — та же защита, что у главной статики
        if (!file.startsWith(base + path.sep)) return { branch, dir, forbidden: true };
        return { branch, dir, file };
    }

    return { unknown: rest };
}

// полоска поверх страницы: без неё предпросмотр ветки визуально неотличим
// от главной копии, и проверяющий решит, что смотрит уже слитую правку
function banner(branch) {
    return `
<div style="position:fixed;left:0;right:0;bottom:0;z-index:2147483647;
            padding:4px 10px;font:12px/1.4 system-ui,sans-serif;
            background:#7a4b00;color:#fff;text-align:center;pointer-events:none">
    Предпросмотр ветки <b>${escapeHtml(branch)}</b> — интерфейс из её копии, данные и сервер общие
</div>`;
}

// отдача предпросмотра целиком: адрес → ответ. Вернёт false, если адрес не наш,
// и тогда сервер обслуживает его обычной статикой
function handle(res, urlPath, { root, mime, renderHtml }) {
    const preview = resolveRequest(root, urlPath);
    if (!preview) return false;

    if (preview.redirect) {
        res.writeHead(302, { Location: preview.redirect }).end();
        return true;
    }
    if (preview.forbidden || preview.unknown !== undefined) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
            .end('404 Not Found: no such branch checkout');
        return true;
    }

    fs.readFile(preview.file, (err, data) => {
        if (err) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 Not Found');
            return;
        }
        const ext = path.extname(preview.file).toLowerCase();
        const body = ext === '.html'
            ? Buffer.from(renderHtml(data.toString('utf8'), banner(preview.branch)), 'utf8')
            : data;

        res.writeHead(200, {
            'Content-Type': mime[ext] || 'application/octet-stream',
            'Cache-Control': 'no-store',
        });
        res.end(body);
    });
    return true;
}

function createRoutes({ root }) {
    return {
        '/api/branches': (req, res) => {
            sendJson(res, {
                ok: true,
                branches: listBranches(root).map(({ branch, dir }) => ({
                    branch,
                    dir,
                    url: `${PREFIX}${branch}/`,
                })),
            });
        },
    };
}

module.exports = { PREFIX, listBranches, resolveRequest, banner, handle, createRoutes };
