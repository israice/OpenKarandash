// Вкладка Sandglass: обратный отсчёт и доля прошедшего времени для 3D-песочных часов.
// Имя с «tab» — чтобы не спутать с settings-sandglass.js: там сам рендер (three.js +
// Rapier), а здесь только счётчик, который его тикает.
//
// Контракт с рендером: доля прошедшего времени пишется в data-elapsed на .sandglass,
// рендер читает её каждый кадр (PROJECTS/Settings/settings-sandglass.js).
//
// На верхном уровне файла ничего не выполняется: settings.js зовёт init(...) и получает
// наружу startSandglassCountdown и stopSandglassCountdown.
window.SettingsSandglassTab = (function () {

    function init({ settingsModal }) {
        // ---------- вкладка Sandglass: обратный отсчёт (пока заглушка) ----------
        // 1 день 2 часа 30 минут 12 секунд — стартовое значение-заглушка, тикает
        // раз в секунду до нуля и останавливается; уровень песка в SVG следует
        // за долей прошедшего времени этого же счётчика (renderSandglassSand)
        const SANDGLASS_INITIAL_SECONDS = 24 * 3600 + 2 * 3600 + 30 * 60 + 12;
        let sandglassSecondsLeft = SANDGLASS_INITIAL_SECONDS;
        let sandglassTimer = null;
        const sandglassCountdownEl = settingsModal.querySelector('#sandglassCountdown');
        const sandglassEl = settingsModal.querySelector('.sandglass');

        function formatSandglass(totalSeconds) {
            const s = Math.max(0, totalSeconds);
            const days = Math.floor(s / 86400);
            const hours = Math.floor((s % 86400) / 3600);
            const minutes = Math.floor((s % 3600) / 60);
            const seconds = s % 60;
            const pad = (n) => String(n).padStart(2, '0');
            return `${days}d ${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
        }

        // доля прошедшего времени (0 в начале — верх полон, 1 у нуля — низ полон);
        // сам рисунок (3D-рендер, PROJECTS/Settings/settings-sandglass.js) читает
        // это значение из data-elapsed каждый кадр и сам двигает кучи и струйку —
        // этот файл про сам рендер ничего не знает, только пишет долю
        function renderSandglassSand() {
            if (!sandglassEl) return;
            const total = SANDGLASS_INITIAL_SECONDS || 1;
            const elapsed = Math.min(1, Math.max(0, 1 - sandglassSecondsLeft / total));
            sandglassEl.dataset.elapsed = String(elapsed);
        }

        function renderSandglassCountdown() {
            if (sandglassCountdownEl) sandglassCountdownEl.textContent = formatSandglass(sandglassSecondsLeft);
            renderSandglassSand();
        }

        function startSandglassCountdown() {
            if (sandglassTimer) return;
            renderSandglassCountdown();
            sandglassTimer = setInterval(() => {
                if (sandglassSecondsLeft <= 0) {
                    clearInterval(sandglassTimer);
                    sandglassTimer = null;
                    return;
                }
                sandglassSecondsLeft -= 1;
                renderSandglassCountdown();
            }, 1000);
        }

        function stopSandglassCountdown() {
            clearInterval(sandglassTimer);
            sandglassTimer = null;
        }

        return { startSandglassCountdown, stopSandglassCountdown };
    }

    return { init };
})();
