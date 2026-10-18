# Web Linux Desktop

Независимые графические рабочие столы Linux в Docker-контейнерах с доступом из
обычного браузера через noVNC. Один общий образ, N сессий, никакого Chrome
внутри. Стек — Docker Engine + Compose + небольшой менеджер сессий на FastAPI.

```
Браузер ──HTTP──► manager (FastAPI :8080)
                  ├── /s/            список сессий (HTTP Basic)
                  ├── /s/<id>/       noVNC-клиент
                  ├── /ws/<id>/      WebSocket ──прокси──► RFB (x11vnc)
                  ├── /api/...       CRUD сессий + контроль ресурсов
                  └── docker-proxy ──► Docker API
                                        │
                                        ▼
                          wd-<id>  контейнер-сессия (общий образ)
                          Xvfb :N → LXDE (openbox + lxpanel + pcmanfm)
                                → x11vnc → 127.0.0.1:5900+ (внутренняя сеть)
                          wd-home-<id>  Docker volume с домашним каталогом
```

---

## 1. Что внутри образа сессии

| Компонент | Зачем |
|---|---|
| `debian:trixie-slim` | база |
| `xvfb`, `xauth`, `x11-utils` | виртуальный дисплей |
| `x11vnc` | RFB-сервер поверх Xvfb |
| `lxde-core` | полноценный десктоп: `startlxde`, `lxsession`, `openbox` (WM), `lxpanel` (панель + меню приложений), `pcmanfm` (рабочий стол + файловый менеджер), `lxterminal`, `lxappearance`, `lxmenu-data`, `lxsession-logout`, `lxlock` |
| `x11-xserver-utils` | `xrandr` для смены разрешения |
| `dbus`, `dbus-x11` | шина сессии, без неё панель и рабочий стол сыпятся |
| `tango-icon-theme`, `fonts-dejavu-core` | иконки и шрифт |
| `procps`, `psmisc` | `pgrep`/`pkill` в супервизоре |

Менеджер сессий (отдельный образ) — это FastAPI + docker SDK + статика noVNC.
noVNC отдаётся менеджером, а не отдельным контейнером на сессию: один вход,
одна точка авторизации, один WebSocket-прокси.

---

## 2. Быстрый старт

```bash
cp .env.example .env      # можно вообще ничего не менять
docker compose up -d --build
```

Откройте в браузере:

* `http://127.0.0.1:8080/s/` — список сессий, **уже без логина и пароля**.

На странице есть кнопка «+ Start a desktop»: нажали — создалась сессия,
дождались готовности и браузер сам открыл рабочий стол. Никаких паролей,
никаких команд в терминале.

Из терминала, если нужно:

```bash
./scripts/desktop-session.sh create --resolution 1440x900
# session 3f9c1a20be44 created (starting)
# url: http://127.0.0.1:8080/s/3f9c1a20be44/
```

и откройте полученный URL. Никаких VNC-клиентов ставить не нужно.

### Автологин — как это устроено

По умолчанию `MANAGER_AUTO_LOGIN=1`: тот, кто открыл URL, сразу считается
пользователем `MANAGER_USER` (по умолчанию `admin`). Ни пароля, ни формы входа,
ни HTTP Basic-запроса в браузере. Статика noVNC и WebSocket проверяются той же
логикой, поэтому картинка не «протекает» мимо автологина.

Значит «достижимость URL = вход». Отсюда два следствия:

* `MANAGER_BIND` по умолчанию `127.0.0.1` — снаружи машины сервис не виден;
* если нужен доступ из сети, поставьте перед менеджером обратный прокси со своей
  аутентификацией либо выключите автологин (`MANAGER_AUTO_LOGIN=0`) и задайте
  `MANAGER_USER` / `MANAGER_PASSWORD` — тогда вернётся обычный HTTP Basic.

`MANAGER_PASSWORD` и `MANAGER_API_TOKEN` остаются необязательными: они нужны
только скриптам, которые хотят аутентифицироваться явно. Проверить, кем вы
сейчас считаетесь: `curl http://127.0.0.1:8080/api/whoami`.

---

## 3. Установка на чистый Debian/Ubuntu

