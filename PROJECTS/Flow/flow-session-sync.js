// Выпадающий список сессий слева в тулбаре Flow (см. #flowSessionSelect в SYSTEM/index.html):
// строит граф нод текущего канваса из сообщений выбранной сессии (SYSTEM/app.js). Сама
// сборка (белый текст — цепочка вправо, серый текст шагов — цепочка вниз под ним)
// живёт в PROJECTS/Flow/flow.js, здесь только сбор данных и вызов MissionFlow.buildFromSession.
(function () {
    const select = document.getElementById('flowSessionSelect');
    if (!select) return;

    function activeFlow() {
        const activeItem = document.querySelector('#flowNav .side-nav__item--active');
        return activeItem ? activeItem.dataset.flow : 'New';
    }

    async function syncFromSession(sessionId) {
        const { messages = [] } = await App.api('/api/sessions/messages', { id: sessionId });
        MissionFlow.buildFromSession(activeFlow(), messages);
    }

    // список перечитывается при каждом открытии, чтобы не показывать устаревшее
    select.addEventListener('mousedown', async () => {
        const { sessions = [] } = await App.api('/api/sessions');
        const current = select.value;
        select.innerHTML = '<option value="">Сессия…</option>';
        for (const s of sessions) {
            const option = document.createElement('option');
            option.value = s.id;
            option.textContent = s.title;
            select.append(option);
        }
        select.value = current;
    });
    select.addEventListener('change', () => {
        if (select.value) syncFromSession(select.value);
    });
})();
