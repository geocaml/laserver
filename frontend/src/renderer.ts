import * as THREE from 'three';
import {Tile} from './types.ts'

// --- Scene state ------------------------------------------------------------

const scene = new THREE.Scene();
const camera   = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 100000);
camera.up.set(0, 0, 1);
export const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(devicePixelRatio);
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);

// --- Camera control state ---------------------------------------------------

let defaults = {
    sph: { theta: 0.4, phi: 0.5, r: 1000 },
    target: new THREE.Vector3(),
};
export let sph    = { theta: 0.4, phi: 0.5, r: 1000 };
export let target = new THREE.Vector3();

// Called when the user clicks on home
export function cameraReset() {
    sph    = { ...defaults.sph };
    target = new THREE.Vector3(defaults.target.x, defaults.target.y, defaults.target.z);
    history.replaceState(null, '', window.location.pathname);
}

export function resizeEvent(tileStates: Tile[]) {
    camera.aspect = globalThis.innerWidth / globalThis.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(globalThis.innerWidth, globalThis.innerHeight);
    render(tileStates);
}

// --- Code -------------------------------------------------------------------

export function addGroup(grp: THREE.Group) {
    scene.add(grp);
}

export function cameraSet(
    gMinX: number,
    gMinY: number,
    gMinZ: number,
    gMaxX: number,
    gMaxY: number,
    gMaxZ: number,
){
    target.set(0, 0, (gMaxZ - gMinZ) * 0.35);
    defaults.target.set(0, 0, (gMaxZ - gMinZ) * 0.35);
    sph.r = Math.max(gMaxX - gMinX, gMaxY - gMinY) * 0.9;
    defaults.sph.r = sph.r;

    camera.position.set(
      target.x + sph.r * Math.sin(sph.phi) * Math.sin(sph.theta),
      target.y + sph.r * Math.sin(sph.phi) * Math.cos(sph.theta) * -1.0,
      target.z + sph.r * Math.cos(sph.phi)
    );
    camera.lookAt(target);
    camera.updateMatrixWorld();
}


export function getFrustum() {
    camera.updateMatrixWorld();
    updateGroundFocus();
    return new THREE.Frustum().setFromProjectionMatrix(
        new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
    );
}

// ── Display LOD ───────────────────────────────────────────────────────────────
//
// The COPC octree gives each node a precise 3D bounding box.  We exploit this
// to give sub-tile spatial resolution: a node near the camera target is shown
// at full depth while a node at the far corner of the same tile is shown at
// depth 0–1.  No reloading is needed — applyDisplayLOD() runs every frame and
// simply shows/hides individual node meshes.

const _lodFrustum = new THREE.Frustum();
const _lodMatrix  = new THREE.Matrix4();

// The point where the camera's look ray intersects the ground plane (Z=0).
// This is what the user perceives as the screen centre — it differs from
// `target` whenever the camera is tilted.  Recomputed once per render.
const _groundFocus = new THREE.Vector2();
function updateGroundFocus() {
    // Look direction from camera toward target
    const dx = target.x - camera.position.x;
    const dy = target.y - camera.position.y;
    const dz = target.z - camera.position.z;
    // Intersect ray with Z=0: camera.z + t*dz = 0 → t = -camera.z / dz
    if (dz < -1e-6) {  // looking downward — valid intersection
        const t = -camera.position.z / dz;
        _groundFocus.set(camera.position.x + t * dx, camera.position.y + t * dy);
    } else {
        // Camera looking up or horizontal — fall back to target XY
        _groundFocus.set(target.x, target.y);
    }
}

// Returns the maximum octree depth we want to *display* for this node's spatial
// region, given the current camera state.  A node is visible iff its depth
// is ≤ the returned value.
export function computeNodeTargetDepth(node) {
    const tileSize = node.tile.box.max.x - node.tile.box.min.x;
    const cx = (node.box.min.x + node.box.max.x) / 2;
    const cy = (node.box.min.y + node.box.max.y) / 2;
    // const dist2d = Math.hypot(_groundFocus.x - cx, _groundFocus.y - cy);
    const dist2d = Math.hypot(target.x - cx, target.y - cy);

    // Overall zoom depth: how much global detail do we want?
    const zoomRatio = tileSize / sph.r;
    const zoomDepth = zoomRatio < 0.25 ? 0
                : zoomRatio < 0.6  ? 1
                : zoomRatio < 1.2  ? 2
                : zoomRatio < 2.5  ? 3
                : Math.min(node.tile.maxAvailDepth, 5);

    // Spatial falloff: normalised by orbit radius so the high-detail zone
    // shrinks as you zoom in, giving finer spatial precision up close.
    const distScale = 800; //Math.max(sph.r, tileSize * 0.2);  // floor at 20% of tile width
    const distNorm  = dist2d / distScale;
    const distDepth = distNorm < 1.0 ? zoomDepth
                : distNorm < 2.0 ? Math.min(zoomDepth, 2)
                : distNorm < 4.0 ? Math.min(zoomDepth, 1)
                : 0;

    return distDepth;
}

function applyDisplayLOD(tileStates) {
    updateGroundFocus();
    _lodMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    _lodFrustum.setFromProjectionMatrix(_lodMatrix);
    for (const tile of tileStates) {
        if (tile.failed || !tile.box) continue;
        const tileVis = _lodFrustum.intersectsBox(tile.box);
        tile.group.visible = tileVis;
        if (!tileVis) continue;
        for (const node of tile.allNodes) {
            if (!node.mesh) continue;
            node.mesh.visible = node.depth <= computeNodeTargetDepth(node);
        }
    }
}

export function render(tileStates) {
    camera.position.set(
        target.x + sph.r * Math.sin(sph.phi) * Math.sin(sph.theta),
        target.y + sph.r * Math.sin(sph.phi) * Math.cos(sph.theta) * -1.0,
        target.z + sph.r * Math.cos(sph.phi)
    );
    camera.lookAt(target);
    camera.updateMatrixWorld();
    applyDisplayLOD(tileStates);
    renderer.render(scene, camera);
}