```bash
# 1. Docker Engine + Compose plugin
sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg python3
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/debian/gpg \
  | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
  https://download.docker.com/linux/debian $(lsb_release -cs) stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io \
     docker-buildx-plugin docker-compose-plugin

# 2. Проект
sudo mkdir -p /opt/webdesktop && sudo chown "$USER" /opt/webdesktop
cp -r . /opt/webdesktop && cd /opt/webdesktop
cp .env.example .env        # .env можно не править: пароль не требуется

# 3. Запуск
docker compose up -d --build
```

Требуется Python 3.9+ на хосте только для скриптов; в самих контейнерах
интерпретатор нужен лишь менеджеру (он внутри образа).

Проверка:

```bash
docker compose ps
curl -s http://127.0.0.1:8080/healthz
python3 tests/test_acceptance.py      # полный набор критериев приёмки
```

---

## 4. Команды

| Задача | Команда |
|---|---|
| Собрать образы | `docker compose build` |
| Запустить всё | `docker compose up -d --build` |
| Логи | `docker compose logs -f manager` |
| Логи конкретной сессии | `./scripts/desktop-session.sh logs <id>` |
| Создать сессию | `./scripts/desktop-session.sh create --resolution 1280x800` |
| Создать и дождаться готовности | `./scripts/desktop-session.sh create --wait 90` |
| Список сессий | `./scripts/desktop-session.sh list` |
| Статус | `./scripts/desktop-session.sh status <id>` |
| URL для браузера | `./scripts/desktop-session.sh open <id>` |
| Остановить | `./scripts/desktop-session.sh stop <id>` |
| Запустить снова | `./scripts/desktop-session.sh start <id>` |
| Перезапустить | `./scripts/desktop-session.sh restart <id>` |
| Удалить, **сохранив** данные | `./scripts/desktop-session.sh delete <id>` |
| Удалить вместе с данными | `./scripts/desktop-session.sh delete <id> --delete-data` |
| Потребление ресурсов | `./scripts/resources.sh` |
| Размер образа | `./scripts/image-size.sh` |
| Резервная копия сессии | `./scripts/desktop-session.sh backup <id> ~/backups/<id>.tar.gz` |
| Восстановление | `./scripts/desktop-session.sh restore <id> ~/backups/<id>.tar.gz && ./scripts/desktop-session.sh restart <id>` |
| Остановить систему | `docker compose down` |
| Гарантированная остановка (см. ниже) | `./scripts/down.sh` или `.\scripts\down.ps1` |
| Удалить и тома менеджера | `docker compose down -v` |

#### Почему `docker compose down` иногда ругается на сеть

```
! Network webdesktop_sessions Resource is still in use
```

Контейнеры сессий создаются менеджером через Docker API и **не являются
сервисами compose**, поэтому compose их не останавливает. Каждый такой
контейнер держит endpoint во внутренней сети `webdesktop_sessions`, и сеть не
удаляется.

Менеджер решает это сам: при остановке (SIGTERM) он **останавливает** все свои
контейнеры по метке `webdesktop.session` (но не удаляет), а у compose выставлен
`stop_grace_period: 45s`, чтобы это успело произойти до SIGKILL. Остановленный
контейнер сеть не держит, поэтому обычный `docker compose down` проходит.

Сессии при этом не теряются. При следующем старте менеджер поднимает ровно те
сессии, которые считал работающими: запись в базе сессий остаётся `running`.
Сессия, остановленная пользователем через API или UI, хранится как `stopped` и
не поднимается.

Отдельно стоит случай `down` → `up`. Compose при `down` удаляет сеть сессий, а
при `up` создаёт заново, уже с **новым** id, — остановленные контейнеры остаются
привязаны к несуществующей сети и не могут стартовать. Менеджер это
распознаёт и пересоздаёт такой контейнер с тем же именем; домашний том — отдельный
объект — сохраняется, поэтому файлы пользователя не теряются. Проверяется
тестом `7b`.

Если менеджер был убит через `docker kill -9` или запущен с
`STOP_SESSIONS_ON_SHUTDOWN=0`, используйте скрипт — он останавливает менеджер,
подчищает всё оставшееся и только затем вызывает `compose down`:

```bash
./scripts/down.sh              # контейнеры и сети, домашние тома сохраняются
./scripts/down.sh --data       # плюс удалить тома сессий (wd-home-*)
./scripts/down.sh --volumes    # плюс удалить всё, включая тома менеджера
```

```powershell
.\scripts\down.ps1
.\scripts\down.ps1 -SessionData
.\scripts\down.ps1 -Volumes
```

