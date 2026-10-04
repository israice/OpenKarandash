// Содержимое этой страницы. Файл заводит /api/pages/create, а грузит его
// динамическим import при первом открытии страницы SYSTEM/new-button.js.
// page — её <main>, panel — слот в топбаре под свою панель (пустой не
// показывается), signal — снимается при пересборке страницы: подписывайте им
// слушателей и потоки, чтобы от прошлой сборки ничего не оставалось.
// Пример со всем сразу — PROJECTS/Feed/page.js.
export default function build(page, { panel, signal }) {
    page.style.cssText = 'display:flex;align-items:center;justify-content:center;';
    page.textContent = 'Hello World';
}
