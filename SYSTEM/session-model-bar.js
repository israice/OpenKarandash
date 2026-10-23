// Строка выбора CLI, модели и глубины размышления в шапке сессии: то, что
// человек видит над чатом, и то, чем пойдёт следующий ход.
//
// Живёт отдельно от самого каскада (SYSTEM/model-cascade.js), потому что это
// разные вещи: каскад — четыре выпадающих списка и правила их заполнения, а
// здесь — экземпляр строки в шапке, память о выбранном CLI и три чтения, по
// которым весь проект узнаёт, кто, с какой моделью и на какой глубине будет
// работать. Смешались бы они в один файл — и правка правил каскада лезла бы в
// шапку сессии.
//
// Слово из уровня CLI — единственный источник истины о том, кем пойдёт ход.
// Оно не зависит от того, подключён этот CLI или нет: подключение ход
// восстанавливает сам (ensureConnected в SYSTEM/app.js), потому что список CLI
// приходит с сайта и меняется, а ждать, пока человек нажмёт Connect в
// настройках, не должен ни один выбор.
import { state as sessionsState } from '../PROJECTS/Sessions/sessions-state.js';
import { saveActiveProvider, loadActiveProvider, providerById } from './providers.js';
import {
    modelCascadeRow, applyModelChoice, modelOf, onModelChoice, publishModelChoice,
} from './model-cascade.js';
import { onCliAgents, cliLevelNames } from './cli-agents.js';
import { initCliScan } from './cli-scan.js';

// Текущая отрисовка каскада в шапке и CLI, выбранный в нём последним: строка
// перерисовывается на каждую смену сессии, и без этой памяти выбранный в шапке
// CLI каждый раз возвращался бы к провайдеру по умолчанию
let barRow = null;
let barCliId = null;

export function renderSessionBarControls() {
    const bar = sessionsState.sessionBar;
    if (!bar) return;

    // Строка видна всегда, пока виден список сессий: выбрать, кем работать,
    // можно и до подключения — ход подключит сам. Раньше строка появлялась
    // только после Connect, и выбрать было нечего, пока не подключишь кого-то
    // одного
    bar.hidden = sessionsState.sessionList.hidden;
    bar.innerHTML = '';
    barRow = null;
    if (bar.hidden) return;

    // Какие CLI строка считает своими: те, что назвал сайт, плюс выбранный
    // последним (даже если он сейчас не подключён — иначе перерисовка строки
    // вернула бы уровень CLI на первый в списке и ход пошёл бы не туда)
    const ids = cliLevelNames(barCliId ? [barCliId] : []);
    // Пока строка не перерисована, выбранного CLI в ней нет — берём его из того
    // же хранилища, куда строка пишет выбор сама (saveActiveProvider в onChange
    // ниже). Это не второй источник, а тот же выбор, переживший перезагрузку
    // страницы: без него уровень CLI после reload вставал бы на первое слово
    // из списка сайта, то есть ход пошёл бы не тем, кого человек выбрал
    if (!barCliId) barCliId = loadActiveProvider() || '';
    // Выбранный CLI возвращается в список, даже если сайт его не назвал: список
    // с сайта меняется, а человек уже выбрал это имя, и молча переставить его на
    // первый в списке — значит отдать ход не тем CLI, которого он выбрал. Раньше
    // здесь стояло `barCliId = ids[0]`, то есть имя дописывалось в список и
    // следом же затиралось им первым: в строке оказывался opencode, а в
    // noname.activeProvider оставалось прежнее имя — строка показывала одно, а
    // ход пошёл бы по сохранённому (проверено живьём)
    if (barCliId && !ids.includes(barCliId)) ids.push(barCliId);
    if (!barCliId) barCliId = ids[0] || '';

    // Что из этого списка есть на машине (SYSTEM/cli-scan.js): уровень CLI красит
    // доступные пункты зелёным, а несуществующие гасит. Разведка идёт тем же
    // списком имён, каким наполнен уровень, — иначе строка красила бы по одному
    // списку, а перечисляла по другому. Первый ответ приходит из хранилища (чтобы
    // список не мигал серым до похода на сервер), настоящий — следом
    initCliScan(ids);

    barRow = modelCascadeRow({
        cliIds: ids,
        cli: barCliId,
        model: modelOf(barCliId),
        // вниз списков CLI и Gateway — строка «Add», заглушка без действия
        addOption: true,
        onChange: (cliId, model, sourceRow, effort) => {
            // выбор уровня CLI в шапке — это и есть выбор, с которым пойдёт ход
            // (getActiveProviderId читает его отсюда), поэтому он же становится
            // активным провайдером: без этого строка после перезагрузки вернула
            // бы прежнего, а ход пошёл бы иначе
            const cliChanged = cliId !== barCliId;
            barCliId = cliId;
            saveActiveProvider(cliId);
            applyModelChoice(cliId, model, sourceRow, effort);
            // Каталог моделей приходит от самого CLI, а у неподключённого CLI его
            // нет: список Model пуст, и выбрать модель не из чего — список выбора
            // молча мёртв. Подключение делает ход (ensureConnected), но ход — это
            // уже после выбора, а человек меняет CLI именно затем, чтобы выбрать
            // модель. Поэтому при смене CLI каталог берём сразу: то же
            // подключение, что и перед ходом, только раньше. Каталог пришёл —
            // строка перерисовалась сама (ensureConnected зовёт
            // renderSessionBarControls), и выбор в ней сохранился
            if (cliChanged) fillCatalog(cliId);
        },
    });
    bar.append(barRow);
    // Каталог выбранного CLI в клиенте живёт только до перезагрузки страницы:
    // в localStorage лежит подключение (цель, версия), а список моделей — нет,
    // и после перезагрузки он пуст. Уровни Gateway и Model без каталога стоят
    // пустыми, а выбрать из них нечего — поэтому пустой каталог берём сразу,
    // тем же подключением, что и перед ходом
    if (barCliId && !providerById(barCliId).models.length) fillCatalog(barCliId);
}

