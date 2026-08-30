// Стрелки ←/→ панели Sessions: переключают список между Tasks и PROJECTS.
// PROJECTS — 7 разделов интерфейса: 5 кнопок тулбара (Graph/Flow/Kanban/Telegram/Home)
// плюс Edit и Settings; клик по пункту нажимает настоящую кнопку раздела.
(function () {
    const prev = document.getElementById('sessionsPrev');
    const next = document.getElementById('sessionsNext');
    const title = document.getElementById('sessionsPanelTitle');
    const taskList = document.getElementById('sessionList');
    const newBtn = document.getElementById('sessionNew');
    const resetBtn = document.getElementById('sessionReset');
    if (!prev || !next || !title || !taskList) return;

    const PROJECT_SOURCE_IDS = [
        'graphButton', 'flowButton', 'kanbanButton', 'chatButton', 'homeButton',
        'editModeButton', 'settingsButton',
    ];

    // короткое описание каждого раздела для карточки — по одному на кнопку тулбара
    const PROJECT_DESCRIPTIONS = {
        graphButton: 'Карта проекта: файлы, функции и связи между ними',
        flowButton: 'Диаграмма потока выполнения проекта',
        kanbanButton: 'Доска задач в колонках',
        chatButton: 'Чат с ассистентом и список сессий',
        homeButton: 'Главный экран, общий обзор проекта',
        editModeButton: 'Режим редактирования интерфейса',
        settingsButton: 'Настройки приложения и провайдеров',
    };

    let projectList = null;

    // данных о реальном создании/версии карточек пока нет — генерируем правдоподобные
    // один раз за загрузку страницы, чтобы карточки не прыгали при перерисовке
    function fakeCardMeta() {
        const daysAgo = Math.floor(Math.random() * 60);
        const created = new Date(Date.now() - daysAgo * 86400000);
        const date = created.toLocaleDateString('ru-RU');
        const time = created.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
        const version = `v0.${Math.floor(Math.random() * 9) + 1}.${Math.floor(Math.random() * 20)}`;
        return `${date} ${time} · ${version}`;
    }

    // строим список лениво: editModeButton/settingsButton существуют в DOM
    // к моменту первого клика, но не обязательно раньше
    function buildProjectList() {
        const ul = document.createElement('ul');
        ul.className = 'session-list project-cards';
        ul.hidden = true;
        for (const id of PROJECT_SOURCE_IDS) {
            const source = document.getElementById(id);
            if (!source) continue;
            const label = source.title || source.getAttribute('aria-label') || '';
            const item = document.createElement('li');
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'project-card';
            btn.title = label;
            btn.addEventListener('click', () => source.click());
            const icon = document.createElement('span');
            icon.className = 'project-card__icon';
            icon.innerHTML = source.innerHTML;
            const body = document.createElement('span');
            body.className = 'project-card__body';
            const text = document.createElement('span');
            text.className = 'project-card__label';
            text.textContent = label;
            const desc = document.createElement('span');
            desc.className = 'project-card__desc';
            desc.textContent = PROJECT_DESCRIPTIONS[id] || '';
            const meta = document.createElement('span');
            meta.className = 'project-card__meta';
            meta.textContent = fakeCardMeta();
            body.append(text, desc, meta);
            btn.append(icon, body);
            item.append(btn);
            ul.append(item);
        }
        taskList.after(ul);
        return ul;
    }

    function showProjects() {
        if (!projectList) projectList = buildProjectList();
        taskList.hidden = true;
        projectList.hidden = false;
        title.textContent = 'PROJECTS';
        prev.classList.remove('side-nav__arrow--active');
        prev.disabled = true;
        next.classList.add('side-nav__arrow--active');
        next.disabled = false;
        if (newBtn) newBtn.hidden = true;
        if (resetBtn) resetBtn.hidden = true;
    }

    function showTasks() {
        if (projectList) projectList.hidden = true;
        taskList.hidden = false;
        title.textContent = 'Tasks';
        next.classList.remove('side-nav__arrow--active');
        next.disabled = true;
        prev.classList.add('side-nav__arrow--active');
        prev.disabled = false;
        if (newBtn) newBtn.hidden = false;
        if (resetBtn) resetBtn.hidden = false;
    }

    prev.addEventListener('click', showProjects);
    next.addEventListener('click', showTasks);
})();
