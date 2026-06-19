import * as THREE from "three";
import { Copc, View, Hierarchy } from "copc";
import { createLazPerf, LazPerf } from "las";
import {
    addLayer,
    computeNodeTargetDepth,
    getFrustum,
    render,
    target,
} from "./renderer.ts";
import { applyNodeColors, maybeUpdateClsLegend } from "./colours.ts";
import {Tile, Node, APITileInfo, Offset} from "./types.ts";
import { debugMode } from "./state.ts";

let lazPerf: LazPerf | null = null;

const pointMaterial = new THREE.PointsMaterial({
    vertexColors: true,
    size: 0.5,
    sizeAttenuation: true,
});

// --- Tile / Node state ------------------------------------------------------

export let tileState: Tile[] = [];
const coordOffset: Offset = { x: 0, y: 0, z: 0 };
const tilesGroup = new THREE.Group();
const fetchCentre = {x: Infinity, y: Infinity};
const loadedTileNames = new Set();

const FETCH_RADIUS = 5000; // m — radius passed to /api/find (covers 5×5 tile grid)
const REFETCH_THRESHOLD = 1200; // m — re-query when target drifts this far from last fetch
const EVICT_DISTANCE = 7500; // m — drop tiles whose centre exceeds this

function makeTile(tileinfo: APITileInfo): Tile {
    return {
        name: tileinfo.name,
        url: new URL(tileinfo.path, location.href).href,
        copc: null,
        maxAvailDepth: 0,
        hasRGB: false,
        box: null, // THREE.Box3 in world-space coords
        debugFrame: null,
        nodeMap: {}, // keyStr → nodeState
        allNodes: [], // flat array for fast iteration
        group: new THREE.Group(),
        failed: false,
        outOfViewSince: null,
        seenClasses: new Set(),
        evicted: false,
    };
}

export async function lasinit() {
    lazPerf = await createLazPerf({ locateFile: (f: string) => "/" + f });

    addLayer("pointCloud", tilesGroup);
}

export function setOffset(center_x: number, center_y: number, min_z: number) {
    coordOffset.x = center_x;
    coordOffset.y = center_y;
    coordOffset.z = min_z;

    debugMode.subscribe(debug => {
       for (const tile of tileState) {
           tile.debugFrame.visible = debug;
           for (const node of tile.allNodes) {
               if (node.debugFrame) {
                   node.debugFrame.visible = debug;
               }
           }
       }
       render(tileState);
    });
}

// ── Status bar ────────────────────────────────────────────────────────────────

function updateStatusBar(tileState: Tile[]) {
    let totalPts = 0, loadingCount = 0;
    for (const tile of tileState) {
        for (const node of tile.allNodes) {
            if (node.loaded) totalPts += node.pointCount;
            if (node.loading) loadingCount++;
        }
    }
    const el = document.getElementById("pt-count")!;
    el.textContent = (totalPts / 1e6).toFixed(2) + "M" +
        (loadingCount ? " ↓" : "");
    maybeUpdateClsLegend(tileState);
}

// Compute a THREE.Box3 (world-space) for an octree node.
// The COPC octree subdivides each axis by 2 at every depth level.
function computeNodeBox(tile: Tile, depth: number, nx: number, ny: number, nz: number) {
    if (tile.copc === null) return;
    const { min, max } = tile.copc.header;
    const cells = 1 << depth; // 2^depth
    const sx = (max[0] - min[0]) / cells;
    const sy = (max[1] - min[1]) / cells;
    const sz = (max[2] - min[2]) / cells;
    return new THREE.Box3(
        new THREE.Vector3(
            min[0] + nx * sx - coordOffset.x,
            min[1] + ny * sy - coordOffset.y,
            min[2] + nz * sz - coordOffset.z,
        ),
        new THREE.Vector3(
            min[0] + (nx + 1) * sx - coordOffset.x,
            min[1] + (ny + 1) * sy - coordOffset.y,
            min[2] + (nz + 1) * sz - coordOffset.z,
        ),
    );
}

// --- Load queue (max 4 concurrent) ------------------------------------------

type Task = {
  priority: number;
  fn: () => Promise<void>;
};

const loadQ: {
    tasks: Task[];
    active: number;
    max: number;
    add(priority: number, fn: () => Promise<void>): void;
    _pump(): void;
} = {
    tasks: [],
    active: 0,
    max: 4,
    add(priority: number, fn: () => Promise<void>) {
        this.tasks.push({ priority, fn });
        this.tasks.sort((a, b) => b.priority - a.priority);
        this._pump();
    },
    _pump() {
        while (this.active < this.max && this.tasks.length > 0) {
            const { fn } = this.tasks.shift()!;
            this.active++;
            fn().finally(() => {
                this.active--;
                this._pump();
            });
        }
    },
};

