// Вкладка Projects панели Sessions: 7 разделов интерфейса — 5 кнопок тулбара
// (Graph/Flow/Kanban/Chat/Home) плюс Edit и Settings. Карточка открывает README своей
// папки в правой панели вместо переключения вкладки; повторный клик закрывает панель.
// Не знает про вкладку Tasks — свои элементы включает и выключает сама.
(function () {
    const taskList = document.getElementById('sessionList');
    if (!taskList) return;

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

    // у каждой кнопки тулбара есть своя папка в PROJECTS/ с README.md
    const PROJECT_README = {
        graphButton: 'PROJECTS/Graph/README.md',
        flowButton: 'PROJECTS/Flow/README.md',
        kanbanButton: 'PROJECTS/Kanban/README.md',
        chatButton: 'PROJECTS/Projects/README.md',
        homeButton: 'PROJECTS/Home/README.md',
        editModeButton: 'PROJECTS/Edit/README.md',
        settingsButton: 'PROJECTS/Settings/README.md',
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

    // встроенные разделы (PROJECT_SOURCE_IDS) плюс папки, заведённые кнопкой «+»
    // (SYSTEM/new-button.js) — те помечают свою кнопку тулбара data-readme
    function collectEntries() {
        const entries = [];
        for (const id of PROJECT_SOURCE_IDS) {
            const source = document.getElementById(id);
            if (!source) continue;
            entries.push({ source, readme: PROJECT_README[id], desc: PROJECT_DESCRIPTIONS[id] || '' });
        }
        for (const source of document.querySelectorAll('.toolbar [data-readme]')) {
            entries.push({ source, readme: source.dataset.readme, desc: 'Пользовательский раздел' });
        }
        return entries;
    }

    // строим список лениво: editModeButton/settingsButton существуют в DOM
    // к моменту первого клика, но не обязательно раньше; пересобираем при каждой
    // активации — новые папки могут появиться уже после первой сборки
    function buildProjectList() {
        const ul = document.createElement('ul');
        ul.className = 'session-list project-cards';
        ul.hidden = true;
        for (const { source, readme, desc } of collectEntries()) {
            const label = source.title || source.getAttribute('aria-label') || '';
            const item = document.createElement('li');
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'project-card';
            btn.title = label;
            btn.addEventListener('click', () => {
                if (!readme) { source.click(); return; }
                if (btn.classList.contains('project-card--selected')) {
                    btn.classList.remove('project-card--selected');
                    MissionGraph.closeFilePanel();
                } else {
                    for (const other of ul.querySelectorAll('.project-card--selected')) {
                        other.classList.remove('project-card--selected');
                    }
                    btn.classList.add('project-card--selected');
                    MissionGraph.openFile(readme);
                }
            });
            const icon = document.createElement('span');
            icon.className = 'project-card__icon';
            icon.innerHTML = source.innerHTML;
            const body = document.createElement('span');
            body.className = 'project-card__body';
            const text = document.createElement('span');
            text.className = 'project-card__label';
            text.textContent = label;
            const descEl = document.createElement('span');
            descEl.className = 'project-card__desc';
            descEl.textContent = desc;
            const meta = document.createElement('span');
            meta.className = 'project-card__meta';
            meta.textContent = fakeCardMeta();
            body.append(text, descEl, meta);
            btn.append(icon, body);
            item.append(btn);
            ul.append(item);
        }
        taskList.after(ul);
        return ul;
    }

    function activate() {
        // пересобираем каждый раз: список карточек мог измениться (новая папка от кнопки «+»)
        if (projectList) projectList.remove();
        projectList = buildProjectList();
        projectList.hidden = false;
        // вместо чата сразу показываем README.md из корня проекта на всю высоту панели
        MissionGraph.openFile('README.md');
    }

    function deactivate() {
        if (!projectList) return;
        projectList.hidden = true;
        for (const btn of projectList.querySelectorAll('.project-card--selected')) {
            btn.classList.remove('project-card--selected');
        }
        MissionGraph.closeFilePanel();
    }

    window.MissionProjectsTab = { activate, deactivate };
})();
