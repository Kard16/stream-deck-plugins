// Constants shared by the tools, from lightroom/protocol/PROTOCOL.md (v1).

export const PROTOCOL_VERSION = 1;
export const CMD_PORT = 58780; // Lightroom receives commands here
export const EVT_PORT = 58781; // Lightroom sends events here
export const TEST_CATALOG = '/Users/karimdhanji/Pictures/Plugin Test/Plugin Test.lrcat';

// The guard's rule for catalog paths (PROTOCOL.md, Guard): the same path, compared without case.
export const sameCatalog = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

// The dial banks' params, in bank order (plan.md, kickoff answer 1).
export const BANK_PARAMS = Object.freeze([
  'Temperature', 'Tint', 'Exposure', 'Contrast',
  'Highlights', 'Shadows', 'Whites', 'Blacks',
  'Texture', 'Clarity', 'Vibrance', 'Saturation',
  'PostCropVignetteAmount',
]);

// LrDevelopController parameter names the mock accepts (docs/research/lightroom-classic-sdk.md §2.2).
// Anything else is a param getRange rejects, so set, reset and watch answer err bad.
const COLORS = ['Red', 'Orange', 'Yellow', 'Green', 'Aqua', 'Blue', 'Purple', 'Magenta'];
export const PARAMS = Object.freeze([
  ...BANK_PARAMS,
  'Brightness', 'Dehaze', 'PresetAmount', 'ProfileAmount',
  'ParametricDarks', 'ParametricLights', 'ParametricShadows', 'ParametricHighlights',
  'ParametricShadowSplit', 'ParametricMidtoneSplit', 'ParametricHighlightSplit', 'CurveRefineSaturation',
  ...COLORS.flatMap((c) => [`HueAdjustment${c}`, `SaturationAdjustment${c}`, `LuminanceAdjustment${c}`, `GrayMixer${c}`]),
  'SplitToningShadowHue', 'SplitToningShadowSaturation', 'ColorGradeShadowLum',
  'SplitToningHighlightHue', 'SplitToningHighlightSaturation', 'ColorGradeHighlightLum',
  'ColorGradeMidtoneHue', 'ColorGradeMidtoneSat', 'ColorGradeMidtoneLum',
  'ColorGradeGlobalHue', 'ColorGradeGlobalSat', 'ColorGradeGlobalLum', 'SplitToningBalance', 'ColorGradeBlending',
  'Sharpness', 'SharpenRadius', 'SharpenDetail', 'SharpenEdgeMasking',
  'LuminanceSmoothing', 'LuminanceNoiseReductionDetail', 'LuminanceNoiseReductionContrast',
  'ColorNoiseReduction', 'ColorNoiseReductionDetail', 'ColorNoiseReductionSmoothness',
  'PostCropVignetteMidpoint', 'PostCropVignetteFeather', 'PostCropVignetteRoundness',
  'PostCropVignetteStyle', 'PostCropVignetteHighlightContrast',
  'GrainAmount', 'GrainSize', 'GrainFrequency',
  'LensProfileDistortionScale', 'LensProfileVignettingScale', 'LensManualDistortionAmount',
  'DefringePurpleAmount', 'DefringePurpleHueLo', 'DefringePurpleHueHi',
  'DefringeGreenAmount', 'DefringeGreenHueLo', 'DefringeGreenHueHi',
  'VignetteAmount', 'VignetteMidpoint',
  'PerspectiveVertical', 'PerspectiveHorizontal', 'PerspectiveRotate', 'PerspectiveScale',
  'PerspectiveAspect', 'PerspectiveX', 'PerspectiveY',
  'ShadowTint', 'RedHue', 'RedSaturation', 'GreenHue', 'GreenSaturation', 'BlueHue', 'BlueSaturation',
  'straightenAngle',
]);

// Ranges measured on the user's raws (PROTOCOL.md, Develop values). Every other param is -100..100.
const RAW_RANGES = { Temperature: [2000, 50000], Tint: [-150, 150], Exposure: [-5, 5] };
// JPEG and other rendered files: Temperature and Tint are -100..100 (PROTOCOL.md, Fixtures: setup.ranges).
const RENDERED_RANGES = { Temperature: [-100, 100], Tint: [-100, 100], Exposure: [-5, 5] };
const OTHER_RANGE = [-100, 100];

export const RAW_FORMATS = Object.freeze(['RAW', 'DNG']);
export const isRawFormat = (fmt) => RAW_FORMATS.includes(String(fmt).toUpperCase());

export function defaultRange(fmt, param) {
  const table = isRawFormat(fmt) ? RAW_RANGES : RENDERED_RANGES;
  return [...(table[param] ?? OTHER_RANGE)];
}

// What a slider reads before anyone touches it: 0, except a raw's Temperature, which is "As Shot".
export function defaultValue(fmt, param) {
  if (param === 'Temperature' && isRawFormat(fmt)) return 5500;
  return 0;
}

export const LABELS = Object.freeze(['red', 'yellow', 'green', 'blue', 'purple', 'none']);
export const MODULES = Object.freeze(['library', 'develop', 'map', 'book', 'slideshow', 'print', 'web']);

// LrDate.currentTime(): seconds since 2001-01-01 00:00:00 UTC.
const COCOA_EPOCH_MS = Date.UTC(2001, 0, 1);
export const lrTime = (wallMs = Date.now()) => (wallMs - COCOA_EPOCH_MS) / 1000;

// "58780,58781" or "0,0" → [58780, 58781]. Throws on anything else.
export function parsePorts(text) {
  const parts = String(text).split(',').map((s) => s.trim());
  const nums = parts.map(Number);
  if (parts.length !== 2 || nums.some((n) => !Number.isInteger(n) || n < 0 || n > 65535)) {
    throw new Error(`--ports wants two port numbers like 59780,59781 (0 picks a free one), got "${text}"`);
  }
  return nums;
}
