// Строка выбора CLI, модели и глубины размышления в шапке сессии: то, что
// человек видит над чатом, и то, чем пойдёт следующий ход.
//
// Живёт отдельно от самого каскада (SYSTEM/model-cascade.js), потому что это
// разные вещи: каскад — пять выпадающих списков и правила их заполнения, а
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
import { saveActiveProvider, loadActiveProvider } from './providers.js';
import {
    modelCascadeRow, applyModelChoice, modelOf, onModelChoice, publishModelChoice,
} from './model-cascade.js';
import { onCliAgents, cliLevelNames } from './cli-agents.js';

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
    if (!barCliId || !ids.includes(barCliId)) {
        if (barCliId) ids.push(barCliId);
        barCliId = ids[0] || '';
    }

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
            barCliId = cliId;
            saveActiveProvider(cliId);
            applyModelChoice(cliId, model, sourceRow, effort);
        },
    });
    bar.append(barRow);
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
