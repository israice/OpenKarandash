
# RUN
node server.js
docker compose down
docker compose up -d --build

# RECOVERY
git log --oneline -n 5

Copy-Item .env $env:TEMP\.env.backup
git reset --hard
git clean -fd
Copy-Item $env:TEMP\.env.backup .env -Force
node server.js

# UPDATE
git add <файлы задачи поимённо>
git commit -m "vX.Y.Z - что сделано"
git push

# DEV LOG
v0.0.203 - до добовления noVNC
v0.0.204 - Penpot полностью удалён из проекта
v0.0.205 - TypeSafe полностью удалён из проекта
v0.0.206 - удалены неиспользуемые файлы конфигурации и список провайдеров
v0.0.207 - чат-сессии связаны с изолированными Linux desktop и OpenCode
v0.0.208 - перед добовлением проекта в github
v0.0.209 - добавлен auto PR github