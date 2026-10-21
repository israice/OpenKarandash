// Проверка неизвестных имён: ловит обращения к переменным, которых нигде нет.
// `node --check` (хук syntax-check.js) такое пропускает — синтаксис-то верный,
// а падает оно уже в браузере у пользователя. Именно так в flow.js жил вызов
// необъявленной ROOT_FIELDS, а в settings.js до сих пор живёт pickInstall.
//
// Правило здесь ровно одно — no-undef. Стилевые придирки не включаем: они бы
// завалили вывод шумом и обесценили проверку.
import globals from 'globals';

// серверная половина — CommonJS с глобалами Node; всё остальное в PROJECTS/ и
// SYSTEM/ — браузерный код (обычные скрипты и ES-модули разбираем одинаково,
// sourceType: 'module' понимает и то и другое)
const SERVER = ['server.js', '**/*-server.js', 'SYSTEM/core/**/*.js', 'SYSTEM/cli/**/*.js', 'SYSTEM/checks.js', 'SYSTEM/secrets-scan.js',
    'SYSTEM/esm-links.js',
    'PROJECTS/Graph/graph-*.js', 'PROJECTS/Graph/search.js', 'PROJECTS/Browser/chrome-bridge.js', 'PROJECTS/Browser/sync-user-profile.js',
    // вспомогательные скрипты TOOLS — обычный Node; сценарии live-verify сюда не входят:
    // это тела функций для страницы пульта (верхнеуровневые await/return), а не модули
    'TOOLS/next-numbers.js'];

// имена, которые вкладки публикуют друг для друга через window (см. таблицу
// «Клиентский код» в DOCS/agents/клиент.md): для файла-потребителя они приходят
// извне, а не объявлены
const APP_GLOBALS = ['App', 'MissionFlow', 'MissionFiles', 'MissionTabs', 'MissionPages', 'MissionKanban',
    'MissionBookTab', 'MdEditors', 'SidebarResize', 'Settings', 'TurnJudgment', 'ModelTag'];
// библиотеки, которые страница грузит сама (importmap и <script> в index.html)
const VENDOR_GLOBALS = ['htmx', 'EasyMDE', 'THREE', 'CodeMirror'];

const readonly = (names) => Object.fromEntries(names.map((name) => [name, 'readonly']));

export default [
    {
        // вендорные сборки не наши — их правила и их же ошибки нас не касаются.
        // TOOLS/penpot-mcp/design — скрипты-плагины Penpot: это тела функций,
        // которые движок Penpot выполняет сам и в globals подставляет (penpot, C,
        // storage), поэтому верхнеуровневый `return` и незнакомые имена там — не
        // ошибка, а устройство скрипта; раньше они роняли проверку семью
        // «Parsing error: 'return' outside of function» (DOCS/decisions/034 —
        // проверка, которая всегда красная, не учит ничему)
        ignores: ['node_modules/**', 'DATA/**', 'hermes/**', 'hermes-home/**',
            'PROJECTS/Graph/vendor/**', '**/*.min.js',
            'TOOLS/penpot-mcp/**',
            // json-render и json-renderer — вложенные чужие репозитории, у каждого
            // свой .git и свой конфиг. Без этих строк eslint читал ИХ eslint.config.js
            // и падал на отсутствующем пакете @internal/eslint-config, из-за чего
            // наш код не проверялся вовсе (см. SKIP в SYSTEM/checks.js — те же папки
            // выпадали из счётчиков размера и vh/vw)
            'json-render/**', 'json-renderer/**'],
    },
    {
        files: ['PROJECTS/**/*.js', 'SYSTEM/**/*.js'],
        ignores: SERVER,
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
            globals: { ...globals.browser, ...readonly([...APP_GLOBALS, ...VENDOR_GLOBALS]) },
        },
        rules: { 'no-undef': 'error' },
    },
    {
        files: SERVER,
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'commonjs',
            globals: globals.node,
        },
        rules: { 'no-undef': 'error' },
    },
];
