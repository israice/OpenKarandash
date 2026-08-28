// Вкладка Kanban: колонки доски. Карточек пока нет, «+» в колонке New
// заводит отдельную сессию с заданием — тем же путём, что комментарий из Edit.
(function () {

            // колонки доски пока пустые — карточки появятся вместе с логикой
            const board = document.getElementById('board');
            for (const title of App.BOARD_COLUMNS) {
                const column = document.createElement('section');
                column.className = 'board__column';
                column.innerHTML = `
                    <div class="board__header">
                        <h2 class="board__title">${title}</h2>
                        <span class="board__header-right">
                            <span class="board__count">0</span>
                            ${title === 'New' ? '<button type="button" class="board__add" title="Новая сессия с заданием">+</button>' : ''}
                        </span>
                    </div>
                    <div class="board__body">Пока пусто</div>
                `;
                board.append(column);
            }

            // «+» в колонке New — задание запускает отдельную сессию,
            // как и комментарий из режима Edit
            document.querySelector('.board__add')?.addEventListener('click', () => {
                const task = prompt('Задание для новой сессии:');
                if (task && task.trim()) App.startCommentSession(task.trim());
            });

})();
