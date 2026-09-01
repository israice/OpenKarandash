// Установка и выбор провайдера настоящего Hermes (nousresearch/hermes-agent).
//
// Сам Hermes как исполнитель подключён отдельно, через
// hermes-agent-connector.js и записи 'hermes'/'hermes-plan' в таблице AGENTS
// сервера (см. DOCS/decisions/006 и 007) — этот файл его не запускает и не
// дублирует его планирование. Здесь только то, что нужно один раз до первого
// использования: установить CLI и настроить, через какого провайдера и с
// какой моделью он ходит.

const { readJson, sendJson, sendHtml } = require('../../SYSTEM/core/http.js');
const setup = require('./hermes-setup.js');

// Провайдеры, которых Hermes поддерживает из коробки. Держим короткий список
// живых вариантов, а не все два десятка из cli-config.yaml.example: цель —
// чтобы человек выбрал один раз и начал работать, а не изучал матрицу.
// env — переменная с ключом; её пишем в .env проекта, как и любой секрет.
const HERMES_PROVIDERS = [
    // первым — то, что в этом проекте уже подключено: Claude ходит только через CLI,
    // и Hermes берёт его вход (источник claude_code), а не отдельный ключ API
    { id: 'anthropic', name: 'Claude по подписке CLI', env: null, defaultModel: 'claude-sonnet-5', note: 'вход из Claude CLI, ключ не нужен' },
    { id: 'openrouter', name: 'OpenRouter', env: 'OPENROUTER_API_KEY', note: 'сотни моделей, включая бесплатные' },
    { id: 'nous-api', name: 'Nous Portal', env: 'NOUS_API_KEY', note: 'родной провайдер Hermes' },
    { id: 'anthropic', name: 'Anthropic', env: 'ANTHROPIC_API_KEY', note: 'Claude напрямую' },
    { id: 'gemini', name: 'Google AI Studio', env: 'GEMINI_API_KEY', note: 'Gemini напрямую' },
    { id: 'zai', name: 'z.ai / GLM', env: 'GLM_API_KEY', note: 'GLM' },
    { id: 'deepinfra', name: 'DeepInfra', env: 'DEEPINFRA_API_KEY', note: 'открытые модели' },
    { id: 'ollama-cloud', name: 'Ollama Cloud', env: 'OLLAMA_API_KEY', note: '' },
    { id: 'lmstudio', name: 'LM Studio', env: null, note: 'локально, ключ не нужен' },
];

function createRoutes({ db, agents, eta }) {
    // установка идёт своим ходом и переживает запрос, который её начал:
    // страница показывает лог, а не держит соединение
    const setupState = { running: false, log: [], error: null };

    function startSetup() {
        if (setupState.running || setup.isReady()) return;
        setupState.running = true;
        setupState.error = null;
        setup.installOnce({
            onLog: (line) => {
                setupState.log.push(line);
                if (setupState.log.length > 200) setupState.log.shift();
                console.log(`[hermes-setup] ${line}`);
            },
        }).catch((err) => {
            setupState.error = err.message;
            setupState.log.push(`Ошибка: ${err.message}`);
        }).finally(() => {
            setupState.running = false;
        });
    }

    return {
        // ---- установка и провайдер ----

        '/api/hermes/setup/status': async (req, res) => {
            const state = setup.status();
            sendJson(res, {
                ok: true,
                ...state,
                ready: setup.isReady(state),
                installing: setupState.running,
                error: setupState.error,
                log: setupState.log.slice(-30),
                providers: HERMES_PROVIDERS,
            });
        },

        // повторный вызов на готовой установке ничего не делает — install идемпотентен
        '/api/hermes/setup/start': async (req, res) => {
            startSetup();
            sendJson(res, { ok: true, installing: setupState.running, ready: setup.isReady() });
        },

        // выбор провайдера из интерфейса: ключ уходит в .env проекта (единственное
        // место для секретов), сам выбор — в конфиг Hermes его же командой
        '/api/hermes/provider/set': async (req, res) => {
            const { provider, model, apiKey, workerModel, workerProvider } = await readJson(req);
            const known = HERMES_PROVIDERS.find((p) => p.id === provider);
            if (!known) {
                sendJson(res, { ok: false, error: `Неизвестный провайдер: ${provider}` });
                return;
            }
            if (!setup.isReady()) {
                sendJson(res, { ok: false, error: 'Hermes ещё не установлен' });
                return;
            }

            if (apiKey && known.env) setup.setSecret(known.env, apiKey);

            try {
                await setup.config('model.provider', known.id);
                // Подзадачи Hermes раздаёт подагентам, и именно там уходит основная
                // масса токенов. delegation.model держит их на дешёвой (вплоть до
                // бесплатной) модели, пока планирование остаётся у сильной —
                // это штатный рычаг Hermes, а не наша выдумка
                if (workerModel) {
                    await setup.config('delegation.model', workerModel);
                    if (workerProvider) await setup.config('delegation.provider', workerProvider);
                }
                // без модели Hermes уходит в API с пустым полем и получает
                // невнятную 400 — подставляем известное умолчание провайдера
                const chosenModel = model || known.defaultModel || null;
                if (chosenModel) await setup.config('model.default', chosenModel);
            } catch (err) {
                sendJson(res, { ok: false, error: `Hermes не принял настройку: ${err.message}` });
                return;
            }
            sendJson(res, { ok: true, provider: known.id, model: model || known.defaultModel || null });
        },

        '/api/fragment/hermes-setup': async (req, res) => {
            const state = setup.status();
            sendHtml(res, eta.render('hermes-setup', {
                ready: setup.isReady(state),
                installing: setupState.running,
                error: setupState.error,
                log: setupState.log.slice(-12),
                platform: state.platform,
            }));
        },

        '/api/fragment/hermes-provider': async (req, res) => {
            const ready = setup.isReady();
            const choice = ready ? setup.currentChoice() : { provider: null, model: null };
            const known = HERMES_PROVIDERS.find((p) => p.id === choice.provider);
            sendHtml(res, eta.render('hermes-provider', {
                ready,
                providers: HERMES_PROVIDERS,
                // подписка Claude CLI найдена — значит, первый вариант работает без ключа
                claudeLogin: Boolean(setup.claudeCliLogin()),
                worker: setup.currentChoice().worker,
                provider: choice.provider,
                model: choice.model,
                // подсказываем, какая переменная нужна выбранному провайдеру
                keyPlaceholder: known?.env || 'ключ нужен не всем провайдерам',
            }));
        },
    };
}

module.exports = { createRoutes, HERMES_PROVIDERS };
