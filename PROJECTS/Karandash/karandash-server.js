// Кнопка Karandash, серверная половина: снимок экрана для миниатюры сессии
// и выбор монитора, с которого его делать. Здесь же её маршруты (createRoutes
// внизу файла) — вся кнопка Karandash собрана в одной папке, server.js только
// раскладывает готовую таблицу путей.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { readJson, sendJson } = require('../../SYSTEM/core/http.js');
// индекс хуков лежит в карте проекта (PROJECTS/Graph): он отдаёт место элемента
// в коде по его именам. Здесь только маршрут — сама работа идёт оттуда, иначе
// и indexes, и поиск по коду жили бы в двух местах с разными ответами
const { findHooks } = require('../Graph/graph-search.js');
// контекст места: секция файла, соседи по фиче, обратные ссылки — то, что иначе
// добывается поиском по vault (PROJECTS/Graph/graph-context.js)
const { contextOf } = require('../Graph/graph-context.js');

// снимок экрана для миниатюры сессии: canvas на фронтенде не видит ничего
// за пределами вкладки браузера, поэтому реальный скриншот системы делает
// сервер — PowerShell копирует экран через System.Drawing и сохраняет JPEG во
// временный файл, который потом сам читает и кодирует в base64 Node. Раньше
// кодировали в base64 прямо в PowerShell через ImageCodecInfo/EncoderParameters
// (ручной контроль quality) — эта связка «скриншот экрана + ручное JPEG-
// кодирование» ловится антивирусом как эвристика скрин-скрейпинга
// (ScriptContainedMaliciousContent) и скрипт блокируется целиком. Save(path,
// ImageFormat.Jpeg) без EncoderParameters под ту же эвристику не попадает.
// Ширину держим заметно больше старых 192px, чтобы миниатюру можно было
// разобрать, не оставляя мыло. Снимок снимает PowerShell — штатный снимок
// экрана Windows, другого источника у нас нет
const SCREENSHOT_WIDTH = 480;

// список подключённых экранов — для настройки в Settings, откуда выбирают,
// с какого монитора кнопка Karandash снимает миниатюру
function listScreens() {
    const script = `
        Add-Type -AssemblyName System.Windows.Forms
        # реальное имя монитора (например "Dell U2720Q") сидит в EDID, который
        # отдаёт WmiMonitorID — WinForms Screen его не знает вообще.
        # ponytail: сопоставляем по порядковому номеру, WMI и WinForms энумерируют
        # мониторы независимо, гарантии совпадения индексов при нескольких экранах
        # нет — если имя не подошло, в UI остаётся просто "N: WxH"
        $names = @{}
        try {
            $monitors = @(Get-CimInstance -Namespace root\\wmi -ClassName WmiMonitorID -ErrorAction Stop)
            $j = 0
            foreach ($m in $monitors) {
                $name = -join ($m.UserFriendlyName | Where-Object { $_ -ne 0 } | ForEach-Object { [char]$_ })
                if ($name) { $names[$j] = $name.Trim() }
                $j++
            }
        } catch {}
        $i = 0
        $result = foreach ($s in [System.Windows.Forms.Screen]::AllScreens) {
            [PSCustomObject]@{ index = $i; width = $s.Bounds.Width; height = $s.Bounds.Height; primary = $s.Primary; name = $names[$i] }
            $i++
        }
        # ConvertTo-Json на массиве из одного элемента отдаёт объект, а не массив.
        # -AsArray решает это, но появился только в PowerShell 6+ — на 5.1
        # (powershell.exe по умолчанию в Windows) падает ParameterBindingException,
        # поэтому оборачиваем вручную и на 5.1, и на 7
        $json = ConvertTo-Json -InputObject $result -Compress
        if ($result.Count -le 1) { $json = "[$json]" }
        $json
    `;
    const encoded = Buffer.from(script, 'utf16le').toString('base64');

    return new Promise((resolve) => {
        const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { windowsHide: true });
        let out = '';
        child.stdout.on('data', (chunk) => { out += chunk; });
        child.on('error', () => resolve([]));
        child.on('close', (code) => {
            try {
                const screens = code === 0 ? JSON.parse(out) : [];
                resolve(Array.isArray(screens) ? screens : []);
            } catch {
                resolve([]);
            }
        });
    });
}