function makeNodeState(tile: Tile, keyStr: string, entry: Hierarchy.Node): Node {
    const [d, nx, ny, nz] = keyStr.split("-").map(Number);
    const box = computeNodeBox(tile, d, nx, ny, nz);
    const debugFrame = new THREE.Box3Helper(box, 0x00FF00);
    debugFrame.visible = debugMode.get();
    return {
        tile,
        keyStr,
        depth: d,
        nx,
        ny,
        nz,
        entry,
        box,
        debugFrame,
        loaded: false,
        loading: false,
        failed: false,
        queued: false,
        posArr: null,
        clsArr: null,
        rgbArr: null,
        colArr: null,
        pointCount: 0,
        geo: null,
        mesh: null,
    };
}

export async function loadHeader(tile: Tile) {
    try {
        tile.copc = await Copc.create(tile.url);
        tile.hasRGB = [2, 3, 7, 8].includes(tile.copc.header.pointDataRecordFormat);
    } catch (err) {
        console.error("Header failed:", tile.url, err);
        tile.failed = true;
    }
}

export async function loadHierarchy(tile: Tile) {
    if (tile.failed) return;
    if (tile.copc === null) return;
    try {
        const all: Hierarchy.Node.Map = {};
        async function loadPage(info: Hierarchy.Page) {
            const { nodes, pages } = await Copc.loadHierarchyPage(tile.url, info);
            Object.assign(all, nodes);
            for (const sub of Object.values(pages ?? {})) { if (sub) await loadPage(sub)};
        }
        await loadPage(tile.copc.info.rootHierarchyPage);

        let maxD = 0;
        for (const [keyStr, entry] of Object.entries(all)) {
            if (!entry) continue;
            if (!(entry.pointCount)) continue;
            if (entry.pointCount === 0xFFFFFFFF) continue;  // untwine sentinel

            const d = parseInt(keyStr.split("-")[0]);
            maxD = Math.max(maxD, d);
            const node = makeNodeState(tile, keyStr, entry);
            tile.nodeMap[keyStr] = node;
            tile.allNodes.push(node);
        }
        tile.maxAvailDepth = maxD;
    } catch (err) {
        console.error("Hierarchy failed:", tile.url, err);
        tile.failed = true;
    }
}

function fillNodeBuffer(node: Node, view: View) {
    const n = view.pointCount;
    const tile = node.tile;

    node.posArr = new Float32Array(n * 3);
    node.clsArr = new Uint8Array(n);
    node.colArr = new Float32Array(n * 3);
    if (tile.hasRGB) node.rgbArr = new Uint8Array(n * 3);

    const getX = view.getter("X");
    const getY = view.getter("Y");
    const getZ = view.getter("Z");
    const getCls = view.getter("Classification");
    const getR = tile.hasRGB ? view.getter("Red") : undefined;
    const getG = tile.hasRGB ? view.getter("Green") : undefined;
    const getB = tile.hasRGB ? view.getter("Blue") : undefined;

    for (let j = 0; j < n; j++) {
        const j3 = j * 3;
        node.posArr[j3] = getX(j) - coordOffset.x;
        node.posArr[j3 + 1] = getY(j) - coordOffset.y;
        node.posArr[j3 + 2] = getZ(j) - coordOffset.z;
        const cls = getCls(j);
        node.clsArr[j] = cls;
        tile.seenClasses.add(cls);
        if (tile.hasRGB && (node.rgbArr !== null)) {
            node.rgbArr[j3] = getR!(j) >> 8;
            node.rgbArr[j3 + 1] = getG!(j) >> 8;
            node.rgbArr[j3 + 2] = getB!(j) >> 8;
        }
    }

    node.pointCount = n;
    applyNodeColors(node, 0, n);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(node.posArr, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(node.colArr, 3));

    // Explicit bounding geometry lets Three.js frustum-cull individual nodes.
    geo.boundingBox = node.box.clone();
    geo.boundingSphere = new THREE.Sphere();
    node.box.getBoundingSphere(geo.boundingSphere);

    const mesh = new THREE.Points(geo, pointMaterial);
    mesh.frustumCulled = true;

    node.geo = geo;
    node.mesh = mesh;
    node.loaded = true;
    tile.group.add(node.debugFrame);
    tile.group.add(mesh);
}

async function loadNode(node: Node) {
    if (node.loaded || node.failed || node.tile.evicted) {
        node.queued = false;
        return;
    }
    if (node.tile.copc === null) return;
    node.loading = true;
    try {
        const view = await Copc.loadPointDataView(
            node.tile.url,
            node.tile.copc,
            node.entry,
            { lazPerf },
        );
        fillNodeBuffer(node, view);
        updateStatusBar(tileState);
        render(tileState);
    } catch (err) {
        console.error("Load error:", node.tile.url, node.keyStr, err);
        node.failed = true;
    } finally {
        node.loading = false;
        node.queued = false;
    }

    // Re-evaluate: more nodes may now be needed (progressive loading)
    if (!node.failed) updateLOD();
}