// Каталог моделей выбранного CLI: то же подключение, что и перед ходом
// (ensureConnected в SYSTEM/app.js — из window.App, прямой импорт дал бы круг
// app.js ↔ session-model-bar.js). Ошибка тут не беда: список останется пустым,
// а ход разберётся и скажет, что CLI недоступен
//
// Один раз на CLI за страницу: строка перерисовывается часто, а у CLI без
// каталога (OpenClaw, Cline) его не будет никогда — и каждый перерисовка
// звал бы сервер
const askedCatalog = new Set();

function fillCatalog(cliId) {
    if (!cliId || !sessionsState.sessionId || askedCatalog.has(cliId)) return;
    askedCatalog.add(cliId);
    try {
        Promise.resolve(App.ensureConnected(cliId))
            .then((connection) => {
                if (!connection) askedCatalog.delete(cliId);
            })
            .catch(() => {
                askedCatalog.delete(cliId);
            });
    } catch {
        askedCatalog.delete(cliId);
    }
}

// Перерисовка под новый список агентов с сайта (publishModelChoice) и под
// смену выбора в самой строке: ряд, из которого выбор пришёл, не трогаем —
// select уехал бы из-под курсора, не дорисовав список
onModelChoice(({ sourceRow }) => {
    if (sourceRow === barRow) return;
    renderSessionBarControls();
});

// Список агентов с OpenRouter обновился (проверка на сайте) — уровень CLI
// перечисляет его, поэтому строка перерисовывается под новый список
onCliAgents(publishModelChoice);

// отдаёт CLI, с которым сейчас реально ведётся диалог: тот, что выбран в
// строке шапки сессии, и только его. Запасного чтения (активный провайдер,
// первый подключённый) здесь нет намеренно: оно отвечало на тот же вопрос из
// другого места, и строка в шапке показывала одно, а ход уходил другим.
// Пока строка не нарисована, выбора ещё не было — и ход без него начинаться не
// должен, о чём sendTurn честно сообщает (SYSTEM/session-model-bar.js)
export function getActiveProviderId() {
    if (!barRow || sessionsState.sessionBar.hidden) return '';
    return barRow.read().cli || '';
}

// модель, которой пойдёт следующий ход, — ровно то значение, которое стоит в
// уровне Model строки шапки, и больше ниоткуда. Уровень хранит путь целиком
// («openrouter/stealth/space-bunny-alpha»), каким его понимает CLI, поэтому
// склеивать путь заново не надо — иначе строка и ход разъедутся. Раньше здесь
// был запасной путь из состояния подключения, а в самом пути шлюз терялся:
// при двух уровнях (шлюз и модель, без поставщика) уходило одно имя модели,
// и CLI отвечала моделью с тем же именем у другого шлюза (см. modelPath)
export function getActiveModel() {
    if (!barRow || sessionsState.sessionBar.hidden) return '';
    return barRow.read().model || '';
}

// глубина размышления, на которой пойдёт следующий ход, — тем же выбором, что
// и модель: строка в шапке одна на оба значения (SYSTEM/model-cascade.js). В
// базу она уходит полем effort у строки хода (SYSTEM/core/sessions-db-schema.js)
export function getActiveEffort() {
    if (!barRow || sessionsState.sessionBar.hidden) return '';
    return barRow.read().effort || '';
}
