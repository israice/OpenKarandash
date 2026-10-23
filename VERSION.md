
# RUN
node server.js

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
v0.0.209 - Use a dedicated token for version PR validation (PR #3)
v0.0.210 - Wait for version PR checks before enabling auto-merge (PR #5)
v0.0.211 - Automate validated session updates from GitHub (PR #1)
v0.0.212 - Unify desktop automation in the OpenKarandash project (PR #8)
v0.0.213 - Fix persistent OpenCode binary selection (PR #10)
