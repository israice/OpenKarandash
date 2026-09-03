// Панель вкладок: показывает один вид и подсвечивает активную кнопку.
// Ядро (app.js) переключает вкладку через MissionTabs.show, а сами вкладки
// живут отдельными файлами — PROJECTS/Graph/graph.js, PROJECTS/Flow/flow.js,
// PROJECTS/Kanban/kanban.js.
(function () {
            const viewButtons = [...document.querySelectorAll('.toolbar [data-view]')];
            const flowZoomPanel = document.getElementById('flowZoomPanel');

            // запоминаем последнее открытое место, чтобы после перезагрузки страницы
            // пользователь вернулся туда же. Вкладка пишется своим именем ('graph'),
            // страница кнопки «+» — как 'page:<id>' (её открывает SYSTEM/new-button.js)
            const LAST_VIEW_KEY = 'lastView';

            function saveLastView(value) {
                // localStorage может быть недоступен (приватный режим) — тогда просто не запоминаем
                try { localStorage.setItem(LAST_VIEW_KEY, value); } catch {}
            }

            function readLastView() {
                try { return localStorage.getItem(LAST_VIEW_KEY); } catch { return null; }
            }

            // показываем один вид, активную кнопку панели помечаем через aria-pressed
            function showView(name) {
                // страницы кнопки «+» лежат поверх вкладок — их скрываем всегда,
                // в том числе при программном MissionTabs.show из app.js
                window.MissionPages?.hideAll();
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
                saveLastView(name);
            }

            for (const btn of viewButtons) {
                btn.addEventListener('click', () => showView(btn.dataset.view));
            }

            // при самом первом заходе сохранённого места ещё нет — открываем Projects,
            // а не Home, зашитый в разметке по умолчанию
            const lastView = readLastView() || 'chat';
            // страницы кнопки «+» приходят с сервера асинхронно, поэтому 'page:<id>'
            // восстанавливает уже сам new-button.js — здесь вкладку не трогаем
            if (!lastView.startsWith('page:')) showView(App.VIEWS[lastView] ? lastView : 'home');

            // пункты боковых меню пока только сообщают о нажатии
            for (const nav of document.querySelectorAll('.side-nav')) {
                nav.addEventListener('click', (e) => {
                    const item = e.target.closest('.side-nav__item');
                    if (item) console.log('Section:', item.dataset.session || item.dataset.flow);
                });
            }

    window.MissionTabs = { show: showView, LAST_VIEW_KEY, saveLastView, readLastView };
})();
