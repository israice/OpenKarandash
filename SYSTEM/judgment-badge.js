// Пометка суждения о ходе — один источник разметки на три отображения
// (Sessions, Feed, Flow; DOCS/decisions/039). Сами числа кладёт в result_meta
// сервер (SYSTEM/core/turn-judgment.js, DOCS/decisions/051), здесь только
// перевод их в человеческие слова.
//
// Обычный скрипт, а не ES-модуль: flow.js подключён с defer и импортировать
// не может, поэтому общий механизм публикуется наружу через window — то же
// правило, что у MissionFiles и SidebarResize.

(() => {
    const KIND_LABELS = {
        code: 'правка кода',
        docs: 'документация',
        analysis: 'разбор',
        conversation: 'разговор',
        failure: 'сорвался',
    };

    // почему письмо ушло или не ушло — теми же словами, что и причина в коде
    const NOTIFY_LABELS = {
        error: 'в телеграм: ошибка хода',
        'no-judgment': 'в телеграм: без суждения',
        'awaits-human': 'в телеграм: ждёт ответа',
        'final-report': 'в телеграм: законченный ход',
        intermediate: 'в телеграм не ушло: середина работы',
    };

    // шкала needs_attention: 0 — ничего не нужно, 2 — смотреть обязательно.
    // Порог ровно посередине верхней половины: ниже — обычный ход
    function attentionLabel(score) {
        if (typeof score !== 'number') return null;
        if (score >= 1.5) return 'нужно посмотреть';
        if (score >= 0.75) return 'стоит взглянуть';
        return null;
    }

    function percent(value) {
        return typeof value === 'number' ? `${Math.round(value * 100)}%` : '';
    }

    function parse(resultMeta) {
        if (!resultMeta) return null;
        const meta = typeof resultMeta === 'string' ? safeParse(resultMeta) : resultMeta;
        return meta && meta.judgment ? meta.judgment : null;
    }

    function safeParse(raw) {
        try { return JSON.parse(raw); } catch { return null; }
    }

    function chip(row, text, tone) {
        if (!text) return;
        const span = document.createElement('span');
        span.className = `judgment__chip${tone ? ` judgment__chip--${tone}` : ''}`;
        span.textContent = text;
        row.append(span);
    }

    // resultMeta — строка из базы или уже разобранный объект. Ход без суждения
    // (ключа нет, сервис не ответил, старая запись) пометки не получает вовсе:
    // пустая плашка «неизвестно» была бы шумом в каждой строке
    function badge(resultMeta) {
        const j = parse(resultMeta);
        if (!j) return null;

        const row = document.createElement('div');
        row.className = 'judgment';

        const finished = typeof j.finalReport === 'number' && j.finalReport >= 0.6;
        const waiting = typeof j.awaitsHuman === 'number' && j.awaitsHuman >= 0.5;
        if (waiting) chip(row, `ждёт ответа ${percent(j.awaitsHuman)}`, 'wait');
        else chip(row, `${finished ? 'законченный ход' : 'середина работы'} ${percent(j.finalReport)}`, finished ? 'done' : 'mid');

        chip(row, KIND_LABELS[j.workKind] || j.workKind, 'kind');
        chip(row, attentionLabel(j.needsAttention), 'attention');
        chip(row, NOTIFY_LABELS[j.notified?.reason], j.notified?.send ? 'sent' : 'muted');

        // числа целиком — во всплывающей подсказке: в строке им тесно, а при
        // разборе «почему письмо не ушло» они первое, что нужно
        row.title = [
            `final_report: ${j.finalReport}`,
            `awaits_human: ${j.awaitsHuman}`,
            `work_kind: ${j.workKind} (confidence ${j.workKindConfidence})`,
            `needs_attention: ${j.needsAttention} (confidence ${j.needsAttentionConfidence})`,
            `model: ${j.model}`,
        ].join('\n');
        return row.children.length ? row : null;
    }

    window.TurnJudgment = { badge };
})();
