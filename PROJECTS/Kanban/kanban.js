// Вкладка Kanban целиком: колонки доски (стили — PROJECTS/Kanban/kanban.css).
// Карточек пока нет, «+» в колонке New заводит отдельную сессию с заданием —
// тем же путём, что комментарий из Karandash. Названия колонок — App.BOARD_COLUMNS: их же берёт Flow.
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
    // как и комментарий из режима Karandash
    document.querySelector('.board__add')?.addEventListener('click', () => {
        const task = prompt('Задание для новой сессии:');
        if (task && task.trim()) App.startCommentSession(task.trim());
    });

})();
