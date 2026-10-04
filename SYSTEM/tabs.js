// Панель вкладок: показывает один вид и подсвечивает активную кнопку.
// Ядро (app.js) переключает вкладку через MissionTabs.show, а сами вкладки
// живут отдельными файлами — PROJECTS/Flow/flow.js, PROJECTS/Kanban/kanban.js.
(function () {
            const viewButtons = [...document.querySelectorAll('.toolbar [data-view]')];
            const flowZoomPanel = document.getElementById('flowZoomPanel');

            // запоминаем последнее открытое место, чтобы после перезагрузки страницы
            // пользователь вернулся туда же. Вкладка пишется своим именем ('flow'),
            // страница кнопки «+» — как 'page:<id>' (её открывает SYSTEM/new-button.js).
            // Пишет значение только переход по вкладке: восстановление не пишет вовсе
            // (см. restored в showView)
            const LAST_VIEW_KEY = 'lastView';

            // куда открываться, когда возвращаться некуда: сохранённого места нет
            // (первый заход) или оно не открывается (вкладку переименовали, скрипт
            // раздела не дошёл). Раньше здесь стояло 'home', и человек при обновлении
            // получал именно ту страницу, на которую и не собирался
            const DEFAULT_VIEW = 'chat';

            // метка на <html>, которую ставит скрипт в <head> (SYSTEM/index.html):
            // пока она стоит, SYSTEM/styles/views.css не рисует ни одной вкладки,
            // чтобы при перезагрузке не мелькнул Home из разметки по умолчанию
            const RESTORED_ATTR = 'data-restored-view';

            // снять метку: вкладка показана, скрывать больше нечего
            function endRestore() {
                document.documentElement.removeAttribute(RESTORED_ATTR);
            }

            function saveLastView(value) {
                // localStorage может быть недоступен (приватный режим) — тогда просто не запоминаем
                try { localStorage.setItem(LAST_VIEW_KEY, value); } catch {}
            }

            function readLastView() {
                try { return localStorage.getItem(LAST_VIEW_KEY); } catch { return null; }
            }

            // показываем один вид, активную кнопку панели помечаем через aria-pressed.
            // restored=true — вкладку не выбирали, её просто вернули после перезагрузки
            // страницы. Разделу это важно знать, если открытие само по себе что-то
            // запускает: восстановление вкладки не должно считаться просьбой пользователя
            function showView(name, restored = false) {
                // страницы кнопки «+» лежат поверх вкладок — их скрываем всегда,
                // в том числе при программном MissionTabs.show из app.js
                window.MissionPages?.hideAll();
                for (const [key, view] of Object.entries(App.VIEWS)) {
                    // раздел, чья разметка не достроилась (свой скрипт не дошёл),
                    // не должен ронять переключение всех вкладок: без узла просто
                    // нечего показывать и нечего включать
                    if (view) view.hidden = key !== name;
                }
                for (const btn of viewButtons) {
                    btn.setAttribute('aria-pressed', String(btn.dataset.view === name));
                }
                if (flowZoomPanel) flowZoomPanel.hidden = name !== 'flow';
                // пока вкладка Sessions скрыта, scrollHeight не считается — лента грузится
                // ещё до открытия вкладки, поэтому довернуть скролл вниз при показе
                if (name === 'chat') App.chatMessages.scrollTop = App.chatMessages.scrollHeight;
                // как и с Sessions: пока telegramView скрыт, scrollHeight не считается —
                // опрос ленты (load, every 5s) мог довинтить скролл ещё при hidden=true,
                // когда scrollHeight/clientHeight были 0. Довинчиваем вручную при показе
                if (name === 'telegram') {
                    const telegramMessages = document.getElementById('telegramMessages');
                    if (telegramMessages) telegramMessages.scrollTop = telegramMessages.scrollHeight;
                }
                if (name === 'flow') MissionFlow.center();
                if (name === 'book') MissionBookTab.show();
                // восстановление — не решение пользователя, поэтому своё значение
                // lastView оно не переписывает. Иначе незнакомое имя вкладки (вкладку
                // переименовали, скрипт раздела не дошёл) молча заменялось бы в
                // localStorage на вкладку по умолчанию, и человек терял бы своё
                // место навсегда, а не до следующей удачной загрузки
                if (!restored) saveLastView(name);
                // вкладка на экране — метку до первой отрисовки можно снимать
                endRestore();
            }

            for (const btn of viewButtons) {
                btn.addEventListener('click', () => showView(btn.dataset.view));
            }

            // при самом первом заходе сохранённого места ещё нет, и при негодном
            // имени возвращаться тоже некуда — в обоих случаях открываем вкладку
            // по умолчанию, а не Home, зашитый в разметку
            const lastView = readLastView() || DEFAULT_VIEW;
            // страницы кнопки «+» приходят с сервера асинхронно, поэтому 'page:<id>'
            // восстанавливает уже сам new-button.js — здесь вкладку не трогаем
            if (lastView.startsWith('page:')) endRestore();
            else showView(App.VIEWS[lastView] ? lastView : DEFAULT_VIEW, true);

            // пункты боковых меню пока только сообщают о нажатии
            for (const nav of document.querySelectorAll('.side-nav')) {
                nav.addEventListener('click', (e) => {
                    const item = e.target.closest('.side-nav__item');
                    if (item) console.log('Section:', item.dataset.session || item.dataset.flow);
                });
            }

    window.MissionTabs = { show: showView, endRestore, LAST_VIEW_KEY, RESTORED_ATTR, saveLastView, readLastView };
})();