Переключатель в `.env`:

| Переменная | По умолчанию | Смысл |
|---|---|---|
| `STOP_SESSIONS_ON_SHUTDOWN` | `1` | Останавливать контейнеры сессий при остановке менеджера, чтобы `compose down` проходил. `0` — сессии продолжат работать, и чистить их придётся вручную (или через `scripts/down.sh`). |

Прямой доступ к API, если скрипты не подходят (пароль не нужен — работает
автологин):

```bash
curl -X POST http://127.0.0.1:8080/api/sessions \
     -H 'Content-Type: application/json' -d '{"resolution":"1280x800"}'
curl http://127.0.0.1:8080/api/sessions
curl -X POST http://127.0.0.1:8080/api/sessions/<id>/restart
curl -X DELETE "http://127.0.0.1:8080/api/sessions/<id>?delete_data=true"
curl http://127.0.0.1:8080/api/resources | python3 -m json.tool
```

Если автологин выключен (`MANAGER_AUTO_LOGIN=0`), к каждому запросу добавьте
`-u admin:$PASS` или `-H "Authorization: Bearer $MANAGER_API_TOKEN"`.

### REST API

| Метод и путь | Назначение |
|---|---|
| `POST /api/sessions` | создать сессию (`resolution`, `vnc_password`, `wait`) |
| `GET /api/sessions` | список (необязательно `?state=running,stopped`) |
| `GET /api/sessions/{id}` | статус, контейнер, healthcheck |
| `GET /api/sessions/{id}/url` | URL подключения |
| `POST /api/sessions/{id}/stop` | остановить |
| `POST /api/sessions/{id}/start` | запустить |
| `POST /api/sessions/{id}/restart` | перезапустить |
| `DELETE /api/sessions/{id}[?delete_data=true]` | удалить |
| `GET /api/sessions/{id}/logs?tail=200` | логи |
| `GET /api/resources` | состояние хоста и лимиты |
| `GET /api/resources/sessions` | живое потребление по сессиям |
| `GET /api/whoami` | текущий пользователь и режим автологина |
| `GET /healthz` | liveness, без секретов |

---

## 5. Ресурсы

### 5.1 Ограничения на сессию

Задаются в `.env` (или `config/manager.yaml`), применяются Docker'ом как
**жёсткие** лимиты при создании контейнера:

| Параметр | По умолчанию | Смысл |
|---|---|---|
| `SESSION_MEMORY_MB` | 512 | жёсткий лимит RAM |
| `SESSION_CPUS` | 0.5 | квота CPU |
| `SESSION_PIDS_LIMIT` | 512 | защита от fork-бомбы |
| `SESSION_TMPFS_MB` | 64 | `/tmp` контейнера (X-сокет, логи) |

Swap отключён (`MemorySwap == Memory`), `CapDrop=ALL`,
`no-new-privileges`, tmpfs для `/tmp`, файловая система не read-only (создана
для полноценного десктопа, изоляцию обеспечивают лимиты и отдельный том).

### 5.2 Контроль нагрузки

Compose не планировщик ресурсов, поэтому перед созданием контейнера менеджер
проверяет:

* `max_sessions` — сколько сессий одновременно допустимо;
* `min_free_memory_mb` — сколько свободной RAM должно остаться **до** старта;
* `reserve_memory_mb` — сколько должно остаться **после** добавления лимита
  новой сессии;
* `min_free_disk_mb` — свободное место под `/var/lib/docker`;
* `max_load_per_cpu` — load average на ядро.

Если ресурсов не хватает, при `OVERLOAD_ACTION=queue` запрос встаёт в очередь
(до `MAX_QUEUE`, ждать `QUEUE_TIMEOUT_S`), при `OVERLOAD_ACTION=reject` сразу
получает HTTP 429 с конкретной причиной.

**Уже работающие сессии никогда не убиваются из-за лимитов** — ограничения
применяются только к новым сессиям.

Менеджер читает `/host/proc`, `/host/sys` и `/host/var/lib/docker`
(read-only монтирования), поэтому видит хост, а не свой собственный cgroup.

### 5.3 Измеренные значения

Замерено на Debian 13 (trixie), Docker Engine, контейнер `1440x900`:

