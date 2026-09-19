// Общее изменяемое состояние вкладки Chat — один объект на все её модули
// (DOCS/decisions/022). Это то, что в SYSTEM/app.js было переменными замыкания
// и было видно всем функциям файла; теперь модули берут его по имени через
// `state.<поле>`. Поля-узлы заполняет init() в chat.js — на верхнем уровне
// модулей DOM не берётся, до init() они null.
export const state = {
    chatSessionId: null, // CLI продолжает диалог по нему
    chatRun: 0, // номер текущего запроса: старый перестаёт писать в ленту
    runningSessionId: null, // индикатор «сессия ещё выполняется» в списке слева

    // миниатюра элемента из режима Karandash: сессии ещё нет, id придёт только
    // с первым событием потока — до тех пор снимок ждёт здесь
    pendingThumb: null,
    // сессию завёл Karandash/Home: когда она появится, открытые модальные окна закрываются
    closeModalsOnSession: false,

    // ---------- узлы вкладки, общие для нескольких модулей ----------

    // разметку списка строит сервер (PROJECTS/Chat/chat-sessions.eta,
    // роут /api/fragment/chat-sessions), htmx подменяет #sessionList целиком
    // по hx-swap-oob — значит сам узел периодически заменяется новым, и
    // держать на него константную ссылку нельзя: обработчик htmx:oobAfterSwap
    // в chat-sessions.js переподхватывает актуальный узел сразу после подмены
    sessionList: null,
    sessionsPanel: null, // панель Sessions — htmx её не подменяет, клики вешаются на неё

    chatInput: null, // поле ввода композера
    chatSend: null, // кнопка Send/Stop
    chatList: null, // лента сообщений
    chatDefaultHtml: '', // карточка «Секретарь» — вид «Чата Пользователя» без выбранной сессии
    chatEmpty: null,
    chatMessages: null, // прокручиваемая область ленты

    // строка выбора провайдера/модели/effort в шапке сессии
    chatSessionBar: null,
    chatSessionProviderSelect: null,
    chatSessionModelSelect: null,
    chatSessionEffortSelect: null,

    // панель датчиков над композером — сейчас только контекст, место под будущие.
    // видна всегда: до первого ответа показывает «Контекст: —»
    chatGaugeContext: null,
};
