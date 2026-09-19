
# RUN
node server.js

# RECOVERY
git log --oneline -n 5

Copy-Item .env $env:TEMP\.env.backup
git reset --hard 80f714fc
git clean -fd
Copy-Item $env:TEMP\.env.backup .env -Force
git push origin master --force
python run.py

# UPDATE
git add .
git commit -m "v0.0.4 — добавлен граф"
git push

# DEV LOG
v0.0.1 - Mission Control with working Claude
v0.0.2 - Mission Control with Grafiphy
v0.0.3 - Syntax-check hook for .js and inline <script>
v0.0.4 - typescript-lsp off for the project
v0.0.5 - smoke.js + PLAN.md
v0.0.6 - 7 проектов начтых 
v0.0.7 - добавлены сессии в flows и подготовка переходу на react
v0.0.8 - small fixings
v0.0.9 - graphify полностью удалён: артефакты, CLI, скилл и упоминания в конфигах
v0.0.10 - сахронение перед расширений нодов в flow странице
v0.0.11 - добавлен телеграм
v0.0.12 - добавленно меню настроек и разделение на табы
v0.0.13 - создоем более детальную ленту
v0.0.14 - Этап 0: записка 040, разведён дубль 039, проверены внешние адреса
v0.0.15 - Этапы 1 и 2: поля Event Schema и сырое событие рядом с каждым
v0.0.16 - Пересборка ленты Hermes больше не стирает наблюдение
v0.0.17 - Поиск и отбор по ленте
v0.0.18 - Сырое событие и у второй половины строки
v0.0.19 - Sessions и Flow показывают о строке всё то же, что Feed
v0.0.20 - Правило: агент сам коммитит законченную задачу
v0.0.21 - Агент проверяет свою работу живьём сам
v0.0.22 - в правило автокоммита добавлен шаг с версией в VERSION.md
v0.0.23 - предпросмотр ветки исполнителя по адресу /branch/<ветка>/
v0.0.24 - ход в сессии OpenCode/pi продолжает её агент, а не Hermes
v0.0.25 - после новой сессии из Карандаша или Home открытые окна закрываются
v0.0.26 - отступы в окне Settings: список провайдеров, карточки, поле ключа OpenRouter
v0.0.27 - журнал задач beads больше не хранится в репозитории
