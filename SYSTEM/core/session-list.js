// Сводка по сессиям для списков и панелей: заголовок уже почищен, а running
// посчитан по реестру запусков. Тему чистим на выдаче, а не только при записи:
// так короткий заголовок получают и сессии, заведённые до этого правила, —
// миграция базы не нужна.
//
// Отдельный модуль, потому что сводку читают два независимых потребителя:
// список сессий и маршруты /api/sessions.
function create({ listSessions, sessionTitle, runs }) {
    function sessionSummaries() {
        return listSessions.all().map((session) => ({
            ...session,
            title: sessionTitle(session),
            running: runs.isRunning(session.id),
        }));
    }

    // момент старта текущего хода активной сессии — реестр запусков отдаёт его сам
    const activeStartedAt = (sessionId) => runs.activeStartedAt(sessionId);
    const activeCount = () => runs.activeCount();

    return { sessionSummaries, activeStartedAt, activeCount };
}

module.exports = { create };