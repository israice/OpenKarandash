// Каскад выбора модели: пять уровней (CLI / шлюз / поставщик / модель / глубина
// размышления) и правила их заполнения. Отдельный файл от SYSTEM/providers.js,
// где лежит само состояние подключения: провайдеры, подключения и их
// сохранение. Здесь — только выбор и его отрисовка.
//
// Каскад стоит в одном месте: строка выбора в шапке сессии
// (SYSTEM/session-model-bar.js, она же читает выбор при отправке хода). Раньше
// та же строка стояла ещё и в настройках — витриной вверху вкладки Providers и
// под карточкой подключённого провайдера, — но выбор модели в двух местах
// разъезжался: подключение в настройках возвращало свой дефолт поверх выбора
// человека в шапке. Теперь выбирают в шапке, и она единственный источник выбора,
// поэтому модель приходит одним словом оттуда и уходит в CLI тем же.
import {
    providerById, connections, saveProviderState, saveLevelChoice, loadLevelChoice,
} from './providers.js';
import { cliLevelNames } from './cli-agents.js';
import { modelLevels, modelPath } from './model-path.js';
import { levelWithAdd, ignoreAdd } from './model-add-option.js';
import { fillEffortLevel, saveEffort } from './model-effort.js';

// ---------- выбор уровней ----------
//
// Уровни выбора живут в строке в шапке сессии (SYSTEM/session-model-bar.js) и
// больше нигде: конкретных моделей и запасных значений в коде нет вообще, и
// строка на прочерках — честный ответ «человек ещё ничего не выбрал», который
// видно и который можно исправить, выбрав в этой же строке. Раньше здесь стоял
// дефолт проекта (openrouter / stealth / space-bunny-alpha) и строка без выбора
// показывала его, а ход по нему уходил — то есть у человека был выбор на
// экране и совершенно другой в ходе
//
// Три уровня выбора как их запомнил человек: хранилище и ничего кроме него.
// Ключ один на все CLI (решение в SYSTEM/providers.js), поэтому переключение CLI
// ничего в них не меняет
function levelTriplet() {
    const remembered = loadLevelChoice();
    return {
        gateway: remembered.gateway || '',
        provider: remembered.provider || '',
        model: remembered.model || '',
    };
}

// Уровни выбора — ровно те, что человек поставил, и ничего кроме них. Пути
// модели здесь нет намеренно: конкретную форму пути знает CLI, а не уровни
// (у kilo путь начинается с «kilo/…», у pi — «шлюз/модель»), и собранный из
// уровней путь получался не тем, что уходит в ход. Раньше здесь был ещё и
// model — с путём, который терял шлюз там, где поставщика нет, то есть ровно
// то неверное значение, из-за которого ход уходил к другой модели. Путь,
// собранный правильно, один: modelOf (ему известен CLI), и читает его строка
// выбора. Наружу уровни уходят для подписи над ответом (SYSTEM/model-tag.js),
// которой нужен шлюз: у CLI с путём от своего имени его в пути нет вовсе, и
// подпись дописывает его сама
export function levelsOf() {
    const { gateway, provider, model } = levelTriplet();
    return { gateway, provider, model };
}

// Модель, которой сейчас отвечает CLI: ровно выбор человека по уровням,
// собранный в путь той формы, какой этот CLI понимает (см. modelPath). Запасных
// чтений нет — ни из состояния подключения, ни из дефолта провайдера: список
// моделей у CLI до Connect пуст, поэтому каскад строится по этой строке, и пока
// выбора нет, модель не выбрана
export function modelOf(cliId) {
    const { gateway, provider, model } = levelTriplet();
    return modelPath(cliId, gateway, provider, model, providerById(cliId).models);
}

// один уровень каскада: строки по списку, а когда списка нет — единственный
// прочерк и неактивный select. Встаёт строка, которой просил человек
// (wanted), иначе прежний выбор, если он попал в новый список, иначе первая
function fillLevel(select, values, emptyLabel, wanted, label = (value) => value) {
    const previous = wanted ?? select.value;
    select.innerHTML = '';
    select.disabled = values.length === 0;
    for (const value of values.length ? values : ['']) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = value ? label(value) : emptyLabel;
        select.append(option);
    }
    select.value = values.includes(previous) ? previous : (values[0] || '');
}

