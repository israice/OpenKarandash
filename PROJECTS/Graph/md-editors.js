// EasyMDE для файловых панелей: чата (#chatFileEditorText) и вкладки Book (#bookFileEditorText).
(function () {
    const nativeValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
    const nativeReadOnly = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'readOnly');

    function attach(textEl) {
        if (!textEl) return;

        // makeFileEditor() в graph.js читает/пишет textEl.value напрямую — подменяем
        // геттер/сеттер, чтобы EasyMDE был источником истины прозрачно для него.
        const easymde = new EasyMDE({ element: textEl, spellChecker: false, status: false });
        easymde.codemirror.on('change', () => textEl.dispatchEvent(new Event('input')));

        Object.defineProperty(textEl, 'value', {
            configurable: true,
            get() { return easymde.value(); },
            set(text) {
                nativeValue.set.call(textEl, text);
                easymde.value(text || '');
            },
        });

        Object.defineProperty(textEl, 'readOnly', {
            configurable: true,
            get() { return nativeReadOnly.get.call(textEl); },
            set(value) {
                nativeReadOnly.set.call(textEl, value);
                easymde.codemirror.setOption('readOnly', value);
            },
        });
    }

    document.addEventListener('DOMContentLoaded', () => {
        attach(document.getElementById('chatFileEditorText'));
        attach(document.getElementById('bookFileEditorText'));
    });
})();
