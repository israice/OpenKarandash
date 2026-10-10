// Константы и конфигурация песочных часов.
export const ROOT_SELECTOR = '.sandglass';
export const CANVAS_SELECTOR = 'canvas.hourglass';

export const G = 75;
export const H = 15.5;
export const BULB_R = 10.5;
export const NECK_R = 1.3;
export const CAP_R = 5.2;
export const WAIST_Y = 0.62 * H;
export const THROAT_H = 0.6;

export const GRAINS_N = 2000;
export const PACKING = 0.62;
export const DT = 1 / 120;
export const MAX_STEPS = 3;
export const V_MAX = 60;
export const SLEEP_SP2 = 0.25;
export const REL_CAP = 60;
export const BANDS = 12;

export const POPOVER_GAP = 10;
export const VIEWPORT_EDGE_MARGIN = 8;

export const WAL_TRIM_BYTES = 8 * 1024 * 1024;
export const COMPACT_MIN_BYTES = 64 * 1024 * 1024;

export const WBANDS = 30;
export const SEGS = 26;
export const WALL_T = 0.9;

export const Y_HOLD_MULT = 1.4;
export const HOLD_R_MULT = 1.9;
export const FEED_Y_MULT = 9;
export const FEED_R_MULT = 2.2;