// Шлюзы, которых в меню Gateway нет: список шлюзов приходит из моделей CLI и
// там есть openai, а владелец его из меню убрал. Строка просто не
// показывается — модели openai/… в списке CLI остаются, а если выбран был
// именно этот шлюз, уровень встаёт на первый из оставшихся (fillLevel сам)
const HIDDEN_GATEWAYS = new Set(['openai']);

// Провайдер по имени CLI берётся из providers.js: запись заводится там по
// требованию, поэтому у kilo или omp она есть уже при первом показе строки

// Уникальные значения одного уровня по моделям выбранного CLI. Шлюз и
// поставщик, выбранные левее, сужают список; порядок остаётся тем же, в каком
// CLI отдал модели, — иначе список прыгал бы при каждой перерисовке
function levelValues(models, gateway, provider, take, cliId) {
    const values = [];
    for (const model of models) {
        const levels = modelLevels(model, cliId);
        if (gateway != null && levels.gateway !== gateway) continue;
        if (provider != null && levels.provider !== provider) continue;
        const value = take(levels);
        if (value && !values.includes(value)) values.push(value);
    }
    return values;
}

// Модели, по которым строится каскад: список, который отдал CLI, а пока его
// нет (CLI не подключён) — одна строка текущей модели, иначе строка выбора в
// шапке стояла бы на прочерках вместо выбранного значения
const modelsFor = (cliId) => {
    const models = providerById(cliId).models;
    return models.length ? models : [modelOf(cliId)].filter(Boolean);
};

