/* Verification gate for the demo. Loaded only when the page is opened with ?gate=1,
   so the shipped page never carries it.
   Every check asserts something that CAN fail: the counts are read back off the live
   scene, and "the morphs move the face" is measured as a change in the head mesh's
   world-space bounding box, not by trusting the influence array. */
(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const byId = id => document.getElementById(id);
  const click = id => { const el = byId(id); if (el) el.click(); return !!el; };
  for (let i = 0; i < 200 && !window.__afmpDemo; i++) await wait(50);
  // wait for a document that stays put - a navigation mid-run tears the tree down
  // and every getElementById starts returning null for no visible reason
  for (let i = 0; i < 40; i++) {
    const mark = (window.__gateMark = Math.random());
    await wait(250);
    if (window.__gateMark === mark && byId('blPanel')) break;
  }
  const api = window.__afmpDemo;
  if (!api) { window.__gate = { running: false, pass: false, failed: 1, results: [{ name: 'demo api', pass: false, detail: 'window.__afmpDemo never appeared' }] }; return; }
  const results = [];
  const check = (name, pass, detail) => results.push({ name, pass: !!pass, detail: String(detail === undefined ? '' : detail) });
  window.__gateDoc = document;
  window.__gate = { running: true, results };

  /* ⛔ Box3.setFromObject reads geometry.attributes.position and IGNORES morph
     deltas, so it reports "no change" for a face that is moving. Deform the sample
     vertices by hand instead: p + sum(influence_i * delta_i). */
  const headMeshes = () => {
    const out = [];
    const root = window.__afmpDemo.sceneRoot();
    if (root) root.traverse(o => {
      if (o.isMesh && /head|face/i.test(o.name) && o.geometry.attributes.position.count > 500) out.push(o);
    });
    return out;
  };
  const deformed = () => {
    const ms = headMeshes();
    if (!ms.length) return null;
    const m = ms[0];
    const pos = m.geometry.attributes.position.array;
    const infl = m.morphTargetInfluences || [];
    const attrs = m.geometry.morphAttributes.position || [];
    const n = Math.min(160, m.geometry.attributes.position.count);
    const out = new Array(n * 3).fill(0);
    for (let v = 0; v < n; v++) {
      const i3 = v * 3;
      out[i3] = pos[i3]; out[i3 + 1] = pos[i3 + 1]; out[i3 + 2] = pos[i3 + 2];
      for (let t = 0; t < attrs.length; t++) {
        const w = infl[t] || 0;
        if (!w) continue;
        const a = attrs[t].array;
        out[i3] += w * a[i3]; out[i3 + 1] += w * a[i3 + 1]; out[i3 + 2] += w * a[i3 + 2];
      }
    }
    return out;
  };

  try {
    // ---- 1. every character loads and binds all 52 keys -------------------
    for (const c of ['snow', 'rain', 'jay', 'kun', 'chan']) {
      try {
        await api.setCharacter(c);
        await wait(150);
        const rep = api.report();
        // a character may ship in two pieces: the face carries the 52 morph targets and
        // the body/hair is static, so require the FACE to be complete, not every prim
        const face = rep.meshes.filter(m => m.targets >= 50);
        const maxT = Math.max(...rep.meshes.map(m => m.targets));
        check('character:' + c,
              rep.meshes.length > 0 && face.length > 0 && maxT === 52 &&
              face.every(m => m.keys === m.targets),
              rep.meshes.length + ' prims, ' + face.length + ' with morphs (max ' + maxT + ' keys)');
      } catch (e) { check('character:' + c, false, e.message || e); }
    }

    // ---- 2. the trace loads and has frames, through the REAL buttons --------
    // (CLAUDE.md: test through the real entry point - a direct API call would not
    //  catch a button that is wired to nothing.)
    await api.setCharacter('snow');
    click('blAnalyze');
    for (let i = 0; i < 60 && !api.state.nFrames; i++) await wait(200);
    check('trace frames', api.state.nFrames > 50,
          api.state.nFrames + ' frames @ ' + api.state.fps + 'fps (via the Analyze Video button)');

    // ---- 3. the curves actually move the face ------------------------------
    click('blApply');
    await wait(300);
    const findFrame = key => {
      let bi = 0, bv = -1;
      const arr = api.state.curves[key];
      for (let i = 0; i < arr.length; i++) if (arr[i] > bv) { bv = arr[i]; bi = i; }
      return { i: bi, v: bv };
    };
    const open = findFrame('jawOpen');
    api.seek(0); await wait(80);
    const d0 = deformed();
    api.seek(open.i); await wait(80);
    const d1 = deformed();
    const maxDelta = (d0 && d1) ? Math.max(...d0.map((v, i) => Math.abs(v - d1[i]))) : 0;
    check('morphs move the head', maxDelta > 1e-4,
          'frame0 vs jawOpen=' + open.v.toFixed(2) + ' @' + open.i + ' -> max vertex move ' +
          (maxDelta * 1000).toFixed(3) + ' mm');

    // ---- 4. sliders re-derive the curves -----------------------------------
    const before = Array.from(api.state.curves.jawOpen.slice(0, 40));
    api.setSlider('strength', 100);
    const after = Array.from(api.state.curves.jawOpen.slice(0, 40));
    const strengthChanged = after.some((v, i) => Math.abs(v - before[i]) > 1e-6);
    check('strength slider re-derives', strengthChanged, 'max delta ' + Math.max(...after.map((v, i) => Math.abs(v - before[i]))).toFixed(4));

    const smoothBefore = Array.from(api.state.curves.mouthSmileLeft.slice(0, 60));
    api.setSlider('smoothExpr', 100);
    const smoothAfter = Array.from(api.state.curves.mouthSmileLeft.slice(0, 60));
    const smoothed = smoothAfter.some((v, i) => Math.abs(v - smoothBefore[i]) > 1e-6);
    check('smoothing slider re-derives', smoothed, 'changed=' + smoothed);

    api.setSlider('strength', 0);
    api.setSlider('smoothExpr', -60);

    // ---- 5. side by side ----------------------------------------------------
    const sideBtn = byId('blSideBySide');
    const wasSide = api.state.sideBySide;
    if (sideBtn) sideBtn.click();
    const turnedOn = api.state.sideBySide !== wasSide;
    if (sideBtn) sideBtn.click();
    const turnedBack = api.state.sideBySide === wasSide;
    check('side by side toggles', turnedOn && turnedBack && !!sideBtn,
          'panel button flips it on and back (button present: ' + !!sideBtn + ')');

    // ---- 6. the mocap tray --------------------------------------------------
    check('mocap tray', api.state.tray.length >= 1, api.state.tray.length + ' take(s): ' +
          api.state.tray.map(t => t.label + ' ' + t.frames + 'f').join(', '));

    // ---- 7. every clip traces -------------------------------------------------
    for (const c of ['clip1', 'clip2', 'clip3']) {
      try {
        api.setClip(c);
        click('blAnalyze');
        api.state.nFrames = 0;
        for (let i = 0; i < 60 && !api.state.nFrames; i++) await wait(200);
        check('clip:' + c, api.state.nFrames > 50, api.state.nFrames + ' frames');
      } catch (e) { check('clip:' + c, false, e.message || e); }
    }
  } catch (e) {
    const diag = 'doc=' + document.readyState + ' chars=' + document.body.children.length +
      ' panel=' + !!byId('blPanel') + ' playhead=' + !!byId('blPlayhead') +
      ' t0=' + performance.timeOrigin + ' same=' + (window.__gateDoc === document);
    check('gate crashed', false, ((e && e.message) || String(e)) + ' [' + diag + ']');
  }
  window.__gate.running = false;
  window.__gate.pass = results.every(r => r.pass);
  window.__gate.failed = results.filter(r => !r.pass).length;
})();