| Величина | Значение |
|---|---|
| `docker image ls` | 492 MB |
| Сжатый образ (то, что тянется по сети) | **125.9 MB** (`docker image inspect --format '{{.Size}}'`) |
| Распакованный образ (22 слоя, `docker history`) | **367 MB** |
| Установленные пакеты | 422 MB в 344 пакетах |
| RAM одной сессии в простое | **≈ 64 MB** (`docker stats`), пик до ~150 MB при запуске приложений |
| CPU одной сессии в простое | < 1.5 % ядра |
| Лимит по умолчанию | 512 MB / 0.5 CPU |

Про `docker image ls`: Docker Desktop в режиме containerd image store
показывает сумму распакованных слоёв **плюс** сжатый размер (367 + 126 ≈ 492),
поэтому число завышено примерно втрое. Проверяйте `docker image inspect <image>
--format '{{.Size}}'` (сжатый) и `docker history` (распакованный). Скрипт
`scripts/image-size.sh` печатает все три числа.

Логика уменьшения образа (каждый шаг замерен на этой машине):

| Шаг | Установлено | Сжатый образ |
|---|---|---|
| LXDE + X + зависимости, `--no-install-recommends` | 714 MB | — |
| удалён Mesa (libLLVM 124 MB, gallium 41 MB, libz3 27 MB) — Xvfb с `-extension GLX` | ~500 MB | — |
| удалены adwaita-icon-theme, ghostscript/poppler, cpp-14, systemd, lxpolkit | **422 MB** | **222 MB** |
| multi-stage: `.deb` из apt-кеша удаляются, но остались бы в том же слое → `COPY --from` | 367 MB | **126 MB** |

Сравнение с XFCE (`xfce4` вместо LXDE) не проводилось: LXDE уже даёт полный
десктоп, а XFCE добавляет xfce4-panel/xfwm4/xfdesktop, то есть больше пакетов
при том же результате. Если понадобится, `docker build --build-arg` с другим
списком пакетов покажет разницу.

---

## 6. Безопасность

Что уже сделано:

* **VNC-порт не публикуется на хост.** Он существует только в bridge-сети
  `webdesktop_sessions` с `internal: true` (нет шлюза и выхода в интернет), и
  достучаться до него может только менеджер.
* **Аутентификация везде**: HTTP Basic на `/api/*`, `/s/*` и на WebSocket
  upgrade. Пароли сравниваются через `hmac.compare_digest` и никогда не
  передаются в URL.
* **Изоляция сессий**: у каждой свой контейнер, свой `DISPLAY`, свой порт,
  свой Docker volume, свой пользователь `desktop` (uid 1000) без sudo.
* **Docker socket** монтируется только в `docker-socket-proxy` (read-only) и
  закрывает `exec`, образы, сети, сборку, коммит и bulk-удаление. В
  контейнеры сессий сокет не попадает — это проверяется тестом.
* **`CapDrop=ALL`**, `no-new-privileges`, без `privileged`.
* **Секретов в образе нет**: `VNC_PASSWORD` не запечён в `Dockerfile`,
  передаётся менеджером через API Docker при создании контейнера.
* Владелец сессии видит только свои сессии; идентификатор сессии не считается
  секретом.

Что нужно сделать перед публикацией в интернет:

```bash
# 1. Терминация TLS перед менеджером
cat > compose.tls.yaml <<'YAML'
services:
  manager:
    ports: !reset []
  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    ports: ["80:80", "443:443"]
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy-data:/data
    networks: [edge]
volumes:
  caddy-data:
YAML

cat > Caddyfile <<'CADDY'
desktop.example.com {
    reverse_proxy wd-manager:8080
}
CADDY

docker compose -f compose.yaml -f compose.tls.yaml up -d
```

Caddy сам получит сертификат Let's Encrypt. WebSocket проксируется
прозрачно. Если TLS терминируется на nginx/haproxy, важно только пробросить
заголовок `Upgrade`/`Connection` и не буферизовать ответ.

Дополнительно стоит:

* задать `MANAGER_API_TOKEN` для скриптов, чтобы не светить пароль в `ps`;
* ограничить `MANAGER_BIND=127.0.0.1`, если прокси стоит на той же машине;
* если прокси сам умеет аутентифицировать (basic auth на Caddy, OAuth на
  nginx), оставить автологин включённым — менеджер внутри сети закрыт, а
  снаружи пароль спрашивает прокси; либо выключить `MANAGER_AUTO_LOGIN=0`
  и задать `MANAGER_PASSWORD` в самом менеджере;
