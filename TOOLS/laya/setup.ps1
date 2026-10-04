# Ставит Laya в окружение проекта: TOOLS/laya/.venv.
#
#   powershell -ExecutionPolicy Bypass -File TOOLS/laya/setup.ps1
#
# Чекпойнты HF кладутся в TOOLS/laya/hf-cache, а не в профиль пользователя:
# иначе профиль пользователя тащит за собой сотни мегабайт весов, которые к
# проекту не относятся. В git не попадает ни то, ни другое (.gitignore).
$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$venv = Join-Path $here '.venv'
$cache = Join-Path $here 'hf-cache'
$python = 'py -3.13'

if (-not (Test-Path -LiteralPath $venv)) {
    & $python -m venv $venv
}
New-Item -ItemType Directory -Force -Path $cache | Out-Null

$env:HF_HOME = $cache
$py = Join-Path $venv 'Scripts\python.exe'

& $py -m pip install --upgrade pip
& $py -m pip install laya
& $py -c "import laya; print('laya', laya.__version__)"
& $py -c "import laya, os; print('HF_HOME', os.environ.get('HF_HOME'))"