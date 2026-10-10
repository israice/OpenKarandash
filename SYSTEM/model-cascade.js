// Каскад выбора модели: четыре уровня (CLI / шлюз / модель / глубина
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
import { modelLevels, modelPath, cliShortName, gatewayNameOf } from './model-path.js';
import { levelWithAdd, ignoreAdd } from './model-add-option.js';
import { fillEffortLevel, saveEffort } from './model-effort.js';
import { fillLevel, levelValues, HIDDEN_GATEWAYS, modelsFor } from './model-cascade-fill.js';
import { markCliLevel, watchCliLevel, remarkCliLevels } from './cli-mark.js';
import { scanMarkOf, onCliScan } from './cli-scan.js';

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

// Провайдер по имени CLI берётся из providers.js: запись заводится там по
// требованию, поэтому у kilo или omp она есть уже при первом показе строки

// Каталог, по которому строится каскад (model-cascade-fill.js). Сборщик пути
// передаётся отсюда: он читает сохранённые уровни, а те живут в этом файле
const modelsOf = (cliId) => modelsFor(cliId, modelOf);

// Четыре селекта в ряд: CLI / Gateway / Model / Effort. Поставщика отдельным
// списком нет: это средний уровень пути модели, и человек выбирал не его, а
// модель целиком. Своим списком он показывал то, чего под выбранным шлюзом нет
// (поставщика stealth у anthropic не бывает вовсе), и выбор разъезжался на две
// строки: показанная пара «Provider / Model» не была ни одной настоящей
// моделью шлюза. Теперь список Model — это модели выбранного шлюза, какими их
// отдал CLI, а подпись пункта — путь без головы (шлюза или имени CLI), чтобы
// совпадающие имена у разных поставщиков не сливались.
// cliIds — какие
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
    for (const [key, title] of [['cli', 'CLI'], ['gateway', 'Gateway'], ['model', 'Model'], ['effort', 'Effort']]) {
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

    // Уровень CLI помечается тем, что известно о каждом имени на этой машине
    // (SYSTEM/cli-scan.js): установленный и отвечающий пункт получает зелёный
    // фон, несуществующий остаётся приглушённым, и выбор становится читаемым без
    // попытки. Пункт при этом остаётся выбираемым — человека не должно лишать
    // выбора имя, которое он прямо сейчас собирается поставить
    watchCliLevel(selects.cli, scanMarkOf);

// Уровень с пунктом «Add» внизу наполняется через levelWithAdd: сейчас это
// два верхних уровня — CLI и Gateway, где появляется новое; Model и
    // Effort остаются чистыми. Заглушка и возврат с неё — в model-add-option.js
const fillLevelWithAdd = (select, values, emptyLabel, wanted, label) =>
        levelWithAdd(select, () => fillLevel(select, values, emptyLabel, wanted, label), addOption);

// собранный выбор в виде, который понимает CLI: в списке моделей подпись —
    // путь без головы («stealth/space-bunny-alpha»), а value там целиком
    // («openrouter/stealth/space-bunny-alpha»), поэтому строка читается сама и
    // склеивать уровни заново не надо. Effort в пути модели нет — он уходит
    // отдельным флагом хода, поэтому читается рядом с ним. Читает её оттуда,
    // где человек управляет выбором: из шапки сессии (getActiveModel и
    // getActiveEffort)
    row.read = () => ({
        cli: selects.cli.value,
        model: selects.model.value,
        effort: selects.effort.value,
    });
    // один проход по уровням: у каждого своя строка, которую просил человек
    // (wanted), остальные целиком берутся из того, что уже выбрано. Значения,
    // которых нет в списке CLI, не выбрасываются: уровень остаётся на прежнем
    // (том, что поставил человек), а не прыгает на первую попавшуюся. Каталог
    // CLI диктует, какие модели доступны, но не то, что человек выбрал
    function renderLevels({ cli: wantedCli, gateway, model: wanted }) {
        fillLevelWithAdd(selects.cli, cliValues(), '—', wantedCli, (id) => providerById(id).name);
        // наполнитель создаёт option'ы заново, поэтому пометка нужна после каждой
        // перерисовки уровня, а не один раз на строку: иначе зелёным осталось бы
        // только то, что было помечено при первом показе
        markCliLevel(selects.cli, scanMarkOf);
        const cliId = selects.cli.value;
        const models = modelsOf(cliId);
        // Уровни той модели, которую просили показать, — тоже wanted: у
        // короткого имени без среднего уровня («pi/gpt-4o-mini») шлюз другой,
        // и без этого строка не нашлась бы в списке и встала бы первой по
        // чужому шлюзу. Разбор — с именем CLI: у kilo путь начинается с
        // «kilo/…», и без этого «kilo» встал бы в Gateway, а в Model уехал бы
        // путь целиком вместо имени модели
        const asked = modelLevels(wanted, cliId);
        const remembered = levelTriplet();
        // Шлюз, который человек поставил, и список шлюзов, какие есть у этого
        // CLI на самом деле. Считаются они одной функцией (gatewayNameOf): у
        // модели, путь которой начинается с имени самого CLI (opencode/…,
        // kilo/…), шлюза в пути нет, и в списке шлюзов такой модели отвечает
        // имя этого CLI. Раньше она в список не попадала вовсе — значение пустое,
        // а пустые уровни в список не идут, — и вместе с ней исчезали и её
        // модели: у opencode это его собственные бесплатные, до которых после
        // появления чужих шлюзов было не добраться вовсе.
        const ownGateway = cliShortName(cliId);
        const gatewayOf = (path) => gatewayNameOf(path, cliId);
        const wantedGateway = gateway ?? (asked.gateway || remembered.gateway);
        const gateways = levelValues(models, null, (l) => l.gateway, cliId)
            .filter((value) => !HIDDEN_GATEWAYS.has(value));
        // Модели самого CLI — первый пункт списка шлюзов: у каталога с чужими
        // шлюзами они тоже есть (у opencode — свои бесплатные), и без
        // отдельного пункта до них не добраться, потому что фильтр шлюза их
        // отсекал
        const hasOwnModels = models.some((m) => !modelLevels(m, cliId).gateway);
        if (hasOwnModels && !gateways.includes(ownGateway)) gateways.unshift(ownGateway);
        // пустым списком шлюзов строка встала бы на прочерк, поэтому в каталог
        // без шлюзов добавляется тот, что поставил человек
        if (!gateways.length && wantedGateway) gateways.push(wantedGateway);
        fillLevelWithAdd(selects.gateway, gateways, '—', wantedGateway);
        // Список Model — это каталог CLI, сужённый до выбранного шлюза, и
        // ничего больше: у антропика поставщика нет вовсе, а у openrouter их
        // несколько, и отдельный список поставщика показывал уровень, которого
        // под половиной шлюзов не существует. Значение пункта — путь целиком
        // (его и отдаёт CLI), а подпись — путь без головы: у openrouter идёт
        // «stealth/space-bunny-alpha», у pi, где поставщика нет, — просто
        // «claude-fable-5». Одинаковые имена у разных поставщиков подписью
        // различаются, а склеивать их в одно значение нельзя — у CLI это разные
        // модели
        const inPath = models.filter((m) => gatewayOf(m) === (selects.gateway.value || ownGateway));
        const modelLabel = (path) => {
            const levels = modelLevels(path, cliId);
            return [levels.provider, levels.model].filter(Boolean).join('/');
        };
        // Модель переезжает вместе со шлюзом: сменил Gateway на anthropic —
        // модель stealth под ним и не существует, и оставить её значило бы
        // отдать CLI путь, которого в каталоге нет. Поэтому прежний выбор
        // держится, только пока он есть в новом списке (поиск идёт и по полному
        // пути, и по имени модели — при смене CLI путь меняется, а имя
        // остаётся), иначе встаёт первая модель оттуда. Список пуст (CLI не
        // подключён, каталога нет) — тогда путь склеивается из уровней, иначе
        // выбор человека пропал бы до Connect
        const wantedPath = inPath.find((m) => m === wanted)
            || inPath.find((m) => modelLevels(m, cliId).model === (remembered.model || asked.model))
            || inPath[0]
            || modelPath(cliId, selects.gateway.value, asked.provider || remembered.provider,
                asked.model || remembered.model, models);
        fillLevel(selects.model, inPath, '—', wantedPath, modelLabel);
        // Шлюз, который человек поставил, в списке нового CLI может не
        // оказаться: переключил CLI — а у него своего шлюза с таким именем нет.
        // Раньше такое значение возвращалось в уровень пунктом, и строка
        // показывала рядом шлюз, которого у CLI нет, и модели уже другого
        // шлюза (список считался до того, как уровень дописывали). Теперь
        // шлюзов без каталога не бывает: у неподключённого CLI список пуст, и
        // тогда прежнее имя добавляется в него строкой выше, а строка встаёт на
        // первый настоящий шлюз CLI — как и сказано у HIDDEN_GATEWAYS
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
    // Модель уходит в ход ровно тем значением, которое стоит в уровне Model, —
    // путём целиком, каким его понимает CLI, — и уровни выбора разбираются из
    // него же (applyModelChoice ниже): сохранённое тогда совпадает с
    // показанным. Склеивать путь заново здесь нельзя: modelPath подставляет
    // голову по форме каталога, и у CLI, чьё имя есть среди его же моделей
    // (opencode, kilo), путь вышел бы другим, чем тот, что человек видит в
    // строке и который уходит в ход.
    // Effort в пути модели нет, но объявляется вместе с ним же
    function emit() {
        const chosenCli = selects.cli.value;
        if (!chosenCli) return;
        const model = selects.model.value;
        // Уровни пишутся только через applyModelChoice (onChange ниже), и она же
        // сторожит пустую модель: когда список моделей у CLI не пришёл (CLI не
        // подключён), значение уровня пустое, и прямая запись здесь стирала бы
        // сохранённый выбор человека — каскад вставал на прочерки, Model
        // блокировался, и выбрать было нечего. Уровни сохранённого выбора
        // трогать нельзя, когда выбора на экране нет
        saveEffort(selects.effort.value);
        onChange(chosenCli, model, row, selects.effort.value);
    }

    // Смена CLI не должна сбрасывать остальные уровни. Человек выбрал
    // openrouter / space-bunny-alpha, переключил CLI на kilo — и ждёт тот же
    // путь, а не прочерки и не первую попавшуюся модель нового CLI. Поэтому
    // прежние значения уровней передаются дальше как просимые, а renderLevels
    // возвращает в уровни и те, которых нет в каталоге нового CLI (см.
    // keepAbsent): каталог не решает, что выбрал человек. Уровни общие на все
    // CLI (см. levelsOf), поэтому переключение CLI ничего в них не меняет — и
    // emit после перерисовки записывает ровно то, что осталось в строке
    selects.cli.addEventListener('change', () => {
        if (ignoreAdd(selects.cli)) return;
        const kept = {
            gateway: selects.gateway.value,
            model: selects.model.value,
        };
        renderLevels({ cli: selects.cli.value, ...kept });
        emit();
    });
    // Смена шлюза оставляет Effort как был: пересборка идёт от значения уровня и
    // от пути, который стоял в строке, поэтому Gateway=anthropic не уносит с
    // собой Effort, а Model встаёт той, что каталог называет под новым шлюзом
    selects.gateway.addEventListener('change', () => {
        if (ignoreAdd(selects.gateway)) return;
        renderLevels({ gateway: selects.gateway.value, model: selects.model.value });
        emit();
    });
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
        // Уровни разбираются из значения уровня Model обратно: это тот же путь,
        // который стоит в строке и уходит в ход, поэтому сохранённое совпадает с
        // показанным. Хранить его одной строкой означало бы, что смена одного
        // уровня затрёт остальные.
        // Разбор — с именем CLI: у kilo путь начинается с «kilo/…», и без
        // этого «kilo» записался бы в шлюз, а модель — с именем CLI в хвосте.
        // Шлюз берётся тем же чтением, каким его показывает строка
        // (gatewayNameOf): у модели самого CLI шлюза в пути нет, и разбор по
        // уровням оставлял бы прежний шлюз — выбрал «opencode», а после
        // перезагрузки строка встала бы на прежний openrouter. Прежний шлюз
        // остаётся только на случай пути, который этой форме не отвечает вовсе
        const asked = modelLevels(model, cliId);
        const remembered = loadLevelChoice();
        saveLevelChoice({
            gateway: gatewayNameOf(model, cliId) || remembered.gateway || '',
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

// Разведка машины ответила (SYSTEM/cli-scan.js) — обновить вид пунктов CLI на
// уже нарисованных уровнях. Строку не перерисовываем: она сбросила бы уровни на
// прочерки у того CLI, который ещё не подключён, и увела бы человека с
// выбранного пункта прямо в тот момент, когда он в него опустился
onCliScan(() => remarkCliLevels(scanMarkOf));
