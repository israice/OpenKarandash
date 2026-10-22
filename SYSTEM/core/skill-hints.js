const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const PROFILES_DIR = path.join(ROOT, 'PROJECTS', 'Flow', 'profiles');
const MEMORY_FILE = path.join('memories', 'skills.md');
const PROFILE_BY_AGENT = { pi: 'Backend developer' };

function profileFor(agent, asked) {
    const name = String(asked || '').trim();
    if (name) return name;
    return PROFILE_BY_AGENT[String(agent || '').trim().split('-')[0]] || null;
}

function parseSkills(text) {
    const out = [];
    for (const block of String(text || '').split(/^## /m).slice(1)) {
        const title = block.split('\n')[0].trim();
        const field = (name) => (block.match(new RegExp(`\\*\\*${name}:\\*\\*\\s*([\\s\\S]*?)(?=\\n- \\*\\*|\\n\\n|$)`)) || [, ''])[1]
            .replace(/\s+/g, ' ').trim();
        if (title && !title.includes('?')) out.push({ title, when: field('Когда применим'), how: field('Что делать') });
    }
    return out;
}

const cache = new Map();

function skillsOf(profile) {
    const name = String(profile || '');
    if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) return [];
    let stat;
    try {
        stat = fs.statSync(path.join(PROFILES_DIR, name, MEMORY_FILE));
    } catch {
        return [];
    }
    const hit = cache.get(name);
    if (hit && hit.mtimeMs === stat.mtimeMs) return hit.skills;
    let skills = [];
    try {
        skills = parseSkills(fs.readFileSync(path.join(PROFILES_DIR, name, MEMORY_FILE), 'utf8')).slice(-60);
    } catch {
        skills = [];
    }
    cache.set(name, { mtimeMs: stat.mtimeMs, skills });
    return skills;
}

async function pickSkill() {
    return null;
}

function skillPreamble(skill) {
    if (!skill) return '';
    return `[OpenKarandash] Из памяти работника к этой задаче: «${skill.title}». `
        + `Когда применим: ${skill.when}. Что делать: ${skill.how} `
        + 'Это подсказка, а не обязательное правило: если случай не тот — забудь её и работай как обычно.\n\n';
}

function skillTrace(skill) {
    return skill ? { title: skill.title, match: skill.match } : null;
}

module.exports = { pickSkill, skillPreamble, skillTrace, parseSkills, skillsOf, profileFor };
