// Разметка вкладки Sessions: панель списка сессий слева, лента и композер
// справа. Файл самодостаточный — свою разметку он вставляет сам, стили лежат
// рядом (sessions.css), а всё чужое зовёт через окна. Подключается раньше
// app.js (см. порядок <script> в SYSTEM/index.html): тот на старте ищет
// #chatView для App.VIEWS.
//
// Якорь вставки — соседняя вкладка: разделы стоят подряд в body, и вставляться
// надо на своё прежнее место, а не в конец (иначе вкладкаSessions уехала бы
// за Book и Telegram и перестала бы открываться). Якорь один на всех и лежит
// в разметке страницы, а не внутри чужого файла: вкладку переименовали — и
// молчащий выход здесь уже ронял всё переключение вкладок, а не только нас.
// Разметки нет — вкладку показать некуда, дальше идти незачем.
(function () {
    if (!document.getElementById('chatAnchor')) return;

    const view = document.createElement('div');
    view.className = 'view view--sessions';
    view.id = 'chatView';
    view.hidden = true;
    view.innerHTML = `
        <nav class="sessions-panel" id="sessionsPanel" aria-label="Sessions">
            <h2 class="sessions-panel__title">Sessions</h2>
            <button type="button" class="sessions-panel__new" id="sessionNew">+ New</button>
            <!-- разметку списка строит сервер (PROJECTS/Sessions/session-list.eta,
                 роут /api/fragment/session-list), htmx подменяет #sessionList по
                 hx-swap-oob; hx-swap="none" на самом инициаторе, чтобы этот
                 скрытый div не подменился вместо списка -->
            <div hidden
                 hx-get="/api/fragment/session-list"
                 hx-trigger="load, every 5s, sessions-changed from:body"
                 hx-swap="none"></div>
            <ul class="session-list" id="sessionList"></ul>
            <button type="button" class="sessions-panel__reset" id="sessionReset">Reset All</button>
            <div class="panel-resize" id="sessionResize" aria-hidden="true"></div>
        </nav>

        <div class="chat-main">
            <!-- строка выбора агента и модели в шапке сессии: наполняет её
                 SYSTEM/providers.js — тем же каскадом из четырёх уровней
                 (CLI / Gateway / Provider / Model), что и окно настроек, и тем
                 же сохранённым выбором, поэтому шапка и настройки не расходятся -->
            <div class="chat-session-bar" id="chatSessionBar" hidden></div>

            <div class="chat-messages" id="chatMessages">
                <div class="chat-list" id="chatList"></div>
            </div>

            <!-- панель редактора файла (PROJECTS/Graph/file-editor.js) заменяет
                 ленту и композер, как выбор сессии; разметку наполняет он сам -->
            <div class="chat-file-editor" id="chatFileEditor" hidden>
                <div class="chat-file-editor-header">
                    <h2 class="chat-file-editor-title" id="chatFileEditorTitle"></h2>
                    <p class="file-modal__meta" id="chatFileEditorMeta"></p>
                </div>
                <div class="file-modal__links" id="chatFileEditorLinks"></div>
                <textarea class="file-modal__text" id="chatFileEditorText" spellcheck="false" aria-label="File contents"></textarea>
                <div class="file-modal__footer">
                    <span class="file-modal__status" id="chatFileEditorStatus"></span>
                    <button type="button" class="file-modal__save" id="chatFileEditorSave">Save</button>
                </div>
            </div>

            <div class="chat-gauges">
                <span class="chat-gauge" id="chatGaugeContext">Context: —</span>
            </div>

            <form class="chat-composer" id="chatComposer">
                <textarea class="chat-input" id="chatInput" rows="1" placeholder="Describe the action..." aria-label="Message"></textarea>
                <div class="mode-switch" id="chatMode" role="radiogroup" aria-label="Send mode">
                    <span class="mode-switch__thumb" aria-hidden="true"></span>
                    <button type="button" class="mode-switch__option" role="radio" aria-checked="true" data-mode="Chat" tabindex="0">Chat</button>
                    <button type="button" class="mode-switch__option" role="radio" aria-checked="false" data-mode="Action" tabindex="-1">Action</button>
                    <button type="button" class="mode-switch__option mode-switch__option--soon" role="radio" aria-checked="false" data-mode="Loop" tabindex="-1" disabled title="Coming Soon">Loop</button>
                </div>
                <button type="submit" class="chat-send">Send</button>
            </form>
        </div>
    `;

    document.getElementById('chatAnchor').before(view);
})();