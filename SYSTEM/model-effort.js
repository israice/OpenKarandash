// Пятый уровень каскада — глубина размышления (Effort).
//
// Отдельный файл от SYSTEM/model-cascade.js: там сама строка выбора и правила
// её заполнения, здесь — список уровней, дефолт и наполнение пунктом. Рядом с
// model-path.js и model-add-option.js: и путь, и заглушка «Add» тоже вынесены
// из строки, потому что правка одного не должна трогать отрисовку другого.
//
// Список один на все CLI, а не свой у каждого: значения уровня называет сам
// агент (`pi --help`: `--thinking <level>` — off, minimal, low, medium, high,
// xhigh, max), и у остальных семейств набор вложен в этот. Список приходит от
// CLI, а строка в интерфейсе — наша: показывать надо ровно то, что уходит в
// ход, иначе человек выбрал бы уровень, которого CLI не понимает.
//
// Уровень общий на все CLI — как Gateway/Provider/Model (см. LEVELS_KEY в
// SYSTEM/providers.js): переключение CLI не должно сбрасывать выбранную
// глубину, иначе строка в шапке и строки в настройках разошлись бы.
import { saveEffortChoice, loadEffortChoice } from './providers.js';

// уровни pi в том порядке, в каком он их называет сам
export const EFFORT_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

// дефолт по решению владельца: до появления уровня в интерфейсе ход шёл на
// medium, и строка, у которой выбора ещё нет, должна вставать на то же самое
export const DEFAULT_EFFORT = 'medium';

// чем пойдёт ход: выбор человека, а пока его нет — дефолт. Значение из
// хранилища берётся тем же уровнем выбора, каким его пишет applyModelChoice
export function effortOf() {
    return loadEffortChoice() || DEFAULT_EFFORT;
}

// запись выбора. Чужое значение (руками в хранилище, из прежней вкладки)
// уровнем не считается и заменяется дефолтом — иначе CLI получил бы флаг,
// которого не знает, и ход упал бы ошибкой
export function saveEffort(effort) {
    saveEffortChoice(EFFORT_LEVELS.includes(effort) ? effort : DEFAULT_EFFORT);
}

// Наполнение уровня: список один, а выбранным встаёт то, что человек поставил
// (или дефолт). Отдельный наполнитель, а не общий fillLevel из model-cascade.js,
// по той же причине, по которой вынесен пункт «Add»: список уровней не зависит
// от каталога моделей, и перерисовывать его на каждый выбор CLI незачем
export function fillEffortLevel(select) {
    select.innerHTML = '';
    for (const value of EFFORT_LEVELS) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = value;
        select.append(option);
    }
    select.value = effortOf();
}