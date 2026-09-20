// Осмысленная расстановка найденного. Полнотекстовый поиск (FTS5/BM25 в
// PROJECTS/Graph/graph-search.js) находит по совпадению слов и не знает, о чём
// запрос: «лента» одинаково хорошо совпадает и с лентой сессии, и с лентой
// новостей в чужом комментарии. Поэтому код ищет кандидатов, а по каждому
// задаётся отдельный вопрос «отвечает ли этот кусок на запрос» — это приём
// reranking из cookbook самой документации (DOCS/decisions/051, 053).
//
// Вопросы независимы и едут одним запросом: они считаются параллельно и не
// отнимают вероятность друг у друга, в отличие от одного выбора на всех.

const typesafe = require('./typesafe.js');

// сколько кандидатов вообще имеет смысл взвешивать: ниже пятнадцатого места
// BM25 обычно уже мусор, а каждый кандидат — это кусок текста в запросе,
// и большой запрос доку прямо называет причиной падения точности
const MAX_CANDIDATES = 15;
// длина куска на кандидата: по двенадцати словам сниппета вопрос не решается,
// а целый файл в запрос не влезет и только помешает
const EXCERPT_CHARS = 600;
// ниже этого кандидат уходит в хвост, но не выбрасывается: поиск обязан
// показывать найденное, даже когда суждение в нём не уверено
const RELEVANT = 0.5;

// hits — то, что вернул полнотекстовый поиск: { kind, ref, title, snippet }.
// excerpt(hit) — чем судить кандидата; нет его — судим по заголовку и сниппету.
// Возвращает те же строки в новом порядке, с добавленным полем relevance;
// механизм выключен или сервис не ответил — отдаёт исходный порядок как есть
async function rankHits(query, hits, excerpt) {
    const text = String(query || '').trim();
    if (!typesafe.isEnabled() || !text || !Array.isArray(hits) || hits.length < 3) return hits;

    const candidates = hits.slice(0, MAX_CANDIDATES);
    const passages = {};
    const questions = {};
    candidates.forEach((hit, i) => {
        const id = `c${i}`;
        const body = (excerpt ? excerpt(hit) : '') || hit.snippet || '';
        passages[id] = {
            where: hit.title || hit.ref,
            text: String(body).replace(/\s+/g, ' ').trim().slice(0, EXCERPT_CHARS),
        };
        questions[id] = {
            type: 'noul',
            instructions: `Does \`passages.${id}\` answer \`query\` or tell the reader where the answer is?`,
            criteria: {
                true: { what: 'It is about the thing the query asks about, and reading it moves the reader forward.' },
                false: {
                    what: 'It merely shares words with the query, or mentions the subject in passing.',
                    not_for: 'A passage that is genuinely about the subject but short.',
                },
            },
        };
    });

    const res = await typesafe.systemOne({ query: text, passages }, questions);
    if (!res?.answers) return hits;

    // устойчивая сортировка: при равной оценке порядок остаётся исходным,
    // то есть оценка уточняет BM25, а не заменяет его собой
    const ranked = candidates
        .map((hit, i) => ({ hit, i, relevance: typesafe.noul(res.answers, `c${i}`) ?? 0 }))
        .sort((a, b) => (b.relevance - a.relevance) || (a.i - b.i))
        .map(({ hit, relevance }) => ({ ...hit, relevance, relevant: relevance >= RELEVANT }));

    return [...ranked, ...hits.slice(MAX_CANDIDATES)];
}

module.exports = { rankHits, RELEVANT };
