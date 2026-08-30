// Кнопка Sessions в тулбаре страницы Chat: показывает/прячет панель sessionsPanel.
(function () {
    const toggle = document.getElementById('sessionsToggle');
    const panel = document.getElementById('sessionsPanel');
    if (!toggle || !panel) return;

    toggle.addEventListener('click', () => {
        const open = panel.hidden;
        panel.hidden = !open;
        toggle.setAttribute('aria-pressed', String(open));
        toggle.setAttribute('aria-expanded', String(open));
    });
})();
