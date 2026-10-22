// Полнотекстовый поиск возвращает результаты в порядке BM25.
// Дополнительная внешняя rerank-интеграция удалена, поэтому порядок сохраняется.
const RELEVANT = 0.5;

async function rankHits(_query, hits) {
    return hits;
}

module.exports = { rankHits, RELEVANT };
