// Ручка на правой грани боковой панели: зажать и тянуть, чтобы менять её
// ширину. Панели самой страницы — в PANELS ниже; панель, которую вкладка
// строит сама (Book), подключает себя вызовом SidebarResize.init(...).
(function () {
    const MIN_WIDTH = 210;

    const PANELS = [
        { panelId: 'sessionsPanel', handleId: 'sessionResize', storageKey: 'sessionsPanelWidth' },
    ];

    function initPanel({ panelId, handleId, storageKey }) {
        const panel = document.getElementById(panelId);
        const handle = document.getElementById(handleId);
        if (!panel || !handle) return;

        const saved = Number(localStorage.getItem(storageKey));
        if (saved) panel.style.width = Math.min(window.innerWidth / 2, Math.max(MIN_WIDTH, saved)) + 'px';

        let startX = 0;
        let startWidth = 0;

        function onMove(e) {
            const maxWidth = window.innerWidth / 2;
            const width = Math.min(maxWidth, Math.max(MIN_WIDTH, startWidth + (e.clientX - startX)));
            panel.style.width = width + 'px';
        }

        function onUp() {
            handle.classList.remove('panel-resize--active');
            document.body.style.cursor = '';
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
            localStorage.setItem(storageKey, Math.round(panel.getBoundingClientRect().width));
        }

        handle.addEventListener('pointerdown', (e) => {
            startX = e.clientX;
            startWidth = panel.getBoundingClientRect().width;
            handle.classList.add('panel-resize--active');
            document.body.style.cursor = 'col-resize';
            window.addEventListener('pointermove', onMove);
            window.addEventListener('pointerup', onUp);
            e.preventDefault();
        });
    }

    document.addEventListener('DOMContentLoaded', () => {
        for (const config of PANELS) initPanel(config);
    });

    window.SidebarResize = { init: initPanel };
})();
