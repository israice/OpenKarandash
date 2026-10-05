// Путь модели: разбор на уровни и склейка обратно.
//
// Отдельный файл от SYSTEM/model-cascade.js, где сама строка выбора: там
// четыре уровня и правила их заполнения, здесь — одна форма пути и её разбор.
// Смешались бы в одном файле — и правка формы пути лезла бы в отрисовку.
//
// Форма пути у CLI двух видов, и разница ровно в первом уровне:
//
//   - «openrouter/stealth/space-bunny-alpha» — первый уровень шлюз, там
//     уровней три: шлюз, поставщик, модель;
//   - «kilo/stealth/space-bunny-alpha» — первый уровень имя самого CLI
//     (opencode так же), шлюза в пути нет вовсе, и уровней два: поставщик и
//     модель.
//
// Разбор без знания CLI путал имя с шлюзом: в Gateway вставал «kilo», а в
// Model уезжал путь целиком вместо имени модели — то есть строка показывала не
// то, что человек выбрал. Поэтому разбор спрашивает, чей это путь, и только
// тогда решает, что первый уровень.

// Короткое слово имени CLI: «Kilo Code» → «kilo», «Command Code» →
// «command». В списке на сайте имя полное, а в пути модели CLI называет себя
// коротким словом, поэтому сверка идёт и по нему, и по слитному («kilocode»)
const slugOf = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const shortNameOf = (cliId) => String(cliId || '').trim().toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)[0] || '';

// Про этот ли CLI первый уровень пути
function headIsCli(head, cliId) {
    const slug = slugOf(head);
    return Boolean(slug) && (slug === shortNameOf(cliId) || slug === slugOf(cliId));
}

// Имя модели разбирается на уровни по форме пути, которую понимает этот CLI.
// У пути от имени CLI уровня шлюза нет вовсе, и gateway возвращается пустым:
// шлюз этого CLI человек ставит отдельно, и он не часть его пути
export function modelLevels(model, cliId) {
    const parts = String(model || '').split('/');
    const name = parts.pop();
    const head = parts.shift() || '';
    const own = headIsCli(head, cliId);
    return {
        gateway: own ? '' : head,
        provider: parts.join('/'),
        model: name || '',
    };
}

// Склейка пути обратно — той же формой, какой CLI называет модель. Склеивает
// ровно один код: путь уходит и в CLI, и в строку базы, и в подпись, и собранный
// в двух местах он разойдётся. Форма берётся из каталога, который CLI отдал
// при подключении, а пока каталога нет — формой обычного пути (шлюз первым)
//
// Уровней в пути бывает два, а не три: у pi каталог отдаёт «anthropic/
// claude-fable-5» — шлюз и модель, без поставщика. Раньше путь без поставщика
// собирался в одно слово имени модели, и шлюз из него выпадал: строка в шапке
// показывала Gateway=anthropic, а в CLI уходило «claude-fable-5» — короткое
// имя, которым CLI называет любую модель с таким именем у любого шлюза. Показанный
// выбор и ушедший в ход разъезжались, и ход отвечала другая модель. Поэтому
// пустой уровень просто пропускается, а не отсекает всё, что после него
export function modelPath(cliId, gateway, provider, model, models) {
    if (!model) return '';
    const head = ownHeadOf(cliId, models) || gateway;
    if (!head) return provider ? `${provider}/${model}` : model;
    return [head, provider, model].filter(Boolean).join('/');
}

// Голова пути этого CLI: его имя, когда каталог моделей начинается с него, и
// пустая строка когда путь обычный или каталога ещё нет
function ownHeadOf(cliId, models) {
    const list = Array.isArray(models) ? models : [];
    return list.some((m) => headIsCli(String(m).split('/')[0], cliId)) ? shortNameOf(cliId) : '';
}