function unloadNode(node: Node) {
    if (!node.loaded || node.loading) return;
    if (node.mesh) node.tile.group.remove(node.mesh);
    if (node.geo) node.geo.dispose();
    node.posArr = null;
    node.clsArr = null;
    node.colArr = null;
    node.rgbArr = null;
    node.geo = null;
    node.mesh = null;
    node.loaded = false;
    node.queued = false;
}

let lodTimer: ReturnType<typeof setTimeout> | undefined = undefined;
export function scheduleLODUpdate() {
    clearTimeout(lodTimer);
    lodTimer = setTimeout(updateLOD, 400);
}

function updateLOD() {
    const frustum = getFrustum();

    const now = Date.now();

    for (const tile of tileState) {
        if (tile.failed) continue;

        const tileVisible = tile.box && frustum.intersectsBox(tile.box);
        tile.debugFrame.material.color.set(tileVisible ? 0xffff00 : 0xFF0000);

        if (!tileVisible) {
            tile.outOfViewSince ??= now;
            if (now - tile.outOfViewSince > 5_000) {
                for (const node of tile.allNodes) {
                    if (node.depth > 1) unloadNode(node);
                }
            }
            continue;
        }

        tile.outOfViewSince = null;

        for (const node of tile.allNodes) {
            if (node.failed || node.loading || node.loaded || node.queued) continue;

            const want = computeNodeTargetDepth(node);
            if (node.depth > want) continue;

            const cx = (node.box.min.x + node.box.max.x) / 2;
            const cy = (node.box.min.y + node.box.max.y) / 2;
            const dist = Math.hypot(target.x - cx, target.y - cy);
            // Lower depth (overview) and closer nodes get higher priority
            const priority = (5 - node.depth) * 1000 - dist;

            node.queued = true;
            loadQ.add(priority, () => loadNode(node));
        }
    }

    updateStatusBar(tileState);
}

// ── Dynamic tile loading ──────────────────────────────────────────────────────

let refetchTimer: ReturnType<typeof setTimeout> | undefined = undefined;
let refreshing = false;

export function scheduleRefetch() {
    clearTimeout(refetchTimer);
    refetchTimer = setTimeout(() => {
        const wx = target.x + coordOffset.x;
        const wy = target.y + coordOffset.y;
        if (Math.hypot(wx - fetchCentre.x, wy - fetchCentre.y) > REFETCH_THRESHOLD) {
            refreshTiles(wx, wy);
        }
    }, 500);
}

export async function refreshTiles(cx: number, cy: number) {
    if (refreshing) return;
    refreshing = true;
    try {
        fetchCentre.x = cx;
        fetchCentre.y = cy;

        let tileInfos;
        try {
            tileInfos = await fetch(`/api/find?x=${cx}&y=${cy}&r=${FETCH_RADIUS}`).then((r) => r.json() as Promise<APITileInfo[]>);
        } catch (err) {
            console.error("tile refresh failed:", err);
            return;
        }

        const newInfos = tileInfos.filter((info) =>
            !loadedTileNames.has(info.name)
        );
        const newStates = newInfos.map((info) => {
            loadedTileNames.add(info.name);
            const tile = makeTile(info);
            tileState.push(tile);
            tilesGroup.add(tile.group);
            return tile;
        });

        if (newStates.length > 0) {
            await Promise.allSettled(newStates.map(loadHeader));

            for (const tile of newStates) {
                if (tile.failed || !tile.copc) continue;
                const { min, max } = tile.copc.header;
                tile.box = new THREE.Box3(
                    new THREE.Vector3(
                        min[0] - coordOffset.x,
                        min[1] - coordOffset.y,
                        min[2] - coordOffset.z,
                    ),
                    new THREE.Vector3(
                        max[0] - coordOffset.x,
                        max[1] - coordOffset.y,
                        max[2] - coordOffset.z,
                    ),
                );
                tile.debugFrame = new THREE.Box3Helper(tile.box, 0xff0000);
                tile.debugFrame.visible = debugMode.get();
                tile.group.add(tile.debugFrame);
            }

            await Promise.allSettled(newStates.map(loadHierarchy));
        }

        // Evict tiles whose centre is too far from the new fetch centre
        const evict = tileState.filter((tile) => {
            if (!tile.copc) return false;
            const { min, max } = tile.copc.header;
            const tcx = (min[0] + max[0]) / 2;
            const tcy = (min[1] + max[1]) / 2;
            return Math.hypot(tcx - cx, tcy - cy) > EVICT_DISTANCE;
        });
        for (const tile of evict) {
            tile.evicted = true;
            for (const node of tile.allNodes) unloadNode(node);
            tilesGroup.remove(tile.group);
            tile.group.clear();
            loadedTileNames.delete(tile.name);
        }
        if (evict.length > 0) {
            tileState = tileState.filter((t) => !evict.includes(t));
        }

        updateLOD();
        render(tileState);
    } finally {
        refreshing = false;
    }
}
