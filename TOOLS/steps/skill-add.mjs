// Запись проверенного приёма в память работника тем же судом jev, что и на
// /api/flow/profile/memory/add (DOCS/decisions/068), — путь для терминала,
// когда сервер не поднят (DOCS/decisions/002). Аргументы — JSON на stdin:
// {"profile","title","when","how","proof","session"}. Отказ суда — код 2.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import fs from 'node:fs';

process.env.TYPESAFE_API_KEY = fs.readFileSync('.env', 'utf8')
    .match(/^TYPESAFE_API_KEY=(.*)$/m)[1].replace(/^["']|["']$/g, '');

const body = JSON.parse(fs.readFileSync(0, 'utf8'));
const { judgeSkill } = require('../../SYSTEM/core/work-judgment.js');
const { appendSkill, readMemory } = require('../../PROJECTS/Flow/profiles-server.js');
const { parseSkills } = require('../../SYSTEM/core/skill-hints.js');

const titles = parseSkills(readMemory(body.profile)).map((s) => s.title);
const verdict = await judgeSkill(body, titles);
console.log('VERDICT ' + JSON.stringify(verdict));
if (verdict && !verdict.ok) process.exit(2);
const res = appendSkill(body.profile, body);
console.log('APPENDED ' + JSON.stringify(res));
process.exit(res.ok ? 0 : 1);