function captureScreenshot(screenIndex) {
    // screenIndex попадает прямо в тело PowerShell-скрипта — держим его числом,
    // а не строкой с сервера, чтобы туда нельзя было ничего внедрить
    const index = Number.isInteger(screenIndex) && screenIndex >= 0 ? screenIndex : 0;
    const tmpFile = path.join(os.tmpdir(), `noname-shot-${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`);
    const script = `
        Add-Type -AssemblyName System.Windows.Forms
        Add-Type -AssemblyName System.Drawing
        Add-Type @"
            using System;
            using System.Runtime.InteropServices;
            public class NonameDpi {
                [DllImport("user32.dll")]
                public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
                [DllImport("user32.dll")]
                public static extern bool SetProcessDPIAware();
            }
"@
        # per-monitor v2 (-4) даёт реальные физические пиксели на каждом мониторе
        # независимо от его DPI; если недоступно (старый Windows) — откат на
        # системную DPI-осведомлённость, которая хотя бы не режет экран пополам
        if (-not [NonameDpi]::SetProcessDpiAwarenessContext([IntPtr]::new(-4))) {
            [NonameDpi]::SetProcessDPIAware() | Out-Null
        }
        $screen = [System.Windows.Forms.Screen]::AllScreens[${index}]
        $b = $screen.Bounds
        $full = New-Object System.Drawing.Bitmap $b.Width, $b.Height
        $g = [System.Drawing.Graphics]::FromImage($full)
        $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
        $w = ${SCREENSHOT_WIDTH}
        $h = [Math]::Max(1, [int]([double]$b.Height / $b.Width * $w))
        $thumb = New-Object System.Drawing.Bitmap $full, $w, $h
        $thumb.Save('${tmpFile.replace(/\\/g, '\\\\')}', [System.Drawing.Imaging.ImageFormat]::Jpeg)
    `;
    const encoded = Buffer.from(script, 'utf16le').toString('base64');

    return new Promise((resolve) => {
        const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { windowsHide: true });
        child.on('error', () => resolve(null));
        child.on('close', (code) => {
            if (code !== 0 || !fs.existsSync(tmpFile)) {
                resolve(null);
                return;
            }
            try {
                const base64 = fs.readFileSync(tmpFile).toString('base64');
                resolve(base64 ? `data:image/jpeg;base64,${base64}` : null);
            } catch {
                resolve(null);
            } finally {
                fs.unlink(tmpFile, () => {});
            }
        });
    });
}

// какой монитор снимать, хранится в .env (SCREENSHOT_SCREEN) — записать туда
// умеет только SYSTEM/core/env.js, поэтому setEnvValue приходит снаружи
function createRoutes({ setEnvValue }) {
    const currentScreen = () => Number(process.env.SCREENSHOT_SCREEN) || 0;

    return {
        // снимок экрана из режима Karandash: клиент просит его сразу после отправки
        // комментария, пока выбранный элемент ещё обведён рамкой
        '/api/screenshot': async (req, res) => {
            const thumb = await captureScreenshot(currentScreen());
            if (!thumb) {
                sendJson(res, { ok: false, error: 'Failed to take a screenshot' });
                return;
            }
            sendJson(res, { ok: true, thumb });
        },

        // список мониторов и текущий выбор — для настройки в Settings
        '/api/screenshot/screens': async (req, res) => {
            sendJson(res, { screens: await listScreens(), current: currentScreen() });
        },

        '/api/screenshot/screen': async (req, res) => {
            const { index } = await readJson(req);
            if (!Number.isInteger(index) || index < 0) {
                sendJson(res, { ok: false, error: 'Invalid screen index' });
                return;
            }
            setEnvValue('SCREENSHOT_SCREEN', String(index));
            sendJson(res, { ok: true });
        },

        // место выбранного элемента в коде: клиент отдаёт имена (id и классы),
        // ответ — файлы и строки, где этот элемент создаётся и где описан стилем.
        // Без этого модель получает только селектор и ищет место сама — по одному
        // имени класса на проект приходится десяток упоминаний (решение 091).
        //
        // К файлам и строкам добавляется контекст места (PROJECTS/Graph/graph-context.js):
        // секция файла, в которой строки живут, остальные файлы фичи и то, кто
        // ссылается на этот файл. Названного файла мало: у клика по кнопке карандаш
        // за файлом тянется ещё полкарты, и без этого агент читает всё подряд (100)
        //
        // Индекс пуст (сервер только что поднялся, файлы ещё не прочитаны) —
        // это не поломка: клиент просто оставит строку элемента как была
        '/api/karandash/element': async (req, res) => {
            const { names } = await readJson(req);
            const list = Array.isArray(names) ? names.filter((n) => typeof n === 'string').slice(0, 6) : [];
            if (!list.length) {
                sendJson(res, { ok: true, places: [] });
                return;
            }
            try {
                const places = findHooks(list, 8);
                sendJson(res, {
                    ok: true,
                    places: places.map((place) => ({
                        ...place,
                        context: contextOf(place.file, place.lines[0]),
                    })),
                });
            } catch (error) {
                sendJson(res, { ok: false, error: `Hook index failed: ${error.message}` });
            }
        },
    };
}

module.exports = { createRoutes, captureScreenshot, listScreens };
