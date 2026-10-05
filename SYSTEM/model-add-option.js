// Пункт «Add» нижней строкой раскрытого списка CLI и Gateway.
//
// Отдельный файл от SYSTEM/model-cascade.js: там сама строка выбора и правила
// её заполнения, здесь — одна заглушка списка, к которой у строки особое
// отношение (значение не должно совпасть с настоящим уровнем, а выбор его —
// должен молча возвращаться на прежний).
//
// Пока это заглушка без логики, поэтому option отключена: в раскрытом списке
// строка видна, выбрать её нельзя, и значение каскада от неё не зависит
// (row.read и обработчики change смотрят только на выбранный CLI). Когда у
// пункта появится действие, отключение снимается, а обработчик вешается рядом с
// остальными в modelCascadeRow. Значение-заглушка отдельное от значений
// уровней, чтобы пункт не совпал с настоящим шлюзом или агентом, даже если
// кто-то назовёт его add
export const ADD_OPTION = { value: '::add', label: 'Add' };

export function appendAddOption(select) {
    const option = document.createElement('option');
    option.value = ADD_OPTION.value;
    option.textContent = ADD_OPTION.label;
    option.disabled = true;
    // класс — только ради выравнивания: раскрытый список браузер рисует по
    // text-align каждого option'а, и Add в нём остаётся по центру, а пункты
    // уровня уходят влево (SYSTEM/styles/model-cascade.css)
    option.className = 'provider__option--add';
    select.append(option);
}

// Последнее настоящее значение уровня — им уровень возвращается, если значение
// подменили. Память на сам select: перерисовка уровня создаёт его заново, и
// ключ по уровню пережил бы смену CLI, а это и есть прежнее значение, к
// которому возвращаться нельзя
const realValues = new WeakMap();

// Наполнение уровня, у которого внизу есть «Add»: сам уровень наполняет
// переданный наполнитель (общий fillLevel из model-cascade.js), а пункт
// дописывается заново на каждой перерисовке — наполнитель чистит option'ы
export function levelWithAdd(select, fill, addOption) {
    fill();
    realValues.set(select, select.value);
    if (addOption) appendAddOption(select);
}

// Значение заглушки не доходит до каскада: уровень молча возвращается на
// прежнее настоящее значение. Отключённый пункт выбрать нельзя, но подменить
// значение селекта можно (будущий обработчик пункта, чужой код, autofill
// браузера) — и без этой проверки уровень уехал бы вниз, а за ним
// перерисовались бы поставщик и модель, то есть выбор человека сменился бы сам
// собой. Возвращает true, когда значение было заглушкой.
export function ignoreAdd(select) {
    if (select.value !== ADD_OPTION.value) return false;
    const back = realValues.get(select);
    const usable = [...select.options].some((o) => o.value === back && !o.disabled);
    if (usable) select.value = back;
    return true;
}