* включить `ALLOWED_ORIGINS`, если API дёргает другой фронтенд;
* настроить ротацию `MANAGER_PASSWORD` (менеджер перезапустить:
  `docker compose up -d manager`).

---

## 7. Устройство сессии

### Первый запуск

`entrypoint.sh` при старте один раз копирует `/opt/desktop-defaults` в домашний
каталог (том), помечая это файлом `~/.desktop-initialized`:

* `wallpaper.png` — обои;
* `Desktop/*.desktop` — ярлыки Home, File Manager, Terminal, Set Screen
  Resolution, Settings, Restart Desktop;
* `.config/lxsession/LXDE/autostart` — панель + рабочий стол + их
  автовосстановление;
* `.config/pcmanfm/LXDE/desktop-items-0.conf` — обои и настройки рабочего стола;
* `bin/` — вспомогательные скрипты.

Повторный запуск контейнера пользовательские изменения **не трогает**.

### Панель, окна, ярлыки

Панель (`lxpanel`) с меню приложений (`lxmenu-data`), переключателем окон и
часами, оконный менеджер — `openbox` с темой LXDE, рабочий стол — `pcmanfm
--desktop`: иконки, контекстное меню, перетаскивание, окна с заголовками,
рабочие области.

### Разрешение экрана

Ярлык «Set Screen Resolution» (или терминальная команда `set-resolution
1280x800`) пишет запрос в `~/.resolution-request`. Супервизор сессии его
замечает, перезапускает стек Xvfb/LXDE/x11vnc с новой геометрией и удаляет
запрос. Вкладка браузера переподключается сама (x11vnc `-forever`), нужно
подождать ~10 секунд. Разрешение также задаётся при создании сессии:
`create --resolution 1600x900`.

### Что происходит при сбое

Супервизор каждые 2 секунды проверяет Xvfb, x11vnc и `pcmanfm --desktop`;
упавший компонент поднимается автоматически, поэтому пользователь не видит
чёрный экран. `SIGTERM` корректно гасит все процессы (`docker stop`,
`docker compose down` работают чисто).

---

## 8. Тесты

```bash
python3 tests/test_acceptance.py
```

Проверяются все критерии приёмки: сборка образа, отсутствие Chrome, запуск
контейнера, доступ к noVNC, авторизация, две одновременные сессии, разные
дисплеи, изоляция данных, сохранность данных после рестарта контейнера,
применение лимитов, отказ при нехватке ресурсов без убийства работающих
сессий, отсутствие опубликованных VNC-портов, измеренный размер образа и
потребление памяти, а также **сквозной прогон пути браузера**: WebSocket → RFB
→ пиксели, с проверкой, что на кадре действительно дескстоп (обои, иконки,
панель), а не чёрный экран.

Отдельно проверяется пункт `7b`: живая сессия переживает полный
`docker compose down` + `up` — и вместе с ней сохраняются файлы
пользователя. Это самый частый способ «сломать» стек, поэтому он и стоит
отдельным тестом.

Вспомогательные инструменты:

* `tests/test_novnc_stream.py` — клиент на голом stdlib, повторяющий поведение
  noVNC в браузере (WebSocket + RFB + сохранение PNG);
* `tests/vnc_screenshot.py` — снимок экрана напрямую по RFB;
* `tests/des.py` — DES для VNC-аутентификации, проверен тест-вектором FIPS.

Артефакты (скриншоты) складываются в `tests/artifacts/`.

---

## 9. Известные ограничения

1. **TLS не настроен по умолчанию** — задача предполагает локальный доступ.
   Для интернета обязательно добавьте реверс-прокси с сертификатом (раздел 6).
   Caddy-конфиг готов, но намеренно не включён: без доменного имени он не
   запустится.
2. **Один пользователь без ролей** — по умолчанию автологин: кто открыл URL,
   тот и оператор (владелец всех сессий). HTTP Basic с одним логином и паролем
   остаётся (`MANAGER_AUTO_LOGIN=0`). Отдельных учёток «на каждого
   пользователя» нет: для этого нужен внешний identity-провайдер (OAuth,
   LDAP) и слой авторизации поверх `auth.Principal`.
3. **Один браузер на сессию** — x11vnc запущен с `-nevershared`: новый
   клиент вытесняет предыдущего. Это сделано намеренно (иначе брошенный
   клиент блокирует x11vnc на минуты), но одновременно два окна рабочего
   стола в разных вкладках работать не будут.