// Пять селектов в ряд: CLI / Gateway / Provider / Model / Effort. cliIds — какие
// CLI строка считает своими сверх списка с сайта (шапка сессии: подключённые и
// последний выбранный), cli — каким встать уровню CLI, model — что показать
// сразу, onChange — куда попадает собранный выбор, addOption — дописать ли вниз
// списков CLI и Gateway пункт «Add». Строка стоит в шапке сессии, и уровень CLI
// перечисляет в ней всех, кого может назвать сайт (SYSTEM/cli-agents.js): имя
// оттуда — ровно то, что уходит в CLI, коннектор один на всех и работает с
// любым именем (SYSTEM/cli/any.js)
export function modelCascadeRow({ cliIds, cli, model, onChange, addOption = false }) {
    const row = document.createElement('div');
    row.className = 'provider__model provider__model--cascade';
    const selects = {};
    for (const [key, title] of [['cli', 'CLI'], ['gateway', 'Gateway'], ['provider', 'Provider'], ['model', 'Model'], ['effort', 'Effort']]) {
        const label = document.createElement('span');
        label.className = 'provider__model-label';
        label.textContent = `${title}:`;
        const select = document.createElement('select');
        select.className = 'provider__select provider__select--source';
        select.setAttribute('aria-label', title);
        row.append(label, select);
        selects[key] = select;
    }

    // Глубина размышления наполняется один раз и перерисовкой не трогается:
    // список у неё общий (SYSTEM/model-effort.js), от выбранной модели он не
    // зависит, а меняет его только сам человек — обработчиком change ниже
    fillEffortLevel(selects.effort);

    // Значения уровня CLI — список с сайта (SYSTEM/cli-agents.js, тот же, что на
    // странице «New projects») плюс наши собственные провайдеры: подключённый
    // CLI должен остаться в списке, даже если сайт его не назвал. Слово из
    // этого списка — то, что уходит в CLI: коннектор один на всех и работает с
    // любым именем (SYSTEM/cli/any.js)
    const cliValues = () => cliLevelNames(cliIds);

// Уровень с пунктом «Add» внизу наполняется через levelWithAdd: сейчас это
// два верхних уровня — CLI и Gateway, где появляется новое; Provider, Model и
// Effort остаются чистыми. Заглушка и возврат с неё — в model-add-option.js
const fillLevelWithAdd = (select, values, emptyLabel, wanted, label) =>
        levelWithAdd(select, () => fillLevel(select, values, emptyLabel, wanted, label), addOption);

// собранный выбор в виде, который понимает CLI: в списке моделей подпись —
    // хвост после последнего слэша, а value там целиком («openrouter/stealth/
    // space-bunny-alpha»), поэтому строка собирается сама и склеивать уровни
    // заново не надо. Effort в пути модели нет — он уходит отдельным флагом
    // хода, поэтому читается рядом с ним. Читает её оттуда, где человек
    // управляет выбором: из шапки сессии (getActiveModel и getActiveEffort)
    row.read = () => ({
        cli: selects.cli.value,
        model: selects.model.value,
        effort: selects.effort.value,
    });
    // один проход по четырём уровням: у каждого своя строка, которую просил
    // человек (wanted), остальные целиком берутся из того, что уже выбрано.
    // Значения, которых нет в списке CLI, не выбрасываются: уровень остаётся
    // на прежнем (том, что поставил человек), а не прыгает на первую
    // попавшуюся. Каталог CLI диктует, какие модели доступны, но не то, что
    // человек выбрал
    function renderLevels({ cli: wantedCli, gateway, provider, model: wanted }) {
        fillLevelWithAdd(selects.cli, cliValues(), '—', wantedCli, (id) => providerById(id).name);
        const cliId = selects.cli.value;
        const models = modelsFor(cliId);
        // Уровни той модели, которую просили показать, — тоже wanted: у
        // короткого имени без среднего уровня («pi/gpt-4o-mini») шлюз другой,
        // и без этого строка не нашлась бы в списке и встала бы первой по
        // чужому шлюзу. Разбор — с именем CLI: у kilo путь начинается с
        // «kilo/…», и без этого «kilo» встал бы в Gateway, а в Model уехал бы
        // путь целиком вместо имени модели
        const asked = modelLevels(wanted, cliId);
        const remembered = levelTriplet();
        // Шлюз, который человек поставил. У CLI, чей путь начинается с его
        // имени (kilo, opencode), уровня шлюза в пути нет вовсе: там у всех
        // моделей gateway пуст, и фильтровать по нему нельзя — иначе каталог
        // отсекается целиком и строка встаёт на прочерки, потеряв выбор
        const hasGateway = models.some((m) => modelLevels(m, cliId).gateway);
        const wantedGateway = gateway ?? (asked.gateway || remembered.gateway);
        const gateways = levelValues(models, null, null, (l) => l.gateway, cliId)
            .filter((value) => !HIDDEN_GATEWAYS.has(value));
        // пустым списком шлюзов строка встала бы на прочерк, поэтому в каталог
        // без шлюзов добавляется тот, что поставил человек
        if (!gateways.length && wantedGateway) gateways.push(wantedGateway);
        fillLevelWithAdd(selects.gateway, gateways, '—', wantedGateway);
        // Поставщик — уровень внутри шлюза, и помнить его между шлюзами нельзя:
        // поставщик stealth есть у openrouter и у anthropic под ним нет вовсе.
        // Раньше он всё равно возвращался в строку пунктом (keepAbsent), и на
        // anthropic строка показывала «Provider: stealth» — уровня, которого
        // под этим шлюзом нет, — а путь из него уходил в CLI целиком. Поэтому
        // поставщиком встаёт только то, что каталог называет под этим шлюзом,
        // и пустым он тоже бывает честно (у pi каталог «anthropic/claude-…»
        // вообще без среднего уровня)
        const providerValues = levelValues(models, hasGateway ? selects.gateway.value : null, null, (l) => l.provider, cliId);
        const wantedProvider = provider
            ?? (asked.provider && providerValues.includes(asked.provider) ? asked.provider : undefined)
            ?? (remembered.provider && providerValues.includes(remembered.provider) ? remembered.provider : undefined);
        fillLevel(selects.provider, providerValues, '—', wantedProvider);
        const inPath = models.filter((m) => {
            const levels = modelLevels(m, cliId);
            return levels.provider === selects.provider.value
                && (!hasGateway || levels.gateway === selects.gateway.value);
        });
        // Уровень Model в списке хранит путь целиком — так его понимает CLI, —
        // а показывает имя после последнего слэша.
        //
        // Модель переезжает вместе с поставщиком и шлюзом: сменил Gateway на
        // anthropic — модель stealth под ним и не существует, и оставить её
        // значило бы отдать CLI путь, которого в каталоге нет. Поэтому прежнее
        // имя держится, только пока оно есть в новом пути, иначе встаёт первая
        // модель оттуда. Список пуст (CLI не подключён, каталога нет) — тогда
        // остаётся прежнее имя, иначе выбор человека пропал бы до Connect
        const names = inPath.map((m) => modelLevels(m, cliId).model);
        const wantedName = [asked.model, remembered.model, names[0]].find((n) => n && names.includes(n))
            || asked.model
            || remembered.model;
        // Путь берётся из каталога целиком, а не склеивается заново: уровень
        // Model хранит путь так, как его понимает CLI, и значение, которого в
        // списке нет, ничего не значит — CLI такого пути не знает. Склейка давала
        // бы путь, которого нет ни в одном списке (и который не показывала бы
        // строка), а он и уходил в ход — тот самый случай, когда выбрано одно,
        // а отвечает другое. Каталог пуст — тогда склеиваем, иначе выбор
        // человека не пережил бы перезагрузку до Connect
        const wantedPath = inPath.find((m) => modelLevels(m, cliId).model === wantedName)
            || modelPath(cliId, selects.gateway.value, selects.provider.value, wantedName, models);
        fillLevel(selects.model, inPath, '—', wantedPath, (m) => modelLevels(m, cliId).model);
        // Выбранного значения может не оказаться в списке: у CLI, чей каталог
        // не называет этого шлюза (путь начинается с имени CLI — kilo,
        // opencode), и у неподключённого, у которого каталога нет вовсе. Такое
        // значение возвращается в уровень пунктом, иначе выбор человека пропал
        // бы с экрана и вернулся бы прочерком по reload. Уровня поставщика это
        // не касается: его список и так выведен из шлюза, и чужой поставщик в
        // нём — это ровно то значение, которого под этим шлюзом нет
        keepAbsent(selects.gateway, wantedGateway);
        keepAbsent(selects.model, wantedPath);
    }

    // Значение уровня, которого нет в списке: добавляем его пунктом обратно и
    // выбираем. Так каскад показывает и каталог CLI, и то, что выбрано, а
    // переход на другой CLI не стирает ни одну из половин выбора
    function keepAbsent(select, value) {
        if (!value || [...select.options].some((o) => o.value === value)) return;
        const option = document.createElement('option');
        option.value = value;
        option.textContent = value;
        select.append(option);
        select.value = value;
    }

    // Объявление о выборе — по любому изменению строки. CLI в списке без
    // подключения тоже объявляется: выбор уровня CLI и есть выбор, с которым
    // пойдёт ход (getActiveProviderId читает его отсюда), и молчать об
    // этом нельзя — иначе смена CLI в шапке ничего бы не меняла. Модель при
    // этом может быть и пустой: её список у неподключённого CLI ещё пуст, а
    // выбор CLI от неё не зависит.
    // Путь, собранный из показанных значений: значения уровня Model в списке
    // может не быть (каталог CLI молчит, пока не подключились), и тогда путь
    // склеивается из уровней и хвоста — той же формой, какой этот CLI
    // называет модель (см. modelPath). Этим же пользуется emit — собирать
    // путь в одном месте, иначе строка в базе и подпись в ленте разойдутся.
    // Effort в пути модели нет, но объявляется вместе с ним же: он общий для
    // трёх строк выбора, и молчал бы ровно до перерисовки любой из них
    function assembled() {
        const cliId = selects.cli.value;
        const gateway = selects.gateway.value || '';
        const provider = selects.provider.value || '';
        const tail = modelLevels(selects.model.value, cliId).model || '';
        return { gateway, provider, tail, model: modelPath(cliId, gateway, provider, tail, modelsFor(cliId)) };
    }

    function emit() {
        const chosenCli = selects.cli.value;
        if (!chosenCli) return;
        const { gateway, provider, tail, model } = assembled();
        saveLevelChoice({ gateway, provider, model: tail });
        saveEffort(selects.effort.value);
        onChange(chosenCli, model, row, selects.effort.value);
    }

    // Смена CLI не должна сбрасывать остальные уровни. Человек выбрал
    // openrouter / stealth / space-bunny-alpha, переключил CLI на kilo — и
    // ждёт тот же путь, а не прочерки и не первую попавшуюся модель нового
    // CLI. Поэтому прежние значения уровней передаются дальше как просимые,
    // а renderLevels возвращает в уровни и те, которых нет в каталоге нового
    // CLI (см. keepAbsent): каталог не решает, что выбрал человек. Уровни
    // общие на все CLI (см. levelsOf), поэтому переключение CLI ничего в них не
    // меняет — и emit после перерисовки записывает ровно то, что осталось в
    // строке
    selects.cli.addEventListener('change', () => {
        if (ignoreAdd(selects.cli)) return;
        const kept = {
            gateway: selects.gateway.value,
            provider: selects.provider.value,
            model: selects.model.value,
        };
        renderLevels({ cli: selects.cli.value, ...kept });
        emit();
    });
    // Смена уровня оставляет соседние как были: пересборка идёт от значения
    // уровня и от пути, собранного из строки, поэтому Gateway=anthropic не
    // уносит за собой Provider и Model
    for (const key of ['gateway', 'provider']) {
        selects[key].addEventListener('change', () => {
            if (ignoreAdd(selects[key])) return;
            renderLevels({ [key]: selects[key].value, model: assembled().model });
            emit();
        });
    }
    // Модель и Effort меняют только себя: пересборки не требуется, объявляется
// собранный выбор как есть
    selects.model.addEventListener('change', emit);
    selects.effort.addEventListener('change', emit);

    // какому CLI встать, когда строка получила список, но не получила выбора:
    // сперва переданный, иначе тот, у кого такая же модель, иначе первый в
    // списке
    const wantedCli = () => cli
        || (model ? cliValues().find((id) => modelOf(id) === model) : undefined)
        || cliValues()[0];
    renderLevels({ cli: wantedCli(), model });
    return row;
}

