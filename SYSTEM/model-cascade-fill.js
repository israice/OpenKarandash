// Наполнение уровней каскада: из каталога моделей выбранного CLI получается
// список значений для каждого уровня, и этим списком наполняется select.
//
// Отдельный файл от model-cascade.js: там сама строка выбора, её правила и её
// сохранение, здесь — как считается список одного уровня. Смешались бы в одном
// файле — и правка правил строки лезла бы в разбор каталога моделей, а он к
// строке отношения не имеет вовсе: это данные, которые отдал CLI.
//
// Рядом model-path.js (форма пути), model-add-option.js (пункт «Add») и
// model-effort.js (уровень глубины): у каждого своя часть уровня, и правило
// наполнения — тоже своя.
import { providerById } from './providers.js';
import { modelLevels } from './model-path.js';

// один уровень каскада: строки по списку, а когда списка нет — единственный
// прочерк и неактивный select. Встаёт строка, которой просил человек
// (wanted), иначе прежний выбор, если он попал в новый список, иначе первая
export function fillLevel(select, values, emptyLabel, wanted, label = (value) => value) {
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

// Значение уровня, которого нет в списке: добавляем его пунктом обратно и
// выбираем. Так каскад показывает и каталог CLI, и то, что выбрано, а переход
// на другой CLI не стирает ни одну из половин выбора.
//
// Уровень с настоящим значением не может остаться выключенным: список пуст,
// когда у CLI нет каталога (CLI не подключён), но выбор человека в уровне
// есть, и он должен быть доступен — раньше уровень оставался выключенным с
// готовым значением внутри, и список не открывался вовсе
// (DOCS/decisions/124)
export function keepAbsent(select, value) {
    if (!value || [...select.options].some((o) => o.value === value)) return;
    const option = document.createElement('option');
    option.value = value;
    option.textContent = value;
    select.append(option);
    select.value = value;
    select.disabled = false;
}

// Шлюзы, которых в меню Gateway нет: список шлюзов приходит из моделей CLI и
// там есть openai, а владелец его из меню убрал. Строка просто не
// показывается — модели openai/… в списке CLI остаются, а если выбран был
// именно этот шлюз, уровень встаёт на первый из оставшихся (fillLevel сам)
export const HIDDEN_GATEWAYS = new Set(['openai']);

// Уникальные значения одного уровня по моделям выбранного CLI. Шлюз,
// выбранный левее, сужает список; порядок остаётся тем же, в каком CLI отдал
// модели, — иначе список прыгал бы при каждой перерисовке
export function levelValues(models, gateway, take, cliId) {
    const values = [];
    for (const model of models) {
        const levels = modelLevels(model, cliId);
        if (gateway != null && levels.gateway !== gateway) continue;
        const value = take(levels);
        if (value && !values.includes(value)) values.push(value);
    }
    return values;
}

// Модели, по которым строится каскад: список, который отдал CLI, а пока его
// нет (CLI не подключён) — одна строка текущей модели, иначе строка выбора в
// шапке стояла бы на прочерках вместо выбранного значения.
//
// Текущая модель берётся здесь колбэком, а не по имени CLI: собирает путь
// modelOf в model-cascade.js, который читает сохранённые уровни, и отсюда его
// доставать нечем — уровни живут в том файле вместе со строкой, которая их
// показывает. Передача функции здесь, а не цикла импорта туда-сюда
export function modelsFor(cliId, modelOf) {
    const models = providerById(cliId).models;
    return models.length ? models : [modelOf(cliId)].filter(Boolean);
}