
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
