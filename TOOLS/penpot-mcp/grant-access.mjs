// Выдаёт человеку доступ к команде Penpot без приглашения и без письма.
//
// Смысл: файл макета лежит в команде сервисного аккаунта, и любой, кто открыл
// Penpot в своём браузере (например PROJECTS/Penpot/page.js встраивает канвас
// в iframe), видит «You don't have access to this file» — Penpot отдаёт такой
// текст всем, кто не состоит в команде файла. Официальный путь — приглашение
// (create-team-invitations), но он требует письма и клика по ссылке, а это ровно
// то «одобрение», которого мы хотим избежать. Поэтому членство пишем прямо в
// team_profile_rel: профиль по e-mail и строка связи с командой. Уже созданный
// в Penpot аккаунт (он появляется при первом входе) получает права сразу, после
// обычного обновления страницы — ни логина, ни письма, ни подтверждения.
//
// Запуск из корня проекта:
//   node TOOLS/penpot-mcp/grant-access.mjs                       — e-mail из .env
//   node TOOLS/penpot-mcp/grant-access.mjs someone@example.com   — свой список
//
// Кому: PENPOT_VIEWER_EMAILS (через запятую) в .env, если ключа нет — список
// пустой и скрипт ничего не меняет. Команда берётся из PENPOT_TEAM_ID.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const DB_CONTAINER = 'penpot-penpot-postgres-1';

function env() {
    const out = {};
    try {
        for (const line of fs.readFileSync(new URL('../../.env', import.meta.url), 'utf8').split('\n')) {
            const m = line.trim().match(/^([A-Z0-9_]+)=(.*)$/);
            if (m) out[m[1]] = m[2].trim();
        }
    } catch {}
    return out;
}

const ENV = env();
const team = ENV.PENPOT_TEAM_ID;
const emails = [...new Set((process.argv.slice(2).join(',') || ENV.PENPOT_VIEWER_EMAILS || '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean))];

if (!team) throw new Error('в .env нет PENPOT_TEAM_ID');
if (!emails.length) throw new Error('не указан ни один e-mail: PENPOT_VIEWER_EMAILS в .env или аргумент');

// Права can-edit — редактор команды: видит файл и может править макет вместе с
// агентом. Повторный запуск ничего не ломает (NOT EXISTS), чужие команды не
// трогаются: работаем только с указанной.
const sql = `DO $$
DECLARE e text; pid uuid;
BEGIN
    FOR e IN SELECT unnest(ARRAY[${emails.map((m) => `'${m}'`).join(',')}]) LOOP
        SELECT id INTO pid FROM profile WHERE lower(email) = e AND deleted_at IS NULL;
        IF pid IS NULL THEN
            RAISE NOTICE 'аккаунта % в Penpot нет — пропускаем (он появится при первом входе)', e;
        ELSIF NOT EXISTS (SELECT 1 FROM team_profile_rel WHERE team_id = '${team}' AND profile_id = pid) THEN
            INSERT INTO team_profile_rel (team_id, profile_id, is_admin, is_owner, can_edit)
            VALUES ('${team}', pid, false, false, true);
            RAISE NOTICE 'добавлен в команду: %', e;
        ELSE
            RAISE NOTICE 'уже в команде: %', e;
        END IF;
    END LOOP;
END $$;`;

const psql = (query) => execFileSync('docker', ['exec', DB_CONTAINER, 'psql', '-U', 'penpot', '-d', 'penpot',
    '-v', 'ON_ERROR_STOP=1', '-c', query], { encoding: 'utf8' });
psql(sql);
console.log(psql(`SELECT p.email, r.is_owner, r.can_edit FROM team_profile_rel r`
    + ` JOIN profile p ON p.id = r.profile_id WHERE r.team_id = '${team}' ORDER BY r.is_owner DESC, p.email;`));