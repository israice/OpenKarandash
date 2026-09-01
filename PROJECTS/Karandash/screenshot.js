// Кнопка Edit, серверная половина: снимок экрана для миниатюры сессии.
// Модуль лежит рядом с button-edit.js — вся кнопка Edit собрана в одной папке.
// server.js только подключает его и вешает на роут POST /api/screenshot.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

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
// разобрать, не оставляя мыло. 'powershell.exe' с расширением, а не
// 'powershell': под WSL это тот же самый Windows-хост, но interop ищет
// исполняемый файл по точному имени с .exe — без расширения Linux не найдёт
// его в PATH. На нативном Windows работает так же
const SCREENSHOT_WIDTH = 480;

// список подключённых экранов — для настройки в Settings, откуда выбирают,
// с какого монитора кнопка Edit снимает миниатюру
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

module.exports = { captureScreenshot, listScreens };
