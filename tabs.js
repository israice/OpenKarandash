// Панель вкладок: показывает один вид и подсвечивает активную кнопку.
// Ядро (app.js) переключает вкладку через MissionTabs.show, а сами вкладки
// живут отдельными файлами — graph.js, flow.js, kanban.js.
(function () {
            const viewButtons = [...document.querySelectorAll('.toolbar [data-view]')];

            // показываем один вид, активную кнопку панели помечаем через aria-pressed
            function showView(name) {
                for (const [key, view] of Object.entries(App.VIEWS)) {
                    view.hidden = key !== name;
                }
                for (const btn of viewButtons) {
                    btn.setAttribute('aria-pressed', String(btn.dataset.view === name));
                }
                // пока chatView скрыт, scrollHeight не считается — лента грузится
                // ещё до открытия вкладки, поэтому довернуть скролл вниз при показе
                if (name === 'chat') App.chatMessages.scrollTop = App.chatMessages.scrollHeight;
                if (name === 'graph') MissionGraph.show();
                if (name === 'flow') MissionFlow.center();
            }

            for (const btn of viewButtons) {
                btn.addEventListener('click', () => {
                    if (btn.id === 'chatButton') App.deselectSession();
                    showView(btn.dataset.view);
                });
            }

            // пункты боковых меню пока только сообщают о нажатии
            for (const nav of document.querySelectorAll('.side-nav')) {
                nav.addEventListener('click', (e) => {
                    const item = e.target.closest('.side-nav__item');
                    if (item) console.log('Раздел:', item.dataset.session || item.dataset.flow);
                });
            }

    window.MissionTabs = { show: showView };
})();
