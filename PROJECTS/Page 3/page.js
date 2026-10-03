// Страница «New projects»: простой список названий провайдеров (CLI-агентов)
// с сайта https://openrouter.ai/apps/category/coding/cli-agent.
//
// Сам список и его проверку на сайте держит SYSTEM/cli-agents.js: тот же список
// стоит уровнем CLI в каскаде выбора модели (SYSTEM/model-cascade.js), а тянуть
// его отсюда нельзя — страница грузится динамическим import и может быть ещё не
// открыта. Здесь только рисуем: список виден сразу, кнопка в тулбаре секции
// (#generatedPageButton19) проверяет, не изменился ли он на сайте.
//
// Файл грузит SYSTEM/new-button.js динамическим import при первом открытии
// страницы; signal снимает подписки при пересборке.
import { cliAgentNames, loadCliAgents, onCliAgents } from '../../SYSTEM/cli-agents.js';

const SOURCE_URL = 'https://openrouter.ai/apps/category/coding/cli-agent';

export default function build(page, { signal }) {
    let names = cliAgentNames();

    page.classList.add('providers');
    page.innerHTML = `
        <section class="providers__section">
            <header class="providers__head">
                <h2 class="providers__title">New projects</h2>
                <div class="toolbar btn-group" role="toolbar" aria-label="New projects">
                    <button type="button" class="icon-button btn-group__btn" id="generatedPageButton19"
                            aria-label="Check for updates" title="Проверить список на OpenRouter">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                             stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                            <polyline points="21 12 21 21 12 21"></polyline>
                            <polyline points="3 12 3 3 12 3"></polyline>
                            <line x1="15" y1="9" x2="9" y2="15"></line>
                            <line x1="9" y1="9" x2="15" y2="15"></line>
                        </svg>
                    </button>
                </div>
            </header>
            <ul class="providers__list" id="providersList"></ul>
            <p class="providers__meta" id="providersMeta"></p>
        </section>
    `;

    const btn = page.querySelector('#generatedPageButton19');
    const list = page.querySelector('#providersList');
    const meta = page.querySelector('#providersMeta');

    // Подпись под списком: всего имён и откуда они. После проверки дописываем,
    // чем она кончилась — на сайте не изменилось, список прежний или новый
    function metaLine(note) {
        meta.textContent = `Всего: ${names.length} · ${note || SOURCE_URL}`;
    }

    // Строка списка: название слева, кнопка подключения справа. Кнопка пока
    // ничего не делает (заглушка под подключение выбранного CLI), поэтому у неё
    // нет ни обработчика, ни состояния aria-pressed — вид и наведение те же, что
    // у кнопок в тулбаре (класс .icon-button из SYSTEM/styles/views.css)
    function item(name) {
        const li = document.createElement('li');
        li.className = 'providers__item';
        const label = document.createElement('span');
        label.className = 'providers__name';
        label.textContent = name;
        const connect = document.createElement('button');
        connect.type = 'button';
        connect.className = 'icon-button providers__connect';
        connect.setAttribute('aria-label', `Connect ${name}`);
        connect.title = 'Connect';
        connect.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" '
            + 'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" '
            + 'aria-hidden="true"><path d="M9 18V5l12-2v13"></path>'
            + '<circle cx="6" cy="18" r="3"></circle><path d="M6 14h12v-4"></path></svg>';
        li.append(label, connect);
        return li;
    }

    function render() {
        list.replaceChildren(...names.map(item));
        metaLine();
    }

    render();

    // Проверка на сайте: раз в час сервер отвечает «не изменилось» без
    // скачивания тела, а если список другой — он уже записан на клиенте, и
    // подписка выше перерисует страницу
    async function load() {
        const result = await loadCliAgents();
        names = result.names;
        if (result.error) metaLine(`${result.error}`);
        else if (result.skipped) return;
        else metaLine(result.changed ? 'список новый' : 'на сайте не изменилось');
    }

    btn.addEventListener('click', () => {
        btn.setAttribute('aria-pressed', 'true');
        setTimeout(() => btn.setAttribute('aria-pressed', 'false'), 150);
        load();
    }, { signal });

    // Список обновился в другом месте (например, кнопкой проверки или по часу) —
    // перерисовать наш. Подписка своя, с отменой по signal, как у обработчика
    // кнопки: пересборка страницы не должна оставлять слушателя
    const stop = onCliAgents((fresh) => {
        if (fresh.join('\n') === names.join('\n')) return;
        names = fresh;
        render();
    });
    signal.addEventListener('abort', stop);
}
