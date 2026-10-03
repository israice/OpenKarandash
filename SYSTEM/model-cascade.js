// Выбор агента и модели одним каскадом из четырёх уровней (CLI / шлюз /
// поставщик / модель) и строка этого каскада в шапке сессии. Отдельный файл от
// SYSTEM/providers.js, где лежит само состояние подключения: провайдеры,
// подключения и их сохранение. Здесь — только выбор и его отрисовка.
//
// Каскад стоит в трёх местах: витрина вверху вкладки Providers, строка под
// карточкой подключённого провайдера (обе — PROJECTS/Settings/settings.js) и
// строка выбора в шапке сессии (PROJECTS/Sessions). Все три получают одну и ту
// же строку из modelCascadeRow и пишут выбор через applyModelChoice, поэтому
// места не расходятся: смена в любом из них приходит остальным объявлением
// onModelChoice, а сохранённый выбор переживает перезагрузку страницы.
// Наружу это уходит через window.App (его собирает SYSTEM/app.js).
import {
    PROVIDERS, connections, saveProviderState, saveActiveProvider, defaultProviderId, DEFAULT_AGENT_MODEL,
} from './providers.js';
import { state as sessionsState } from '../PROJECTS/Sessions/sessions-state.js';
import { cliAgentNames, isStubCli, onCliAgents } from './cli-agents.js';

// ---------- каскад выбора модели: CLI → шлюз → поставщик → модель ----------

// Четыре выпадающих списка — это один каскад по имени модели у CLI, а не
// четыре независимых выбора: «openrouter/stealth/space-bunny-alpha» — шлюз
// openrouter (куда уходит запрос), поставщик stealth (кто за ним стоит),
// модель space-bunny-alpha. Короткое имя без среднего уровня
// («opencode/claude-sonnet-5») оставляет поставщика пустым: у него одна
// строка-прочерк и он неактивен.
//
// Места различаются только списком CLI: в карточке провайдера он один — тот,
// чья это карточка, в шапке сессии — подключённые, потому что ход пойдёт
// выбранному и неподключённым не пойдёт. Поэтому это фабрика
// modelCascadeRow, а не разметка, которую пришлось бы править трижды.

