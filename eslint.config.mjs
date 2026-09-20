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
const SERVER = ['server.js', '**/*-server.js', 'SYSTEM/core/**/*.js', 'SYSTEM/checks.js',
    'PROJECTS/Graph/graph-*.js', 'PROJECTS/Graph/search.js', '.claude/hooks/**/*.js',
    // скрипты навыка finish-task — обычный Node; сценарии live-verify сюда не входят:
    // это тела функций для страницы пульта (верхнеуровневые await/return), а не модули
    '.claude/skills/finish-task/*.js'];

// имена, которые вкладки публикуют друг для друга через window (см. AGENTS.md,
// «Клиентский код»): для файла-потребителя они приходят извне, а не объявлены
const APP_GLOBALS = ['App', 'MissionFlow', 'MissionFiles', 'MissionTabs', 'MissionPages', 'MissionKanban',
    'MissionBookTab', 'MdEditors', 'SidebarResize', 'Settings', 'MissionHome', 'TurnJudgment'];
// библиотеки, которые страница грузит сама (importmap и <script> в index.html)
const VENDOR_GLOBALS = ['htmx', 'EasyMDE', 'THREE', 'CodeMirror'];

const readonly = (names) => Object.fromEntries(names.map((name) => [name, 'readonly']));

export default [
    {
        // вендорные сборки не наши — их правила и их же ошибки нас не касаются
        ignores: ['node_modules/**', 'DATA/**', 'hermes/**', 'hermes-home/**', '.claude/worktrees/**',
            'PROJECTS/Graph/vendor/**', '**/*.min.js',
            // рабочие деревья агентов — копии проекта, свой прогон у них свой
            '.worktrees/**'],
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
