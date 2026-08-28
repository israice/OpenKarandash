// Ручка на правой грани панели Sessions: зажать и тянуть, чтобы менять её ширину.
(function () {
    const MIN_WIDTH = 210;
    const STORAGE_KEY = 'sessionsPanelWidth';

    function init() {
        const panel = document.getElementById('sessionsPanel');
        const handle = document.getElementById('sessionResize');
        if (!panel || !handle) return;

        const saved = Number(localStorage.getItem(STORAGE_KEY));
        if (saved) panel.style.width = Math.min(window.innerWidth / 2, Math.max(MIN_WIDTH, saved)) + 'px';

        let startX = 0;
        let startWidth = 0;

        function onMove(e) {
            const maxWidth = window.innerWidth / 2;
            const width = Math.min(maxWidth, Math.max(MIN_WIDTH, startWidth + (e.clientX - startX)));
            panel.style.width = width + 'px';
        }

        function onUp() {
            handle.classList.remove('session-resize--active');
            document.body.style.cursor = '';
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
            localStorage.setItem(STORAGE_KEY, Math.round(panel.getBoundingClientRect().width));
        }

        handle.addEventListener('pointerdown', (e) => {
            startX = e.clientX;
            startWidth = panel.getBoundingClientRect().width;
            handle.classList.add('session-resize--active');
            document.body.style.cursor = 'col-resize';
            window.addEventListener('pointermove', onMove);
            window.addEventListener('pointerup', onUp);
            e.preventDefault();
        });
    }

    document.addEventListener('DOMContentLoaded', init);
})();
