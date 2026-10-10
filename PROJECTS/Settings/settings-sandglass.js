// 3D-рендер песочных часов вкладки Settings → Sandglass.
// Полноценный перенос из https://github.com/khanmjk/Hourglass_Fable5: честная
// физика на Rapier (WASM), 2000 отдельных песчинок, та же механика «заглушки»
// в горлышке (freeze-plug) — песок не сыплется сам по себе, а выпускается
// счётчиком порциями. Используется -compat сборка Rapier: WASM в ней вшит в
// сам .mjs base64-строкой, поэтому не нужно отдельно отдавать .wasm с верным
// MIME — обоснование новой зависимости: только так получается «точь-в-точь
// как в примере», а не плоская имитация на одном three.js.
//
// Реализация разложена по модулям (DOCS/decisions/022):
//   settings-sandglass-constants.js — константы и конфигурация
//   settings-sandglass-geometry.js  — геометрия и материалы Three.js
//   settings-sandglass-physics.js   — физика Rapier (коллайдеры, симуляция)
//   settings-sandglass-three.js     — сборка Three.js сцены
//   settings-sandglass-loop.js      — анимационный цикл
//   settings-sandglass-entry.js     — инициализация, монтирование, MutationObserver

import './settings-sandglass-entry.js';