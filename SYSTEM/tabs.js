// Панель вкладок: показывает один вид и подсвечивает активную кнопку.
// Ядро (app.js) переключает вкладку через MissionTabs.show, а сами вкладки
// живут отдельными файлами — PROJECTS/Graph/graph.js, PROJECTS/Flow/flow.js,
// PROJECTS/Kanban/kanban.js.
(function () {
            const viewButtons = [...document.querySelectorAll('.toolbar [data-view]')];
            const flowZoomPanel = document.getElementById('flowZoomPanel');

            // показываем один вид, активную кнопку панели помечаем через aria-pressed
            function showView(name) {
                for (const [key, view] of Object.entries(App.VIEWS)) {
                    view.hidden = key !== name;
                }
                for (const btn of viewButtons) {
                    btn.setAttribute('aria-pressed', String(btn.dataset.view === name));
                }
                if (flowZoomPanel) flowZoomPanel.hidden = name !== 'flow';
                // пока chatView скрыт, scrollHeight не считается — лента грузится
                // ещё до открытия вкладки, поэтому довернуть скролл вниз при показе
                if (name === 'chat') App.chatMessages.scrollTop = App.chatMessages.scrollHeight;
                if (name === 'graph') MissionGraph.show();
                if (name === 'flow') MissionFlow.center();
                if (name === 'book') MissionBookTab.show();
            }

            // запоминаем последнюю открытую вкладку, чтобы при следующем заходе
            // открывалась она же, а не всегда Home
            const LAST_VIEW_KEY = 'lastView';

            for (const btn of viewButtons) {
                btn.addEventListener('click', () => {
                    showView(btn.dataset.view);
                    localStorage.setItem(LAST_VIEW_KEY, btn.dataset.view);
                });
            }

            // при самом первом заходе сохранённой вкладки ещё нет — открываем Projects,
            // а не Home, зашитый в разметке по умолчанию
            const lastView = localStorage.getItem(LAST_VIEW_KEY) || 'chat';
            if (lastView !== 'home' && App.VIEWS[lastView]) showView(lastView);

            // пункты боковых меню пока только сообщают о нажатии
            for (const nav of document.querySelectorAll('.side-nav')) {
                nav.addEventListener('click', (e) => {
                    const item = e.target.closest('.side-nav__item');
                    if (item) console.log('Раздел:', item.dataset.session || item.dataset.flow);
                });
            }

    window.MissionTabs = { show: showView };
})();
