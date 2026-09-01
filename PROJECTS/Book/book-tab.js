// Вкладка Book верхнего тулбара: слева карточки всех разделов интерфейса —
// Graph/Flow/Kanban/PROJECTS/Home/Book/Karandash/Settings, справа — README
// выбранной карточки. Раньше это была вкладка Projects боковой панели
// Sessions (PROJECTS/Chat/projects-tab.js) с тем же приёмом; теперь это
// отдельная страница, и панель справа — своя (MissionGraph.openBook),
// а не общая с чатом.
(function () {
    const list = document.getElementById('bookList');
    if (!list) return;

    const SOURCE_IDS = [
        'graphButton', 'flowButton', 'kanbanButton', 'chatButton', 'homeButton',
        'bookButton', 'karandashButton', 'settingsButton',
    ];

    // короткое описание каждого раздела для карточки — по одному на кнопку тулбара
    const DESCRIPTIONS = {
        graphButton: 'Карта проекта: файлы, функции и связи между ними',
        flowButton: 'Диаграмма потока выполнения проекта',
        kanbanButton: 'Доска задач в колонках',
        chatButton: 'Чат с ассистентом и список сессий',
        homeButton: 'Главный экран, общий обзор проекта',
        bookButton: 'Библиотека разделов интерфейса',
        karandashButton: 'Karandash — режим комментариев к интерфейсу',
        settingsButton: 'Настройки приложения и провайдеров',
    };

    // у каждой кнопки тулбара есть своя папка в PROJECTS/ с README.md
    const README = {
        graphButton: 'PROJECTS/Graph/README.md',
        flowButton: 'PROJECTS/Flow/README.md',
        kanbanButton: 'PROJECTS/Kanban/README.md',
        chatButton: 'PROJECTS/Chat/README.md',
        homeButton: 'PROJECTS/Home/README.md',
        bookButton: 'PROJECTS/Book/README.md',
        karandashButton: 'PROJECTS/Karandash/README.md',
        settingsButton: 'PROJECTS/Settings/README.md',
    };

    // данных о реальном создании/версии карточек пока нет — генерируем правдоподобные
    // один раз за показ, чтобы карточки не прыгали при пересборке
    function fakeCardMeta() {
        const daysAgo = Math.floor(Math.random() * 60);
        const created = new Date(Date.now() - daysAgo * 86400000);
        const date = created.toLocaleDateString('ru-RU');
        const time = created.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
        const version = `v0.${Math.floor(Math.random() * 9) + 1}.${Math.floor(Math.random() * 20)}`;
        return `${date} ${time} · ${version}`;
    }

    // встроенные разделы (SOURCE_IDS) плюс папки, заведённые кнопкой «+»
    // (SYSTEM/new-button.js) — те помечают свою кнопку тулбара data-readme
    function collectEntries() {
        const entries = [];
        for (const id of SOURCE_IDS) {
            const source = document.getElementById(id);
            if (!source) continue;
            entries.push({ source, readme: README[id], desc: DESCRIPTIONS[id] || '' });
        }
        for (const source of document.querySelectorAll('.toolbar [data-readme]')) {
            entries.push({ source, readme: source.dataset.readme, desc: 'Пользовательский раздел' });
        }
        return entries;
    }

    function buildCard({ source, readme, desc }) {
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
                MissionGraph.closeBookPanel();
            } else {
                for (const other of list.querySelectorAll('.project-card--selected')) {
                    other.classList.remove('project-card--selected');
                }
                btn.classList.add('project-card--selected');
                MissionGraph.openBook(readme);
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
        return item;
    }

    // пересобираем при каждом открытии вкладки — новая папка от кнопки «+»
    // могла появиться уже после предыдущего показа; справа сразу показываем
    // README из корня проекта, как раньше делала вкладка Projects
    function show() {
        list.innerHTML = '';
        for (const entry of collectEntries()) list.append(buildCard(entry));
        MissionGraph.openBook('README.md');
    }

    window.MissionBookTab = { show };
})();
