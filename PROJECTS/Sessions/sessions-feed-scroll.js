// ---------- прокрутка ----------

// Прокручиваем вниз только если пользователь и так был у низа ленты —
// иначе новые блоки во время стрима сбрасывали бы его к последнему сообщению.
// Проверять «у низа ли» нужно ДО того, как в ленту добавится новый блок:
// иначе scrollHeight уже вырастет на высоту этого блока, и даже если
// пользователь стоял у самого низа, дистанция окажется большой
export const NEAR_BOTTOM_PX = 80;

import { state } from './sessions-state.js';

export function isNearBottom() {
    const { scrollHeight, scrollTop, clientHeight } = state.messages;
    return scrollHeight - scrollTop - clientHeight <= NEAR_BOTTOM_PX;
}

export function scrollToBottom() {
    state.messages.scrollTop = state.messages.scrollHeight;
}