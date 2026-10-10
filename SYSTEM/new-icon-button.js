// Кнопки-заготовки в группе «Actions» тулбара: клиентская половина.
//
// Отличие от SYSTEM/new-button.js (страницы) в том, что здесь не создаётся
// ничего на диске: кнопка-заготовка — это иконка и название в тулбаре, под
// которые позже предстоит написать логику. Своей вкладки у неё нет и по
// клику ничего не происходит — намеренно: иначе заглушка делала бы вид, что
// уже работает.
//
// Список живёт на сервере (SYSTEM/toolbar-buttons-server.js), поэтому кнопки
// переживают перезагрузку. Восстановление — после DOMContentLoaded, по той же
// причине, что и в new-button.js: window.App (SYSTEM/app.js) грузится модулем
// и к моменту выполнения этого файла может быть ещё не определён.
(function () {
    const addButton = document.getElementById('newIconButton');
    if (!addButton) return;
    const group = addButton.closest('.btn-group');
    if (!group) return;

    // Иконка новой кнопки рисуется сразу, а не пустым кружком: заготовка должна
    // выглядеть как кнопка, а не как дыра в тулбаре. Каталог иконок — общий с
    // меню «+» (SYSTEM/toolbar-menu.js выставляет window.ToolbarIcons), своей
    // копии здесь не заводим: правка одной разъехалась бы с другой.
    const DEFAULT_ICON = 'star';

    function addIconButton({ id, name, icon }) {
        const btn = addButton.cloneNode(true);
        btn.id = `toolbarButton${id}`;
        btn.title = name;
        btn.setAttribute('aria-label', name);
        btn.setAttribute('aria-pressed', 'false');
        btn.removeAttribute('data-new-page');
        btn.dataset.toolbarButtonId = String(id);
        // Меню «+» (SYSTEM/toolbar-menu.js) удаляет только то, что помечено
        // removable: встроенные вкладки удалять нельзя, заготовку — можно.
        // Без этой метки кнопка удаления в меню осталась бы задизейбленной.
        btn.dataset.removable = 'true';
        // рисунок кладёт общий каталог меню «+»: у клона «+» своя фигура, и без
        // подмены все заготовки выглядели бы одинаковыми плюсами
        window.ToolbarIcons?.apply(btn, icon || DEFAULT_ICON);
        btn.addEventListener('click', () => {
            // заглушка: логики под кнопку ещё нет. Пишем в консоль, чтобы клик не
            // выглядел зависшим — иначе непонятно, отработала кнопка или нет.
            console.log(`Кнопка «${name}»: логика ещё не написана`);
        });
        group.insertBefore(btn, addButton);
    }

    async function createButton() {
        // Название по счёту среди уже заведённых: «Button N». Считаем по DOM,
        // а не по последнему id — после удаления кнопок счёт из базы поехал бы.
        const n = group.querySelectorAll('[data-toolbar-button-id]').length + 1;
        const button = await App.api('/api/toolbar/buttons/create', { name: `Button ${n}`, icon: DEFAULT_ICON });
        addIconButton(button);
    }

    addButton.addEventListener('click', createButton);

    document.addEventListener('DOMContentLoaded', function () {
        window.MissionBoot?.task('toolbar-buttons', restore);
    });

    async function restore() {
        const { buttons = [] } = await App.api('/api/toolbar/buttons', {});
        for (const button of buttons) addIconButton(button);
    }
})();