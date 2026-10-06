import * as THREE from './lib/three.module.js';
import { GLTFLoader } from './lib/loaders/GLTFLoader.js';
import { loadMorphs, bindMorphs } from './morphs.js';
import { makeDeriver, defaultSliders } from './engine.js';

/* ------------------------------------------------------------------ config */
const CHARACTERS = [
  { id: 'snow', label: 'Snow' },
  { id: 'rain', label: 'Rain' },
  { id: 'jay',  label: 'jay'  },
  { id: 'kun',  label: 'Kun'  },
  { id: 'chan', label: 'Chan' },
];
const CLIPS = [
  { id: 'clip1', label: 'Hailuo 10s', file: 'clips/clip1.mp4', data: 'data/clip1.json' },
  { id: 'clip2', label: 'Hailuo 14s', file: 'clips/clip2.mp4', data: 'data/clip2.json' },
  { id: 'clip3', label: 'kling 6s',   file: 'clips/clip3.mp4', data: 'data/clip3.json' },
];
/* The panel's rows, in the order the real panel draws them, with the add-on's own
   labels. Values are stored -100..100 and DISPLAYED as -1.00..1.00, which is how the
   Blender panel shows them (see _probe/panel_zoom.png). */
const SLIDERS = [
  { key: 'strength',        label: 'Facial Expressions Intensity' },
  { key: 'smoothExpr',      label: 'Smooth Expressions' },
  { key: 'lipsyncStrength', label: 'Lipsync Strength' },
  { key: 'smoothLip',       label: 'Smooth Lipsync' },
  { key: 'mouthShiftLeft',  label: 'Mouth Lipsync Shift (Left Right)' },
  { key: 'mouthShiftRight', label: 'Mouth Lipsync Shift (Right Left)' },
  { key: 'smoothEye',       label: 'Smooth Eye Look' },
  { key: 'mouthLipOpen',    label: 'Mouth Lip Open' },
  { key: 'mouthPucker',     label: 'Mouth Pucker' },
  { key: 'mouthFunnel',     label: 'Mouth Funnel' },
  { key: 'mouthOpen',       label: 'Mouth Open' },
];
const FRAME_W = 1280, FRAME_H = 720;

const $ = id => document.getElementById(id);
const state = {
  character: 'snow', clip: CLIPS[0], sliders: defaultSliders(),
  curves: null, nFrames: 0, fps: 24, tray: [], playing: false, sideBySide: false, follow: true,
};

/* ------------------------------------------------------- fit the Blender frame */
function fit() {
  const wrap = $('blWrap');
  const k = Math.max(0.25, wrap.clientWidth / FRAME_W);
  wrap.style.setProperty('--bl-scale', k);
  wrap.style.height = (FRAME_H * k) + 'px';
}
new ResizeObserver(fit).observe($('blWrap'));

