// Вкладка Kanban — сейчас чистая UI-заготовка без логики (DOCS/decisions/032):
// ни сервера, ни базы, ни модалки с деталями задачи. Разметку строит этот файл
// сам — пять пустых колонок статуса. Вид доски уточняется по шагам: сюда
// добавляется ровно то, что попросят следующим.
(function () {
    const COLUMNS = [
        { key: 'todo', title: 'Todo' },
        { key: 'in_progress', title: 'In Progress' },
        { key: 'blocked', title: 'Blocked' },
        { key: 'review', title: 'Review' },
        { key: 'done', title: 'Done' },
    ];

    function render() {
        const view = document.getElementById('kanbanView');
        if (!view) return;
        view.innerHTML = `
            <div class="board">
                <div class="board__columns">
                    ${COLUMNS.map((col) => `
                        <section class="board__column" data-column="${col.key}">
                            <h2 class="board__column-title">
                                <span>${col.title}</span>
                            </h2>
                            <div class="board__column-body">
                                <p class="board__column-empty">Empty</p>
                            </div>
                        </section>
                    `).join('')}
                </div>
            </div>
        `;
    }

    render();

    // горячая перезагрузка: снять своё нечего, скрипт при загрузке рисует колонки
    // сам, а крючок нужен лишь чтобы раздел знал, что перерисоваться умеет
    window.App?.registerHotReload('PROJECTS/Kanban/kanban.js', () => {});
})();