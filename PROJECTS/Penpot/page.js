// Содержимое этой страницы. Файл заводит /api/pages/create, а грузит его
// динамическим import при первом открытии страницы SYSTEM/new-button.js.
// page — её <main>, panel — слот в топбаре под свою панель (пустой не
// показывается), signal — снимается при пересборке страницы: подписывайте им
// слушателей и потоки, чтобы от прошлой сборки ничего не оставалось.
// Пример со всем сразу — PROJECTS/Feed/page.js.
//
// Страница показывает канвас Penpot (self-hosted, docker compose в
// deploy/penpot/docker-compose.yaml) в iframe. У фронтенда Penpot снят
// X-Frame-Options (nginx-security-headers.conf), поэтому вставка работает.
// Вход в Penpot — сессия браузера; сервисный аккаунт агента (логин и пароль в
// .env, PENPOT_EMAIL/PENPOT_PASSWORD) для этого не нужен и используется только
// агентами через API и MCP. Свой аккаунт в этой команде состоит редактором
// (TOOLS/penpot-mcp/grant-access.mjs), поэтому канвас открывается сразу: ни
// приглашения, ни письма, ни одобрения — раньше здесь был текст Penpot «You
// don't have access to this file», потому что аккаунт был вне команды.
const PENPOT_URL = 'http://localhost:9001';

// Адрес файла в Penpot. У Penpot он живёт в хеше роута (#/workspace?...), и
// параметры там такие: team-id — команда, file-id — файл, page-id — страница
// внутри файла, layout — что открыть: layers (дерево слоёв) или layout (сам
// макет). Это файл сервисного аккаунта karandash@openkarandash.local из
// проекта OpenKarandash: он выдан на редактора, поэтому через него же агент
// работает с макетом и по API, и по MCP (ключи в .env), и плагин в этой
// вкладке числится за тем же аккаунтом.
const FILE = {
    'team-id': '7d2d8782-fb6f-8082-8008-bbb4684852a3',
    'file-id': '7d2d8782-fb6f-8082-8008-bbb48876aa60',
    'page-id': '7d2d8782-fb6f-8082-8008-bbb48876d03b',
    layout: 'layout',
};

function workspaceUrl(file) {
    const params = new URLSearchParams(file).toString();
    return `${PENPOT_URL}/#/workspace?${params}`;
}

export default function build(page) {
    const url = workspaceUrl(FILE);

    // Канвас на всю страницу: свой <iframe> без рамки, шириной и высотой по
    // остатку под топбаром. Подпись с адресом Penpot лежит под кадром и
    // убирается, как только тот загрузился
    page.classList.add('penpot-frame');
    page.innerHTML = `
        <iframe class="penpot-frame__embed" id="penpotFrame" title="Penpot"
                src="${url}" allow="clipboard-read; clipboard-write"></iframe>
        <p class="penpot-frame__hint" id="penpotHint">Penpot: ${url}</p>
    `;

    const frame = page.querySelector('#penpotFrame');

    // Подпись показывает, какой файл открыт, и служит запасным вариантом, если
    // Penpot не поднят (тогда в кадре будет его страница входа).
    const hint = page.querySelector('#penpotHint');

    frame.addEventListener('load', () => {
        hint.remove();
    });
}