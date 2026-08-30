// Вкладка Home: карточки заданий. Кнопка Send в поле "Комментарий для исправлений"
// запускает новую сессию с этим текстом — тем же путём, что комментарий из режима Edit.
// «Одобрено» пока не трогаем — у неё будет своя, другая логика.
(function () {

    document.getElementById('homeTaskList')?.addEventListener('click', (e) => {
        const btn = e.target.closest('.task-card__action--send');
        if (!btn) return;

        const input = btn.closest('.task-card__resolution')?.querySelector('.task-card__resolution-input');
        const text = input?.value.trim();
        if (!text) return;

        input.value = '';
        App.startCommentSession(text);
    });

})();
