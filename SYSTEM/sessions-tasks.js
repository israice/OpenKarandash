// Вкладка Tasks панели Sessions: список сессий и область чата (сообщения, композер, gauges).
// Не знает про вкладку PROJECTS — активность/видимость своих элементов включает и выключает сама.
(function () {
    const taskList = document.getElementById('sessionList');
    const newBtn = document.getElementById('sessionNew');
    const resetBtn = document.getElementById('sessionReset');
    const composer = document.getElementById('chatComposer');
    const chatMessages = document.getElementById('chatMessages');
    const chatGauges = document.getElementById('chatGauges');
    const sessionBar = document.getElementById('chatSessionBar');
    const sessionIdText = document.getElementById('chatSessionIdText');
    if (!taskList) return;

    function activate() {
        taskList.hidden = false;
        if (newBtn) newBtn.hidden = false;
        if (resetBtn) resetBtn.hidden = false;
        if (composer) composer.hidden = false;
        if (chatMessages) chatMessages.hidden = false;
        if (chatGauges) chatGauges.hidden = false;
        if (sessionBar) sessionBar.hidden = !sessionIdText || sessionIdText.textContent === '—';
    }

    function deactivate() {
        taskList.hidden = true;
        if (newBtn) newBtn.hidden = true;
        if (resetBtn) resetBtn.hidden = true;
        if (composer) composer.hidden = true;
        if (chatMessages) chatMessages.hidden = true;
        if (chatGauges) chatGauges.hidden = true;
        if (sessionBar) sessionBar.hidden = true;
    }

    window.MissionSessionsTasks = { activate, deactivate };
})();
