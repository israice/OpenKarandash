// Меню-шестерёнка в правом верхнем углу: выпадающий список.
(function () {
            const root = document.getElementById('settings');
            const button = document.getElementById('settingsButton');
            const menu = document.getElementById('settingsMenu');

            function open() {
                menu.hidden = false;
                button.setAttribute('aria-expanded', 'true');
            }

            function close() {
                menu.hidden = true;
                button.setAttribute('aria-expanded', 'false');
            }

            button.addEventListener('click', () => {
                App.openSettings();
            });

            // клик вне меню закрывает его
            document.addEventListener('click', (e) => {
                if (!root.contains(e.target)) close();
            });

            // Escape закрывает и возвращает фокус на кнопку
            document.addEventListener('keydown', (e) => {
                if (e.key === 'Escape' && !menu.hidden) {
                    close();
                    button.focus();
                }
            });

            menu.addEventListener('click', (e) => {
                const item = e.target.closest('.settings__item');
                if (!item) return;
                const label = item.textContent.trim();

                close();

                if (label === 'Settings') App.openSettings();
                else console.log('Выбрано:', label);
            });

})();
