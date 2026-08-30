// Стрелки ←/→ панели Sessions: переключают вкладки Tasks ⇄ Projects.
// Сам не трогает содержимое вкладок — обе сами прячут/показывают свои элементы
// через activate()/deactivate() из SYSTEM/sessions-tasks.js и PROJECTS/Projects/projects-tab.js.
(function () {
    const prev = document.getElementById('sessionsPrev');
    const next = document.getElementById('sessionsNext');
    const title = document.getElementById('sessionsPanelTitle');
    if (!prev || !next || !title) return;

    function setActive(tab) {
        const isTasks = tab === 'tasks';
        title.textContent = isTasks ? 'Tasks' : 'PROJECTS';
        prev.classList.toggle('side-nav__arrow--active', isTasks);
        prev.disabled = !isTasks;
        next.classList.toggle('side-nav__arrow--active', !isTasks);
        next.disabled = isTasks;
        if (isTasks) {
            window.MissionProjectsTab?.deactivate();
            window.MissionSessionsTasks?.activate();
        } else {
            window.MissionSessionsTasks?.deactivate();
            window.MissionProjectsTab?.activate();
        }
    }

    prev.addEventListener('click', () => setActive('projects'));
    next.addEventListener('click', () => setActive('tasks'));

    window.MissionSessionsTabs = { setActive };
})();
