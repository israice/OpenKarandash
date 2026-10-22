
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