4. **Защита VNC-паролем — дополнительный слой.** В сессии с
   `SESSION_VNC_PASSWORD` x11vnc включает RFB-аутентификацию (максимум 8
   символов, ограничение протокола). Основная защита — менеджер; пароль
   полезен как второй рубеж, но не заменяет HTTPS.
5. **Звука и USB-устройств нет.** Xvfb их не эмулирует, в образе нет
   PulseAudio/ALSA — это сознательная экономия ~30 MB.
6. **OpenGL нет** (Mesa удалена). LXDE, файловый менеджер и терминал работают;
   3D/видео в браузере внутри сессии — нет. Для видео понадобится
   `mpv`/`ffplay` с программным декодированием.
7. **Разрешение меняется перезапуском X-стека** (~10 секунд недоступности).
   Живое изменение через RandR не используется намеренно: Xvfb не поддерживает
   создание режимов надёжно, и «почти работающая» смена разрешения хуже
   явного перезапуска.
8. **Иконки темы Tango.** `adwaita-icon-theme` удалён ради размера, поэтому
   часть GTK-приложений рисует простые пиктограммы. Для продакшена с
   приложениями добавьте `adwaita-icon-theme` (+16 MB).
9. **Резервное копирование — tar home-тома.** Согласованных снимков для
   работающей сессии нет; для консистентной копии остановите сессию
   (`stop <id>`), затем `backup`, затем `start`.
10. **Одновременная работа на одном диске.** `docker system df` и очистка
    образов — ваша ответственность; менеджер измеряет свободное место, но не
    удаляет ничего сам.
11. **Проверено на Docker Engine 29.6 / Docker Desktop 4.84, Debian 13
    внутри контейнера.** На cgroup v1 лимит `blkio_weight` передаётся
    (на v2 он отключается автоматически — иначе Docker отказывается создавать
    контейнер). На хостах с SELinux может понадобиться `:z` на монтировании
    тома.

---

## 10. Структура проекта

```
Dockerfile                       образ сессии (LXDE + Xvfb + x11vnc)
compose.yaml                     manager + docker-proxy + сборка образа
.dockerignore                    контекст сборки образа сессии
.env.example                     настройки по умолчанию (копируется в .env)
assets/wallpaper.png             обои рабочего стола
config/
  manager.yaml                   лимиты, пороги admission control, таймауты
  lxsession/desktop.conf         определение LXDE-сессии (WM, темы)
  entrypoint/
    entrypoint.sh                супервизор: Xvfb -> LXDE -> x11vnc
    bootstrap.sh                 первичная настройка домашнего каталога
    healthcheck.sh               проверка готовности (пассивная по порту)
    desktop-items/*.desktop      ярлыки рабочего стола
    lxde-profile/                профиль LXDE по умолчанию (копируется в $HOME)
      .config/lxsession/LXDE/autostart
      .config/pcmanfm/LXDE/desktop-items-0.conf
      bin/{set-resolution,lxde-restart}
manager/
  Dockerfile                     образ менеджера (+ noVNC)
  Dockerfile.dockerignore        контекст сборки менеджера
  requirements.txt
  app/
    main.py                      FastAPI: API, /s/, /ws/, healthcheck
    auth.py                      автологин, HTTP Basic, владение сессиями, WS-апгрейд
    service.py                   жизненный цикл сессии
    docker_ctl.py                узкий слой над Docker API
    scheduler.py                 admission control и очередь
    resources.py                 RAM/CPU/диск хоста
    store.py                     метаданные сессий (вне контейнеров)
    vncproxy.py                  WebSocket <-> RFB
    config.py                    конфигурация (файл + переменные окружения)
scripts/
  desktop-session.sh             CLI: create/list/stop/restart/delete/backup
  down.sh                        гарантированная остановка стека (bash)
  down.ps1                       то же самое для PowerShell
  resources.sh                   что сейчас ест ресурсы
  image-size.sh                  честные размеры образа
tests/
  test_acceptance.py             критерии приёмки (основной набор)
  test_novnc_stream.py           сквозной тест пути браузера + скриншот
  vnc_screenshot.py              снимок экрана по RFB
  des.py                         DES для VNC-аутентификации
  artifacts/                     скриншоты тестов
```