/* ------------------------------------------------------------------- three */
const canvas = $('blCanvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
const scene = new THREE.Scene();
scene.add(new THREE.HemisphereLight(0xffffff, 0x2b3038, 2.35));
const key = new THREE.DirectionalLight(0xffffff, 1.85); key.position.set(2.4, 3.2, 4.4); scene.add(key);
const rim = new THREE.DirectionalLight(0x9cc7ff, 0.75); rim.position.set(-3, 1.6, -2.4); scene.add(rim);
const camera = new THREE.PerspectiveCamera(28, 1, 0.001, 200);
let current = null;
const loader = new GLTFLoader();

function resize() {
  const r = canvas.parentElement.getBoundingClientRect();
  const w = Math.max(1, Math.round(r.width)), h = Math.max(1, Math.round(r.height));
  renderer.setSize(w, h, false);
  camera.aspect = w / h; camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(canvas.parentElement);

function frameCharacter(root) {
  const box = new THREE.Box3();
  let found = 0;
  root.traverse(o => {
    if (o.isMesh && /head|face/i.test(o.name) && o.geometry.attributes.position.count > 500) {
      box.expandByObject(o); found++;
    }
  });
  if (!found) box.setFromObject(root);
  const c = box.getCenter(new THREE.Vector3()), s = box.getSize(new THREE.Vector3());
  const r = Math.max(s.x, s.y, s.z);
  // fit the head to BOTH axes - a fixed multiple clips the face when the viewport
  // is taller than it is wide (the N-panel takes a third of the width)
  const vFov = camera.fov * Math.PI / 180;
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * (camera.aspect || 1.6));
  const dist = Math.max(r / (2 * Math.tan(vFov / 2)), r / (2 * Math.tan(hFov / 2))) * 1.25;
  camera.position.set(c.x, c.y + r * 0.02, c.z + dist);
  camera.lookAt(c.x, c.y, c.z);
}

async function loadCharacter(id) {
  $('blLoading').hidden = false;
  $('blLoading').querySelector('span').textContent = 'Loading ' + id + '…';
  const [gltf, pack] = await Promise.all([
    new Promise((res, rej) => loader.load('data/ship_' + id + '.glb', res, undefined, rej)),
    loadMorphs('data/morphs_' + id + '.bin'),
  ]);
  const report = bindMorphs(gltf.scene, THREE, pack);
  if (current) { scene.remove(current); disposeTree(current); }
  current = gltf.scene;
  current.userData.morphReport = report;
  current.userData.keys = pack.names;
  scene.add(current);
  frameCharacter(current);
  buildShapeKeys(pack.names);
  $('blObjName').textContent = CHARACTERS.find(c => c.id === id).label;
  $('blTuningChar').textContent = CHARACTERS.find(c => c.id === id).label;
  $('blLoading').hidden = true;
  applyCurves();
}

function disposeTree(root) {
  root.traverse(o => {
    if (o.isMesh) {
      o.geometry.dispose();
      (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => m && m.dispose());
    }
  });
}

/* ---------------------------------------------------------------- playback */
const clockVid = document.createElement('video');
clockVid.muted = true; clockVid.playsInline = true; clockVid.loop = true; clockVid.preload = 'auto';
const sideVid = document.createElement('video');
sideVid.muted = true; sideVid.playsInline = true; sideVid.loop = true; sideVid.preload = 'auto';
sideVid.className = 'bl-sidevid';
sideVid.style.cssText = 'position:absolute;left:8px;top:34px;width:300px;border-radius:4px;z-index:3;box-shadow:0 6px 18px rgba(0,0,0,.5)';
sideVid.hidden = true;
canvas.parentElement.appendChild(sideVid);

function loadClip(c) {
  for (const v of [clockVid, sideVid]) {
    if (v.getAttribute('src') === c.file) continue;
    v.setAttribute('src', c.file); v.load();
  }
}
const frameIndex = () => {
  const n = state.nFrames || 0;
  if (!n) return 0;
  return Math.min(n - 1, Math.max(0, Math.floor((clockVid.currentTime || 0) * state.fps)));
};

function applyCurves() { applyCurvesAt(frameIndex()); }
function applyCurvesAt(f) {
  if (!current || !state.curves) return;
  const curves = state.curves;
  current.traverse(o => {
    if (!o.isMesh || !o.userData.morphIndex) return;
    const idx = o.userData.morphIndex;
    for (const nm in idx) {
      const arr = curves[nm];
      if (arr) o.morphTargetInfluences[idx[nm]] = arr[Math.min(f, arr.length - 1)];
    }
  });
  paintShapeKeys(f);
  const pct = state.nFrames > 1 ? (f / (state.nFrames - 1)) * 100 : 0;
  $('blPlayhead').style.left = pct.toFixed(2) + '%';
  $('blFrameNo').textContent = String(f);
}

function tick() {
  if (state.playing && !clockVid.paused) {
    applyCurves();
    const d = clockVid.duration || 0;
    $('clTime').textContent = (clockVid.currentTime || 0).toFixed(1) + 's / ' + (d ? d.toFixed(1) : '0.0') + 's';
    if (state.sideBySide && sideVid.paused) sideVid.play().catch(() => {});
  }
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}

/* ------------------------------------------------------- shape keys panel */
let skRows = [];
const DISPLAY_KEYS = ['jawOpen','mouthSmileLeft','mouthSmileRight','eyeBlinkLeft','eyeBlinkRight',
                      'browInnerUp','browDownLeft','browDownRight','mouthPucker','cheekPuff',
                      'eyeSquintLeft','mouthFrownLeft','noseSneerLeft','tongueOut'];
function buildShapeKeys(names) {
  const list = ['Basis', ...names.filter(n => n !== 'Basis')];
  $('blShapeKeys').innerHTML = '<div class="bl-shapekeys-inner">' + list.map((n, i) =>
    '<div class="bl-skrow' + (i === 0 ? ' sel' : '') + '"><span>' + n + '</span>' +
    '<span class="v" data-sk="' + n + '">' + (i === 0 ? '1.000' : '0.000') + '</span></div>').join('') + '</div>';
  $('blShapeKeys').style.overflowY = 'auto';
  skRows = [...$('blShapeKeys').querySelectorAll('[data-sk]')].map(el => [el.dataset.sk, el]);
}
function paintShapeKeys(f) {
  if (!state.curves || !skRows.length) return;
  for (const [nm, el] of skRows) {
    const arr = state.curves[nm];
    el.textContent = arr ? arr[Math.min(f, arr.length - 1)].toFixed(3) : '0.000';
  }
}

/* -------------------------------------------------------------------- ui */
function buildCharacterButtons() {
  $('blChars').innerHTML = CHARACTERS.map(c =>
    '<span class="bl-chip' + (c.id === state.character ? ' on' : '') + '" data-char="' + c.id + '">' + c.label + '</span>').join('');
  $('blChars').querySelectorAll('[data-char]').forEach(b => b.onclick = async () => {
    if (b.dataset.char === state.character) return;
    state.character = b.dataset.char;
    buildCharacterButtons();
    await loadCharacter(state.character);
  });
}

function buildClipButtons() {
  $('blClips').innerHTML = CLIPS.map(c =>
    '<span class="bl-chip' + (c.id === state.clip.id ? ' on' : '') + '" data-clip="' + c.id + '">' + c.label + '</span>').join('');
  $('blClips').querySelectorAll('[data-clip]').forEach(b => b.onclick = () => {
    state.clip = CLIPS.find(c => c.id === b.dataset.clip);
    state.curves = null; state.tray.length = 0; state.playing = false;
    clockVid.pause(); $('clPlay').textContent = 'Play';
    renderTray(); buildClipButtons(); $('blApply').disabled = true;
    loadClip(state.clip); applyCurves();
  });
}

function sliderRow(s) {
  const v = state.sliders[s.key] || 0;
  const pct = ((v + 100) / 200) * 100;
  return '<div class="bl-row" data-slider="' + s.key + '">' +
    '<i class="bl-fill" style="width:' + pct.toFixed(1) + '%"></i>' +
    '<span class="lbl">' + s.label + '</span>' +
    '<span class="val">' + (v / 100).toFixed(2) + '</span>' +
    '<span class="rst" title="Reset">⟲</span></div>';
}
function buildSliders() {
  $('blSliders').innerHTML = SLIDERS.map(sliderRow).join('');
  $('blSliders').querySelectorAll('.bl-row').forEach(row => {
    const key = row.dataset.slider;
    let dragging = false, startX = 0, startV = 0;
    const apply = v => {
      v = Math.max(-100, Math.min(100, Math.round(v)));
      state.sliders[key] = v;
      row.querySelector('.val').textContent = (v / 100).toFixed(2);
      row.querySelector('.bl-fill').style.width = (((v + 100) / 200) * 100).toFixed(1) + '%';
      deriveCurves();
    };
    row.addEventListener('pointerdown', e => {
      if (e.target.classList.contains('rst')) { apply(0); return; }
      dragging = true; startX = e.clientX; startV = state.sliders[key];
      row.setPointerCapture(e.pointerId);
    });
    row.addEventListener('pointermove', e => {
      if (!dragging) return;
      const scale = 1280 / Math.max(1, $('blWrap').clientWidth);
      apply(startV + (e.clientX - startX) * scale * 0.7);
    });
    row.addEventListener('pointerup', () => { dragging = false; });
    row.addEventListener('dblclick', () => apply(0));
  });
}

function renderTray() {
  if (!state.tray.length) {
    $('blTray').innerHTML = '<div class="bl-empty">No mocap applied yet.</div>';
    $('blMocapCount').textContent = '0 applied';
    return;
  }
  $('blTray').innerHTML = state.tray.map((m, i) =>
    '<div class="bl-item' + (i === state.tray.length - 1 ? ' on' : '') + '" data-m="' + i + '">' +
    '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><rect x="1" y="3" width="14" height="10" rx="1"/><path d="M4 3v10M12 3v10" stroke="#4772b3" stroke-width="1"/></svg>' +
    '<span class="nm">' + m.label + '</span><span class="fr">F-0-' + m.frames + '</span><span class="tick">✓</span></div>').join('');
  $('blMocapCount').textContent = state.tray.length + ' applied · 0 deleted';
  $('blTray').querySelectorAll('.bl-item').forEach(el => el.onclick = () => {
    const m = state.tray[+el.dataset.m];
    state.clip = CLIPS.find(c => c.id === m.clip);
    buildClipButtons(); loadClip(state.clip); loadTrace(m.data);
    $('blTray').querySelectorAll('.bl-item').forEach(x => x.classList.remove('on'));
    el.classList.add('on');
  });
}

/* --------------------------------------------------------------- pipeline */
const traceCache = {};
async function loadTrace(url) {
  if (!traceCache[url]) {
    const raw = await (await fetch(url)).json();
    traceCache[url] = { raw, deriver: makeDeriver(raw) };
  }
  const e = traceCache[url];
  state.nFrames = e.raw.tracks.length;
  state.fps = e.raw.fps || 24;
  state.deriver = e.deriver;
  $('blEnd').textContent = String(state.nFrames);
  deriveCurves();
}
function deriveCurves() {
  if (!state.deriver) return;
  state.curves = state.deriver.derive(state.sliders);
  applyCurves();
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
function progress(pct, text) {
  const el = document.getElementById('blProg');
  if (!el) return;
  el.hidden = false;
  el.querySelector('i').style.width = pct + '%';
  el.querySelector('span').textContent = text;
  if (pct >= 100) setTimeout(() => { el.hidden = true; }, 600);
}
async function analyze() {
  setDisabled('blAnalyze', true);
  for (const [p, t] of [[16, 'Decoding video…'], [44, 'Detecting face…'], [76, 'Tracking 52 blendshapes…'], [100, 'Analysis ready']]) {
    progress(p, t); await sleep(240);
  }
  await loadTrace(state.clip.data);
  setDisabled('blApply', false);
  setDisabled('blAnalyze', false);
}
/* Resolve elements at call time and tolerate a miss: a null here used to abort the
   whole analysis with an opaque "Cannot set properties of null". */
function setDisabled(id, v) { const el = document.getElementById(id); if (el) el.disabled = v; }
async function applyMocap() {
  if (!state.deriver) return;
  const m = { clip: state.clip.id, label: state.clip.label, frames: state.nFrames, data: state.clip.data };
  if (!state.tray.some(x => x.clip === m.clip)) state.tray.push(m);
  renderTray();
  await play(true);
}
async function play(on) {
  state.playing = on;
  $('clPlay').textContent = on ? 'Pause' : 'Play';
  if (on) {
    try { await clockVid.play(); } catch (e) { /* autoplay policy */ }
    $('blFollow').classList.add('on');
    if (state.sideBySide) sideVid.play().catch(() => {});
  } else { clockVid.pause(); sideVid.pause(); }
}

/* ------------------------------------------------------------------- start */
function wire() {
  $('blAnalyze').onclick = analyze;
  $('blApply').onclick = applyMocap;
  $('blDefaults').onclick = () => { state.sliders = defaultSliders(); buildSliders(); deriveCurves(); };
  $('clPlay').onclick = () => play(!state.playing);
  $('blSideBySide').onclick = () => toggleSide();
  $('clSide').onclick = () => toggleSide();
  $('blFollow').onclick = () => {
    state.follow = !state.follow;
    $('blFollow').classList.toggle('on', state.follow);
    $('blFollow').querySelector('.lbl').textContent = (state.follow ? '▶' : '▷') + ' Follow Playhead';
  };
  const fold = (open) => {
    state.tuningOpen = open;
    $('blFoldTuning').hidden = !open;
    $('blCaretTuning').textContent = open ? '▼' : '▶';
  };
  // the Video Sources block folds from its own header, exactly like the add-on's dropdown
  const vidFold = open => {
    $('blVidBody').hidden = !open;
    $('blVidDrop').querySelector('.tw').textContent = open ? '▾' : '▸';
  };
  $('blVidDrop').onclick = () => vidFold($('blVidBody').hidden);
  vidFold(true);
  // 3. FACIAL TUNING opens collapsed, the way a fresh Blender panel would sit - it keeps
  // 4. ANIMATION (and Apply Mocap) on screen without scrolling
  fold(false);
  // these mirror the add-on's own buttons; in the demo they acknowledge a click
  ['blRegister', 'blStartFrame', 'blConnect', 'blLive', 'blImportVid'].forEach(id => {
    const el = $(id);
    if (el) el.onclick = () => { el.style.filter = 'brightness(1.3)'; setTimeout(() => { el.style.filter = ''; }, 220); };
  });
  document.querySelector('.bl-sect[data-fold="tuning"]').onclick = () => fold($('blFoldTuning').hidden);
  $('blAdjustExp').onclick = () => {
    const open = $('blAdjustExp').dataset.open === '1';
    $('blAdjustExp').dataset.open = open ? '0' : '1';
    $('blAdjustExp').textContent = (open ? '▶' : '▼') + ' Adjust Expressions (Experimental)';
    $('blSliders').style.display = open ? '' : 'none';
  };
}
function toggleSide() {
  state.sideBySide = !state.sideBySide;
  sideVid.hidden = !state.sideBySide;
  $('clSide').classList.toggle('on', state.sideBySide);
  $('blSideBySide').classList.toggle('on', state.sideBySide);
  if (state.sideBySide) {
    sideVid.currentTime = clockVid.currentTime;
    if (state.playing) sideVid.play().catch(() => {});
  } else sideVid.pause();
}

window.__afmpBooted = true;
(async function main() {
  wire(); fit(); resize();
  buildCharacterButtons(); buildClipButtons(); buildSliders(); renderTray();
  $('blFollow').classList.add('on');
  loadClip(state.clip);
  await loadCharacter(state.character);
  tick();
})();

/* exposed for the render gates and for embedding the demo from the page */
window.__afmpDemo = {
  state, THREE, analyze, applyMocap, play,
  sceneRoot: () => current,
  seek(f) {
    state.playing = false; clockVid.pause();
    try { clockVid.currentTime = f / (state.fps || 24); } catch (e) { /* not seekable yet */ }
    applyCurvesAt(f);
  },
  setClip(id) {
    state.clip = CLIPS.find(c => c.id === id) || state.clip;
    state.curves = null; state.tray.length = 0; state.playing = false;
    clockVid.pause(); buildClipButtons(); renderTray(); $('blApply').disabled = true;
    loadClip(state.clip); applyCurves();
  },
  setSlider(k, v) { state.sliders[k] = v; buildSliders(); deriveCurves(); },
  setCharacter: async id => { state.character = id; buildCharacterButtons(); await loadCharacter(id); },
  toggleSide,
  report() {
    const meshes = [];
    if (current) current.traverse(o => {
      if (o.isMesh) meshes.push({ name: o.name, verts: o.geometry.attributes.position.count,
        targets: (o.geometry.morphAttributes.position || []).length,
        keys: Object.keys(o.userData.morphIndex || {}).length });
    });
    return { character: state.character, clip: state.clip.id, frames: state.nFrames, fps: state.fps,
             tray: state.tray.length, playing: state.playing, meshes };
  },
};
