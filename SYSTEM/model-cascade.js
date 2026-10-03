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
    const models = providerById(cliId).models;
    return models.length ? models : [modelOf(cliId)].filter(Boolean);
};

// Четыре селекта в ряд: CLI / Gateway / Provider / Model. cliIds — какие CLI
// в них перечислять (витрина: все, карточка провайдера: только его, шапка
// сессии: подключённые), cli — каким встать уровню CLI, model — что показать
// сразу, onChange — куда попадает собранный выбор
export function modelCascadeRow({ cliIds, cli, model, onChange }) {
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

    // собранный выбор в виде, который понимает CLI: в списке моделей подпись —
    // хвост после последнего слэша, а value там целиком («openrouter/stealth/
    // space-bunny-alpha»), поэтому строка собирается сама и склеивать уровни
    // заново не надо. Читают её оттуда, где человек управляет выбором: из шапки
    // сессии (getActiveModel) и из Settings
    row.read = () => ({ cli: selects.cli.value, model: selects.model.value });

    // один проход по четырём уровням: у каждого своя строка, которую просил
    // человек (wanted), остальные целиком берутся из того, что уже выбрано
    function renderLevels({ cli: wantedCli, gateway, provider, model: wanted }) {
        fillLevel(selects.cli, cliIds, '—', wantedCli, (id) => providerById(id).name);
        const models = modelsFor(selects.cli.value);
        // уровни той модели, которую просили показать, — тоже wanted: у
        // короткого имени без среднего уровня («opencode/claude-sonnet-5»)
        // шлюз другой, и без этого строка не нашлась бы в списке и встала
        // бы первая по чужому шлюзу
        const asked = modelLevels(wanted);
        fillLevel(selects.gateway, levelValues(models, null, null, (l) => l.gateway), '—', gateway ?? asked.gateway);
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
        renderLevels({ cli: selects.cli.value, model: modelOf(selects.cli.value) });
        emit();
    });
    for (const key of ['gateway', 'provider']) {
        selects[key].addEventListener('change', () => {
            renderLevels({ [key]: selects[key].value, model: modelOf(selects.cli.value) });
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

// отдаёт провайдера, с которым сейчас реально ведётся диалог: тот, что выбран
// в строке шапки сессии, а до её появления — провайдер по умолчанию
export function getActiveProviderId() {
    if (barRow && !sessionsState.sessionBar.hidden) return barRow.read().cli;
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