// Подписчики на смену выбора: строка в шапке сессии — единственное место, где
// модель выбирают. Ряд, из которого пришёл выбор, перерисовывать нельзя —
// select уехал бы из-под курсора, не дорисовав список, поэтому sourceRow едет
// вместе с объявлением и подписчик сверяется с ним.
const modelChoiceListeners = new Set();

export function onModelChoice(fn) {
    modelChoiceListeners.add(fn);
    return () => modelChoiceListeners.delete(fn);
}

// Выбор попадает в одно и то же: сохранённые уровни выбора (они переживают
// перезагрузку страницы), сохранённая строка модели по ключу CLI, дефолт
// провайдера и состояние подключения под ним. Дальше — объявление, чтобы
// строка в шапке увидела тот же выбор.
//
// Модель может быть пустой, и это не значит «сбрось выбор»: список моделей у
// неподключённого CLI ещё пуст, а человек уже выбрал, кем идти. Поэтому при
// пустой модели сохранённый выбор и состояние подключения не трогаются —
// затирать их было бы потерей того, что человек настраивал заранее.
// Глубина размышления (effort) — отдельный уровень строки и отдельное
// хранилище, поэтому пишется и при пустой модели, и при объявлении без неё
export function applyModelChoice(cliId, model, sourceRow, effort) {
    if (effort) saveEffort(effort);
    if (model) {
        // Уровни разбираются из строки модели обратно: строка склеена в emit
        // (modelCascadeRow) из показанных значений, поэтому хранить её одной
        // строкой означало бы, что смена одного уровня затрет остальные.
        // Разбор — с именем CLI: у kilo путь начинается с «kilo/…», и без
        // этого «kilo» записался бы в шлюз, а модель — с именем CLI в хвосте.
        // Шлюз такого пути в нём не значится, поэтому остаётся прежний — тот,
        // что поставил человек
        const asked = modelLevels(model, cliId);
        const remembered = loadLevelChoice();
        saveLevelChoice({
            gateway: asked.gateway || remembered.gateway || '',
            provider: asked.provider || '',
            model: asked.model || '',
        });
        // Строка выбранной модели под ключом CLI и поле defaultModel у
        // провайдера убраны: это был второй и третий места, где модель живёт
        // своей жизнью, и оба молча перебивали выбор из строки. Остаётся один
        // источник — уровни выше, и читает их строка выбора в шапке
        const state = connections.get(cliId);
        if (state) {
            state.model = model;
            saveProviderState(cliId);
        }
    }
    for (const listener of [...modelChoiceListeners]) listener({ cliId, model, effort, sourceRow });
}

// Объявление без выбора: список CLI с сайта обновился (SYSTEM/cli-agents.js),
// и строки, где он перечислен, надо перерисовать под новый. Отдельная функция
// вместо applyModelChoice с пустым cliId — чтобы «перерисовать всех» и «человек
// сменил выбор на пустое» не выглядели одним и тем же событием
export function publishModelChoice() {
    for (const listener of [...modelChoiceListeners]) listener({ cliId: null, model: null, sourceRow: null });
}
