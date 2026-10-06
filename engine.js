/* The AFMP tuning controls, ported from the add-on's own code (auto_face_mocap_pro/__init__.py).

   Everything here is the SAME arithmetic the Blender add-on runs, not an imitation:

     _smooth_alpha(pct)   0.5 - 0.45 * clamp(pct/100, -1, 1)
                          -> 0 neutral, +100 = 0.05 (max smoothing), -100 = 0.95 (raw)
     strength             1.0 + 2.0 * clamp(pct/100, -1, 1)      (0 = natural 1.0)
     key routing          gaze keys -> Smooth Eye Look, speech keys -> Smooth Lipsync,
                          everything else -> Smooth Expressions   (_smooth_alpha_for)

   The add-on runs these over the traced curves on every slider tick ("live re-derive");
   so does this: derive() rebuilds all 52 curves from the raw trace in one pass. */

export const LIPSYNC_KEYS = new Set([
  'jawForward', 'jawLeft', 'jawOpen', 'jawRight',
  'mouthClose', 'mouthFunnel', 'mouthLeft',
  'mouthLowerDownLeft', 'mouthLowerDownRight',
  'mouthPressLeft', 'mouthPressRight', 'mouthPucker', 'mouthRight',
  'mouthRollLower', 'mouthRollUpper', 'mouthShrugLower', 'mouthShrugUpper',
  'mouthStretchLeft', 'mouthStretchRight',
  'mouthUpperUpLeft', 'mouthUpperUpRight',
  'tongueOut',
]);

// FACE_CONTROL_REGIONS["iris"] - the eight ARKit gaze keys
export const EYELOOK_KEYS = new Set([
  'eyeLookUpLeft', 'eyeLookUpRight', 'eyeLookDownLeft', 'eyeLookDownRight',
  'eyeLookInLeft', 'eyeLookInRight', 'eyeLookOutLeft', 'eyeLookOutRight',
]);

const clamp = (v, a, b) => v < a ? a : (v > b ? b : v);

export function smoothAlpha(pct) {
  return 0.5 - 0.45 * clamp(pct / 100, -1, 1);
}
export function strengthFactor(pct) {
  return 1.0 + 2.0 * clamp(pct / 100, -1, 1);
}

export function defaultSliders() {
  return {
    strength: 0,          // "Facial Expressions Intensity" / Strength
    smoothExpr: -60,      // the panel's own default, in -100..100 units (shows -0.60)
    smoothLip: -60,
    smoothEye: 0,
    lipsyncStrength: 0,
    mouthShiftLeft: 0,
    mouthShiftRight: 0,
    mouthLipOpen: 0,
    mouthPucker: 0,
    mouthFunnel: 0,
    mouthOpen: 0,
  };
}

/* The four mouth-shaping controls drive their ARKit keys directly. The add-on's own
   fold-in for these was not locatable in the source, so this is a plain additive
   mapping - a slider adds to the key it is named after, then the value is clamped. */
const MOUTH_TARGETS = {
  mouthLipOpen: ['mouthClose', 'jawOpen'],
  mouthPucker:  ['mouthPucker'],
  mouthFunnel:  ['mouthFunnel'],
  mouthOpen:    ['jawOpen', 'mouthLowerDownLeft', 'mouthLowerDownRight'],
};

/*  raw: { fps, n_frames, tracks:[[frame,{key:value}]], blendshape_names }  */
export function makeDeriver(raw) {
  const names = raw.blendshape_names;
  const nFrames = raw.tracks.length;
  const series = {};                     // key -> Float32Array of raw values
  for (const nm of names) {
    const arr = new Float32Array(nFrames);
    for (let i = 0; i < nFrames; i++) {
      const t = raw.tracks[i][1];
      arr[i] = t && t[nm] !== undefined ? t[nm] : 0;
    }
    series[nm] = arr;
  }
  const out = {};
  for (const nm of names) out[nm] = new Float32Array(nFrames);

  const groupOf = nm => EYELOOK_KEYS.has(nm) ? 'eye' : (LIPSYNC_KEYS.has(nm) ? 'lip' : 'expr');

  /* Rebuild every curve from the raw trace using the sliders. Returns the curves,
     ready to be sampled by frame index during playback. */
  function derive(s) {
    const strength = strengthFactor(s.strength);
    const lipGain = strengthFactor(s.lipsyncStrength);
    const alpha = {
      expr: smoothAlpha(s.smoothExpr),
      lip: smoothAlpha(s.smoothLip),
      eye: smoothAlpha(s.smoothEye),
    };
    // Mouth Shift leans the sideways speech pair only (the add-on narrowed it to
    // this set after the wider version squashed the mouth).
    const sided = ['jawLeft', 'jawRight', 'mouthLeft', 'mouthRight',
                   'mouthPressLeft', 'mouthPressRight',
                   'mouthLowerDownLeft', 'mouthLowerDownRight'];
    const shiftL = clamp(s.mouthShiftLeft / 100, -1, 1);
    const shiftR = clamp(s.mouthShiftRight / 100, -1, 1);

    // explicit mouth-shaping offsets, per ARKit key
    const add = {};
    for (const k in MOUTH_TARGETS) {
      const v = clamp((s[k] || 0) / 100, -1, 1);
      if (!v) continue;
      for (const t of MOUTH_TARGETS[k]) add[t] = (add[t] || 0) + v;
    }

    for (const nm of names) {
      const src = series[nm];
      const dst = out[nm];
      const a = alpha[groupOf(nm)];
      const scale = (LIPSYNC_KEYS.has(nm) ? strength * lipGain : strength);
      let prev = 0;
      for (let i = 0; i < nFrames; i++) {
        let v = src[i] * scale;
        if (add[nm]) v += add[nm];
        if (sided.includes(nm)) {
          const lean = /Left$/.test(nm) ? shiftL : shiftR;
          const away = /Left$/.test(nm) ? shiftR : shiftL;
          v = v * (1 + lean) - v * away * 0.5;
        }
        v = clamp(v, 0, 1);
        prev = a * v + (1 - a) * prev;    // the add-on's EMA (higher alpha = lighter)
        dst[i] = prev;
      }
    }
    return out;
  }

  return { names, nFrames, fps: raw.fps, derive, series };
}