// имя модели разбирается на уровни — всё левее последнего слэша это шлюз и
// поставщик, хвост сама модель (та же мысль, что в SYSTEM/model-tag.js)
function modelLevels(model) {
    const parts = String(model || '').split('/');
    const name = parts.pop();
    return {
        gateway: parts.shift() || '',
        provider: parts.join('/'),
        model: name || '',
    };
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
// именно этот шлюз, уровень встаёт на первый из оставшихся (fillLevel сам).
const HIDDEN_GATEWAYS = new Set(['openai']);

// Пункт «Add» нижней строкой раскрытого списка CLI и Gateway. Пока это
// заглушка без логики, поэтому option отключена: в раскрытом списке строка
// видна, выбрать её нельзя, и значение каскада от неё не зависит (row.read и
// обработчики change смотрят только на выбранный CLI). Когда у пункта появится
// действие, отключение снимается, а обработчик вешается рядом с остальными в
// modelCascadeRow. Значение-заглушка отдельное от значений уровней, чтобы
// пункт не совпал с настоящим шлюзом или агентом, даже если кто-то назовёт его
// add
const ADD_OPTION = { value: '::add', label: 'Add' };

function appendAddOption(select) {
    const option = document.createElement('option');
    option.value = ADD_OPTION.value;
    option.textContent = ADD_OPTION.label;
    option.disabled = true;
    select.append(option);
}

function providerById(id) {
    return PROVIDERS.find((p) => p.id === id) || { id, name: id, models: [], defaultModel: null };
}

// Выбор человека живёт под своим ключом на каждого CLI и переживает
// перезагрузку страницы. Отдельное хранилище нужно потому, что каскад виден
// и до подключения, когда состояния провайдера ещё нет (а оно и есть то,
// что подхватывает строка выбора в шапке сессии). Пока ключа нет — встаёт
// дефолтная строка проекта openrouter/stealth/space-bunny-alpha
// (DEFAULT_AGENT_MODEL из providers.js): при первом заходе человек видит
// именно её
const MODEL_KEYS = { opencode: 'noname.model.opencode' };
const modelKey = (cliId) => MODEL_KEYS[cliId] || `noname.model.${cliId}`;

export function saveModelChoice(cliId, model) {
    try {
        if (model) localStorage.setItem(modelKey(cliId), model);
        else localStorage.removeItem(modelKey(cliId));
    } catch {
        // приватный режим или запрет на хранилище — работаем без сохранения
    }
}

function loadModelChoice(cliId) {
    try {
        return localStorage.getItem(modelKey(cliId)) || '';
    } catch {
        return '';
    }
}

// Модель, которой сейчас отвечает CLI: сохранённый выбор человека, иначе
// состояние подключения, иначе дефолтная строка проекта. Список моделей у
// OpenCode до Connect пуст, поэтому каскад строится по этой одной строке, а
// не пустеет
export const modelOf = (cliId) => loadModelChoice(cliId)
    || connections.get(cliId)?.model
    || providerById(cliId).defaultModel
    || DEFAULT_AGENT_MODEL
    || '';

// уникальные значения одного уровня по моделям выбранного CLI. Шлюз и
// поставщик, выбранные левее, сужают список; порядок остаётся тем же, в каком
// CLI отдал модели, — иначе список прыгал бы при каждой перерисовке
function levelValues(models, gateway, provider, take) {
    const values = [];
    for (const model of models) {
        const levels = modelLevels(model);
        if (gateway != null && levels.gateway !== gateway) continue;
        if (provider != null && levels.provider !== provider) continue;
        const value = take(levels);
        if (value && !values.includes(value)) values.push(value);
    }
    return values;
}

// Модели, по которым строится каскад: список, который отдал CLI, а пока его
// нет (провайдер не подключён) — одна строка текущей модели, иначе витрина
// была бы тремя прочерками вместо выбранного значения
const modelsFor = (cliId) => {
    // Пункт списка без своего коннектора (см. cliValues в modelCascadeRow):
    // моделей у него нет, и выдумывать ему чужую строку нельзя — уровни
    // остаются прочерками
    if (isStubChoice(cliId)) return [];
    const models = providerById(cliId).models;
    return models.length ? models : [modelOf(cliId)].filter(Boolean);
};

// Пункт списка OpenRouter без своего коннектора. Настоящий CLI всегда остаётся
// настоящим, даже если его название совпало с чужим из списка: список не имеет
// права выкинуть из каскада того, за кем мы умеем ходить
const isStubChoice = (id) => !!id && !PROVIDERS.some((p) => p.id === id) && isStubCli(id);

// Четыре селекта в ряд: CLI / Gateway / Provider / Model. cliIds — какие CLI
// в них перечислять (витрина: все, карточка провайдера: только его, шапка
// сессии: подключённые), cli — каким встать уровню CLI, model — что показать
// сразу, onChange — куда попадает собранный выбор, addOption — дописать ли
// вниз списков CLI и Gateway пункт «Add» (шапка сессии; в Settings его нет),
// stubOptions — дописать ли вниз списка CLI весь список агентов с OpenRouter
// (SYSTEM/cli-agents.js, тот же, что на странице «New projects»). Этот список
// нужен везде, где строка перечисляет всех: витрина и шапка сессии; в карточке
// одного провайдера он лишний, там перечислять нечего кроме него самого, и
// строку та заводят без stubOptions
export function modelCascadeRow({ cliIds, cli, model, onChange, addOption = false, stubOptions = true }) {
    const row = document.createElement('div');
    row.className = 'provider__model provider__model--cascade';
    const selects = {};
    for (const [key, title] of [['cli', 'CLI'], ['gateway', 'Gateway'], ['provider', 'Provider'], ['model', 'Model']]) {
        const label = document.createElement('span');
        label.className = 'provider__model-label';
        label.textContent = `${title}:`;
        const select = document.createElement('select');
        select.className = 'provider__select provider__select--source';
        select.setAttribute('aria-label', title);
        row.append(label, select);
        selects[key] = select;
    }

    // Значения уровня CLI: настоящие CLI, какие этой строке полагается
    // перечислять, и под ними весь список с OpenRouter — тем же, что на
    // странице «New projects». Своего коннектора у этих пунктов пока нет: за
    // пунктом не стоит ни моделей, ни подключения, поэтому он не доходит до
    // каскада (модель у него пустая, emit молчит) и ход по нему не пойдёт —
    // getActiveProviderId такие значения отбрасывает. По умолчанию выбран
    // первый настоящий CLI, то есть OpenCode
    const cliValues = () => (stubOptions ? [...new Set([...cliIds, ...cliAgentNames()])] : [...cliIds]);
    // Пункт без коннектора — по этой строке, и никакая модель ему не показывается
    const isStub = (id) => isStubChoice(id) && !cliIds.includes(id);
    // Модель, которую уровни показывают для выбранного CLI: у пункта без
    // коннектора её нет вовсе
    const wantedModel = (cliId) => (isStub(cliId) ? '' : modelOf(cliId));

    // Уровень с пунктом «Add» внизу: сам уровень наполняется общим fillLevel,
    // а пункт дописывается заново при каждой перерисовке (fillLevel чистит
    // option'ы). Сейчас это два верхних уровня — CLI и Gateway, где появляется
    // новое; Provider и Model остаются чистыми. Заодно запоминаем последнее
    // настоящее значение уровня — им уровень возвращается, если значение
    // подменили (см. ignoreAdd)
    const realValue = new Map();
    function fillLevelWithAdd(select, values, emptyLabel, wanted, label) {
        fillLevel(select, values, emptyLabel, wanted, label);
        realValue.set(select, select.value);
        if (addOption) appendAddOption(select);
    }

    // Значение заглушки не доходит до каскада: уровень молча возвращается на
    // прежнее настоящее значение. Отключённый пункт выбрать нельзя, но
    // подменить значение селекта можно (будущий обработник пункта, чужой код,
    // autofill браузера) — и без этой проверки уровень уехал бы вниз, а за ним
    // перерисовались бы поставщик и модель, то есть выбор человека сменился бы
    // сам собой. Возвращает true, когда значение было заглушкой.
    function ignoreAdd(select) {
        if (select.value !== ADD_OPTION.value) return false;
        const back = realValue.get(select);
        const usable = [...select.options].some((o) => o.value === back && !o.disabled);
        if (usable) select.value = back;
        return true;
    }

    // собранный выбор в виде, который понимает CLI: в списке моделей подпись —
    // хвост после последнего слэша, а value там целиком («openrouter/stealth/
    // space-bunny-alpha»), поэтому строка собирается сама и склеивать уровни
    // заново не надо. Читают её оттуда, где человек управляет выбором: из шапки
    // сессии (getActiveModel) и из Settings
    row.read = () => ({ cli: selects.cli.value, model: selects.model.value });

    // один проход по четырём уровням: у каждого своя строка, которую просил
    // человек (wanted), остальные целиком берутся из того, что уже выбрано
    function renderLevels({ cli: wantedCli, gateway, provider, model: wanted }) {
        fillLevelWithAdd(selects.cli, cliValues(), '—', wantedCli, (id) => (isStubChoice(id) ? id : providerById(id).name));
        const models = modelsFor(selects.cli.value);
        // уровни той модели, которую просили показать, — тоже wanted: у
        // короткого имени без среднего уровня («opencode/claude-sonnet-5»)
        // шлюз другой, и без этого строка не нашлась бы в списке и встала
        // бы первая по чужому шлюзу
        const asked = modelLevels(wanted);
        const gateways = levelValues(models, null, null, (l) => l.gateway)
            .filter((value) => !HIDDEN_GATEWAYS.has(value));
        fillLevelWithAdd(selects.gateway, gateways, '—', gateway ?? asked.gateway);
        fillLevel(selects.provider, levelValues(models, selects.gateway.value, null, (l) => l.provider), '—', provider ?? asked.provider);
        const inPath = models.filter((m) => {
            const levels = modelLevels(m);
            return levels.gateway === selects.gateway.value && levels.provider === selects.provider.value;
        });
        // модели в списке — целиком, иначе выбор не собрать обратно в строку,
        // которую понимает CLI; подпись — короткое имя после последнего слэша
        fillLevel(selects.model, inPath, '—', wanted, (m) => modelLevels(m).model);
    }

    function emit() {
        const { cli: chosenCli, model: chosen } = row.read();
        if (chosen) onChange(chosenCli, chosen, row);
    }

    selects.cli.addEventListener('change', () => {
        if (ignoreAdd(selects.cli)) return;
        renderLevels({ cli: selects.cli.value, model: wantedModel(selects.cli.value) });
        emit();
    });
    for (const key of ['gateway', 'provider']) {
        selects[key].addEventListener('change', () => {
            if (ignoreAdd(selects[key])) return;
            renderLevels({ [key]: selects[key].value, model: wantedModel(selects.cli.value) });
            emit();
        });
    }
    selects.model.addEventListener('change', emit);

    renderLevels({ cli: cli ?? (model ? cliIds.find((id) => modelOf(id) === model) : undefined), model });
    return row;
}

// Подписчики на смену выбора: строка в шапке сессии и оба ряда в Settings.
// Ряд, из которого пришёл выбор, перерисовывать нельзя — select уехал бы из-под
// курсора, не дорисовав список, поэтому sourceRow едет вместе с объявлением и
// подписчик сверяется с ним.
const modelChoiceListeners = new Set();

export function onModelChoice(fn) {
    modelChoiceListeners.add(fn);
    return () => modelChoiceListeners.delete(fn);
}

// Выбор из любого из трёх мест попадает в одно и то же: сохранённый ключ CLI
// (он переживает перезагрузку страницы), сам дефолт провайдера и состояние
// подключения под ним. Дальше — объявление, чтобы остальные места увидели
// тот же выбор
export function applyModelChoice(cliId, model, sourceRow) {
    saveModelChoice(cliId, model);
    // дефолт пишется всегда, и до Connect тоже: список моделей приходит от
    // CLI только при подключении, а выбрать модель можно и раньше
    // (connectOpenCode и refreshConnectedModels в settings.js бережно
    // сохраняют этот выбор, если он есть в свежем списке от CLI)
    providerById(cliId).defaultModel = model;
    const state = connections.get(cliId);
    if (state) {
        state.model = model;
        saveProviderState(cliId);
    }
    for (const listener of [...modelChoiceListeners]) listener({ cliId, model, sourceRow });
}

// ---------- строка выбора в шапке сессии ----------

// Текущая отрисовка каскада в шапке и CLI, выбранный в нём последним: строка
// перерисовывается на каждую смену сессии, и без этой памяти выбранный в шапке
// CLI каждый раз возвращался бы к провайдеру по умолчанию
let barRow = null;
let barCliId = null;

export function renderSessionBarControls() {
    const bar = sessionsState.sessionBar;
    if (!bar) return;

    const ids = PROVIDERS.filter((p) => connections.has(p.id)).map((p) => p.id);
    // строка выбора видна, как только подключён хотя бы один провайдер, и до
    // создания самой сессии — так пользователь настраивает параметры заранее
    bar.hidden = ids.length === 0 || sessionsState.sessionList.hidden;
    bar.innerHTML = '';
    barRow = null;
    if (ids.length === 0) return;

    const chosen = ids.includes(barCliId) ? barCliId : defaultProviderId();
    barCliId = ids.includes(chosen) ? chosen : ids[0];
    barRow = modelCascadeRow({
        cliIds: ids,
        cli: barCliId,
        model: modelOf(barCliId),
        // вниз списков CLI и Gateway — строка «Add», заглушка без действия
        addOption: true,
        onChange: (cliId, model, sourceRow) => {
            // выбор уровня CLI в шапке — это и есть выбор, с которым пойдёт ход
            // (getActiveProviderId читает его отсюда), поэтому он же становится
            // активным провайдером: без этого строка после перезагрузки вернула
            // бы прежнего, а ход пошёл бы иначе
            barCliId = cliId;
            saveActiveProvider(cliId);
            applyModelChoice(cliId, model, sourceRow);
        },
    });
    bar.append(barRow);
}

// Смена выбора в настройках перерисовывает строку шапки (и наоборот). Ряд, из
// которого выбор пришёл, не трогаем — как и в Settings, где так же ведут себя
// оба своих каскада.
onModelChoice(({ sourceRow }) => {
    if (sourceRow === barRow) return;
    renderSessionBarControls();
});

// Список агентов с OpenRouter обновился (проверка на сайте) — строки, где он
// перечислен, перерисовываются под новый. Объявляем тем же порядком, что и смену
// модели (sourceRow пустой — значит, перерисовать все ряды, включая те, что в
// Settings, и они об этом объявлении знают)
onCliAgents(() => {
    for (const listener of [...modelChoiceListeners]) listener({ cliId: null, model: null, sourceRow: null });
});

// отдаёт провайдера, с которым сейчас реально ведётся диалог: тот, что выбран
// в строке шапки сессии, а до её появления — провайдер по умолчанию
export function getActiveProviderId() {
    if (barRow && !sessionsState.sessionBar.hidden) {
        const cli = barRow.read().cli;
        // пункт списка без коннектора (см. cliValues в modelCascadeRow) ходом
        // не пойдёт, поэтому диалог остаётся за последним настоящим
        if (cli && !isStubChoice(cli)) return cli;
    }
    return defaultProviderId();
}

// модель, которой пойдёт следующий ход, — собранный выбор строки шапки: выбор
// в ней настоящий (см. обработчик change в modelCascadeRow). Ею подписывается
// ответ в ленте, пока он стримится (SYSTEM/model-tag.js); у строк, уже лежащих
// в базе, подпись берётся из их собственного поля model
export function getActiveModel() {
    if (barRow && !sessionsState.sessionBar.hidden) {
        const model = barRow.read().model;
        if (model) return model;
    }
    return connections.get(getActiveProviderId())?.model || null;
}
