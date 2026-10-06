/* Decoder for the AFMPM1 side-car morph format (see _tools/morph_pack.py).
   One entry per glTF primitive, in the same order the loader hands them back. */
const TD = new TextDecoder();

export async function loadMorphs(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('morph file ' + res.status + ': ' + url);
  const buf = await res.arrayBuffer();
  const dv = new DataView(buf);
  const magic = TD.decode(new Uint8Array(buf, 0, 6));
  if (magic !== 'AFMPM1') throw new Error('not an AFMPM1 morph file: ' + magic);
  let o = 8;

  const nNames = dv.getUint16(o, true); o += 2;
  const names = [];
  for (let i = 0; i < nNames; i++) {
    const l = dv.getUint8(o); o += 1;
    names.push(TD.decode(new Uint8Array(buf, o, l))); o += l;
  }

  const nPrims = dv.getUint16(o, true); o += 2;
  const prims = [];
  for (let p = 0; p < nPrims; p++) {
    const ml = dv.getUint8(o); o += 1;
    const mesh = TD.decode(new Uint8Array(buf, o, ml)); o += ml;
    const pl = dv.getUint8(o); o += 1;
    const prim = TD.decode(new Uint8Array(buf, o, pl)); o += pl;
    const nVerts = dv.getUint32(o, true); o += 4;
    const nTargets = dv.getUint16(o, true); o += 2;
    const wide = nVerts >= 65536;
    const targets = [];
    for (let t = 0; t < nTargets; t++) {
      const nameIdx = dv.getUint8(o); o += 1;
      const scale = dv.getFloat32(o, true); o += 4;
      const nSparse = dv.getUint32(o, true); o += 4;
      const idx = new Uint32Array(nSparse);
      for (let k = 0; k < nSparse; k++) {
        idx[k] = wide ? dv.getUint32(o, true) : dv.getUint16(o, true);
        o += wide ? 4 : 2;
      }
      const q = new Int8Array(buf.slice(o, o + nSparse * 3)); o += nSparse * 3;
      targets.push({ name: names[nameIdx], scale, idx, q });
    }
    prims.push({ mesh, prim, nVerts, targets });
  }
  return { names, prims };
}

/* Attach the decoded deltas to a loaded three.js scene. Meshes are matched in
   traversal order, which is the order the glTF lists its primitives - and the
   vertex count is asserted, so a mismatch fails loudly instead of animating the
   wrong parts of the face. */
export function bindMorphs(root, three, pack) {
  const meshes = [];
  root.traverse(o => { if (o.isMesh) meshes.push(o); });
  if (meshes.length !== pack.prims.length) {
    throw new Error('morph file has ' + pack.prims.length + ' primitives, scene has ' + meshes.length);
  }
  let bound = 0, sparseTotal = 0;
  meshes.forEach((mesh, i) => {
    const p = pack.prims[i];
    const count = mesh.geometry.attributes.position.count;
    if (count !== p.nVerts) {
      throw new Error('primitive ' + i + ' (' + p.prim + '): scene has ' + count + ' verts, morph file has ' + p.nVerts);
    }
    const arrs = [];
    const dict = {};
    p.targets.forEach((t, ti) => {
      const a = new Float32Array(count * 3);
      for (let k = 0; k < t.idx.length; k++) {
        const v = t.idx[k] * 3;
        a[v] = t.q[k * 3] * t.scale;
        a[v + 1] = t.q[k * 3 + 1] * t.scale;
        a[v + 2] = t.q[k * 3 + 2] * t.scale;
      }
      arrs.push(new three.BufferAttribute(a, 3));
      sparseTotal += t.idx.length;
      if (t.name) dict[t.name] = ti;
    });
    mesh.geometry.morphAttributes.position = arrs;
    mesh.geometry.morphTargetsRelative = true;
    mesh.morphTargetDictionary = dict;
    mesh.morphTargetInfluences = new Array(p.targets.length).fill(0);
    // which local influence drives each canonical ARKit key
    mesh.userData.morphIndex = {};
    for (const nm of Object.keys(dict)) mesh.userData.morphIndex[nm] = dict[nm];
    bound++;
    mesh.frustumCulled = false;
  });
  return { bound, sparseTotal };
}
