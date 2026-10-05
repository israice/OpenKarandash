// Всё, что в any.js знает про Hermes Agent конкретно.
//
// Отличие от остальных семейств не в потоке событий, а в самом способе хода:
// у hermes нет подкоманды `run` вовсе (есть `chat`, `serve`, `acp` и прочие
// сервисные), а ход на один промпт делает флагом `-z/--oneshot`. Из-за этого
// общий коннектор уводил hermes в семейство plain и слал `hermes run "…"` —
// CLI отвечал «'run' is not a `hermes` command» (DOCS/decisions/100).
//
// Второе отличие — учёт. `-z` печатает в stdout только итоговый текст ответа:
// ни баннера, ни спиннера, ни превью инструментов, ни session_id. Токены и цена
// приходят отдельным файлом (`--usage-file`), который hermes пишет всегда — в том
// числе когда ход упал, — и в нём же лежит session_id следующего `--resume`.
// Поэтому ход здесь разбирается целиком, а не построчно, как у openclaw.
const fs = require('fs');
const path = require('path');
const os = require('os');

// Уровни размышления hermes называет своими словами в `--reasoning LEVEL`:
// none, minimal, low, medium, high, xhigh, max, ultra. Наш общий список
// (SYSTEM/model-effort.js) отличается одним значением — `off` у hermes это
// `none`, — поэтому уровень переводится, а неизвестный не уходит в CLI вовсе:
// лишний флаг hermes отверг бы ошибкой вместо хода
const REASONING = {
    off: 'none', minimal: 'minimal', low: 'low', medium: 'medium',
    high: 'high', xhigh: 'xhigh', max: 'max', ultra: 'ultra',
};

// Файл отчёта об одном ходе переживает ровно один ход: его читает CLI и
// забывает, поэтому уборка сразу после выхода процесса
function usagePath() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karandash-hermes-'));
    return { file: path.join(dir, 'usage.json'), dir };
}

// Уборка синхронная намеренно: её зовут в finally без await (см. any.js), а
// fs.rm возвращает обещание — оно успело бы протухнуть, и в %TEMP% копились бы
// каталоги с отчётами по всей истории диалога
function remove(dir) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* уборка не должна ронять ход */ }
}

// Модель уходит двумя флагами, а не одним. hermes зовёт модель «поставщик/модель»
// и отдельно — шлюз: `-m stealth/space-bunny-alpha --provider openrouter`. Наш
// путь трёхуровневый (шлюз/поставщик/модель, SYSTEM/model-path.js), поэтому
// первый уровень уходит в `--provider`, а остаток — в `-m`.
//
// Проверено вживую: с путём целиком (`-m openrouter/stealth/…`) hermes не
// отвечает вовсе — уходит искать шлюз по такому имени и возвращается только
// по сторожу молчания. С разделением флагов ход идёт за секунды.
function modelFlags(model) {
    const parts = String(model || '').split('/').filter(Boolean);
    if (parts.length < 2) return model ? ['-m', parts[0]] : [];
    return ['--provider', parts[0], '-m', parts.slice(1).join('/')];
}

// Каталог моделей. Отдельной командой он не отдаётся: `hermes model` —
// интерактивный выборщик, и без TTY он не печатает ничего пригодного. Зато
// `hermes config get model` отдаёт текущий выбор текстом (default, provider),
// и одна эта строка — честный минимум для строки выбора: пустой список выглядел
// бы как «у Hermes моделей нет», а модель у него есть и работает
function models({ target, capture, timeoutMs }) {
    const text = capture(target, ['config', 'get', 'model'], timeoutMs);
    const provider = text.match(/^\s*provider:\s*(\S+)\s*$/m);
    const model = text.match(/^\s*default:\s*(\S+)\s*$/m);
    if (!model) return [];
    const name = model[1];
    // Модель приходит путём поставщика («stealth/space-bunny-alpha»), а строка
    // выбора ждёт наш путь с шлюзом первым — иначе уровень Gateway в каскаде
    // путался бы с поставщиком (SYSTEM/model-path.js)
    return [provider && !name.startsWith(`${provider[1]}/`) ? `${provider[1]}/${name}` : name];
}

// Флаги запуска хода. `-z` — единственный у hermes способ дать один промпт и
// получить только ответ; промпт идёт аргументом (`--message-file` у hermes нет,
// а ход наш — это пересказ истории на сотни килобайт, который командная строка
// Windows не берёт; ограничение примет первый большой ход и уведёт в обрезанном
// виде). Продолжение сессии — `--resume` её собственного session_id, который
// приходит из отчёта (см. ask)
function buildArgs({ model, effort, resumeId, text }) {
    const { file, dir } = usagePath();
    const args = ['-z', text, '--usage-file', file];
    if (model) args.push(...modelFlags(model));
    if (effort && REASONING[effort]) args.push('--reasoning', REASONING[effort]);
    if (resumeId) args.push('--resume', resumeId);
    return { args, cleanup: () => remove(dir), usage: file };
}

// Отчёт о ходе: hermes пишет его всегда, поэтому отсутствие файла — это не
// ошибка хода, а просто нет данных об учёте. Плоский разбор: все счётчики
// лежат на верхнем уровне, блок `auxiliary` (титулы, сжатие, зрение) —
// побочные вызовы, и в строку хода они не идут, как и у openclaw
function readUsage(file) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return null;
    }
}

// Ход hermes: stdout — это и есть ответ (см. шапку файла), а session_id для
// следующего хода лежит в отчёте. Поэтому begin() — после чтения отчёта, а не
// до запуска: у первого хода id ещё не у кого взять, иначе он был бы null
async function ask({ ctx, cli, target, args, usage, timeoutMs }) {
    const stdout = await cli(target, args, {
        timeoutMs,
        onSpawn: (child) => { ctx.run.child = child; },
    }).catch((err) => { ctx.fail(err.message); return ''; });

    const report = readUsage(usage);
    ctx.begin(report?.session_id || null);
    if (report?.turn_exit_reason) ctx.meta.stopReason = report.turn_exit_reason;

    const answer = String(stdout || '').trim();
    if (!answer) {
        // Отчёта нет — ход не начался (незнакомая модель, нет ключа, отказ
        // провайдера): об отказе уже сказала сама cli, и второй текст в ленте
        // был бы повтором того же самого
        if (!report) return;
        // Отчёт есть, а ответа нет: ход дошёл до конца и молчал (прерван, остановлен
        // на полпути, или не нашлось ни одного текстового блока). Молчать здесь
        // нельзя — потерялось бы всё, что агент успел сделать, — и объяснение
        // берётся из самого отчёта
        ctx.fail(report.failure || report.turn_exit_reason || 'hermes returned an empty answer');
        return;
    }
    ctx.answer = answer;
    ctx.emit({ type: 'text', text: answer });

    ctx.meta.usage.inputTokens += report?.input_tokens || 0;
    ctx.meta.usage.outputTokens += report?.output_tokens || 0;
    ctx.meta.usage.cacheReadTokens += report?.cache_read_tokens || 0;
    ctx.meta.usage.cacheCreationTokens += report?.cache_write_tokens || 0;
    ctx.meta.lastRequestTokens = (report?.input_tokens || 0) + (report?.cache_read_tokens || 0) + (report?.cache_write_tokens || 0);
    if (typeof report?.estimated_cost_usd === 'number') ctx.meta.costUsd = (ctx.meta.costUsd || 0) + report.estimated_cost_usd;
}

module.exports = { buildArgs, models, ask, modelFlags };