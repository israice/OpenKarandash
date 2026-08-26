
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