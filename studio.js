/* A studio environment, built the way Blender's preview lighting works: a room of
   emissive panels - a broad ceiling softbox, a warm key, a cool fill and a dim floor
   bounce - rendered ONCE through PMREMGenerator into a cubemap.

   Why this and not more lights: a HemisphereLight gives every surface the same flat
   ambient, so a face reads as a cut-out. Blender's Material/Rendered preview lights
   from a studio HDRI, where the ambient arrives from different directions and every
   material also picks up a soft specular sheen from it. That difference - directional
   ambient plus environment specular - is most of what "looks rendered" means.

   Returns a THREE.Scene ready for `PMREMGenerator.fromScene()`. */

export function studioScene(THREE) {
  const scene = new THREE.Scene();

  // the room itself: a big inverted box. Its colour is what the "world" contributes.
  const room = new THREE.Mesh(
    new THREE.BoxGeometry(20, 12, 20),
    new THREE.MeshBasicMaterial({ color: 0x2e2e33, side: THREE.BackSide }));
  room.position.y = 2;
  scene.add(room);

  // an emissive panel; `intensity` is folded into the colour so the PMREM sees it
  const panel = (w, h, hex, intensity, x, y, z, rx, ry) => {
    const c = new THREE.Color(hex).multiplyScalar(intensity);
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h),
      new THREE.MeshBasicMaterial({ color: c, side: THREE.DoubleSide }));
    m.position.set(x, y, z);
    m.rotation.set(rx || 0, ry || 0, 0);
    scene.add(m);
    return m;
  };

  const D = Math.PI / 180;
  panel(14, 12, 0xffffff, 2.6,  0, 5.9,  0,  90 * D, 0);      // ceiling softbox
  panel( 7,  7, 0xfff2e0, 3.2, -4, 3.4,  4.4,  60 * D, -42 * D); // warm key, upper left
  panel( 6,  6, 0xdce8ff, 1.7,  4.6, 2.6,  2.4,  75 * D,  48 * D); // cool fill, right
  panel( 6,  6, 0xbfd4ff, 1.2,  1.5, 3.0, -5.4,  78 * D, 172 * D); // rim from behind
  panel(16, 16, 0x3a3a40, 1.0,  0, -5.8, 0, -90 * D, 0);       // floor bounce
  return scene;
}
