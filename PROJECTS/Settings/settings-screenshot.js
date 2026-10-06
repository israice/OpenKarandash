// Экран для скриншотов Karandash: список мониторов от сервера (node-screenshots) и наглядное
// превью того, что реально снимет кнопка Karandash с выбранного монитора. Отдельный файл —
// это самостоятельный кусок вкладки Providers со своим кешем и своей записью в
// localStorage.
//
// На верхнем уровне файла ничего не выполняется: settings.js зовёт init(...) и получает
// наружу renderScreenshotScreen.
window.SettingsScreenshot = (function () {

    function init({ settingsModal, api }) {
        const screenshotScreenRow = settingsModal.querySelector('#screenshotScreenRow');
        const screenshotScreenSelect = settingsModal.querySelector('#screenshotScreenSelect');
        const screenshotScreenPreview = settingsModal.querySelector('#screenshotScreenPreview');
        // ---------- экран для скриншотов Karandash ----------

        // наглядное превью того, что реально снимет кнопка Karandash с выбранного
        // монитора — тот же снимок, что уходит в миниатюру сессии.
        // Кэшируем по индексу экрана: повторный выбор уже показанного экрана
        // не снимает экран заново, а сразу показывает то, что уже есть
        const screenshotThumbCache = new Map();
        const SCREENSHOT_LAST_THUMB_KEY = 'screenshotLastThumb';

        // последний снимок держим ещё и в localStorage: при открытии Settings
        // показываем его сразу, пока свежий кадр только грузится с сервера —
        // иначе на пустом кэше окно превью на секунду остаётся пустым
        try {
            const lastThumb = localStorage.getItem(SCREENSHOT_LAST_THUMB_KEY);
            if (lastThumb) {
                screenshotScreenPreview.src = lastThumb;
                screenshotScreenPreview.hidden = false;
            }
        } catch {}

        async function renderScreenshotPreview(index) {
            if (screenshotThumbCache.has(index)) {
                screenshotScreenPreview.src = screenshotThumbCache.get(index);
                screenshotScreenPreview.hidden = false;
                return;
            }
            const { ok, thumb } = await api('/api/screenshot');
            if (ok) {
                screenshotThumbCache.set(index, thumb);
                screenshotScreenPreview.src = thumb;
                screenshotScreenPreview.hidden = false;
                try { localStorage.setItem(SCREENSHOT_LAST_THUMB_KEY, thumb); } catch {}
            } else if (!screenshotScreenPreview.src) {
                screenshotScreenPreview.hidden = true;
            }
        }

        // список мониторов приходит от сервера (node-screenshots), поэтому подгружаем
        // его при каждом открытии Settings — состав экранов может меняться
        async function renderScreenshotScreen() {
            const { screens, current } = await api('/api/screenshot/screens');
            if (!screens || screens.length === 0) {
                screenshotScreenRow.hidden = true;
                return;
            }
            screenshotScreenRow.hidden = false;
            screenshotScreenSelect.innerHTML = '';
            for (const screen of screens) {
                const option = document.createElement('option');
                option.value = screen.index;
                option.textContent = `${screen.index + 1}: ${screen.name ? screen.name + ', ' : ''}${screen.width}×${screen.height}${screen.primary ? ' (primary)' : ''}`;
                option.selected = screen.index === current;
                screenshotScreenSelect.append(option);
            }
            renderScreenshotPreview(current);
        }

        screenshotScreenSelect.addEventListener('change', async () => {
            const index = Number(screenshotScreenSelect.value);
            await api('/api/screenshot/screen', { index });
            renderScreenshotPreview(index);
        });

        return { renderScreenshotScreen };
    }

    return { init };
})();
