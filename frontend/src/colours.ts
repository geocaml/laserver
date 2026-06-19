import {Tile, Node} from "./types.ts";

export let colourMode = 'height';
let globalZMin = 0, globalZMax = 1;

export function setColourMode(mode: string) {
    colourMode = mode;
}

export function setHeightLimits(zmin: number, zmax: number) {
    globalZMin = 0;
    globalZMax = zmax - zmin;
}

const MAKO = [
    [13/255,  27/255,  75/255],
    [26/255, 107/255, 138/255],
    [49/255, 200/255, 132/255],
    [247/255, 247/255, 158/255],
];

function heightColor(t: number, out:Float32Array, i: number) {
    t = Math.max(0, Math.min(1, t));
    const s = t * (MAKO.length - 1);
    const lo = Math.min(Math.floor(s), MAKO.length - 2);
    const f  = s - lo;
    out[i]   = MAKO[lo][0] + f * (MAKO[lo+1][0] - MAKO[lo][0]);
    out[i+1] = MAKO[lo][1] + f * (MAKO[lo+1][1] - MAKO[lo][1]);
    out[i+2] = MAKO[lo][2] + f * (MAKO[lo+1][2] - MAKO[lo][2]);
}

// Colours and labels from LAS format
const CLS_RGB = new Float32Array([
    0.50,0.50,0.50, // 0  never classified
    0.50,0.50,0.50, // 1  unassigned
    0.60,0.45,0.25, // 2  ground
    0.55,0.75,0.40, // 3  low vegetation
    0.30,0.60,0.25, // 4  medium vegetation
    0.10,0.40,0.15, // 5  high vegetation
    0.80,0.30,0.20, // 6  building
    0.90,0.10,0.90, // 7  low noise
    0.40,0.40,0.40, // 8  reserved
    0.20,0.40,0.80, // 9  water
    0.30,0.30,0.35, // 10 rail
    0.65,0.65,0.65, // 11 road surface
    0.40,0.40,0.40, // 12 reserved
    0.90,0.80,0.10, // 13 wire – guard
    0.90,0.60,0.10, // 14 wire – conductor
    0.60,0.20,0.20, // 15 transmission tower
    0.80,0.50,0.10, // 16 wire connector
    0.60,0.50,0.35, // 17 bridge deck
    1.00,0.00,0.50, // 18 high noise
]);
const CLS_LABELS = [
    'Never classified','Unassigned','Ground','Low vegetation','Medium vegetation',
    'High vegetation','Building','Low noise','Reserved','Water','Rail',
    'Road surface','Reserved','Wire – guard','Wire – conductor','Transmission tower',
    'Wire connector','Bridge deck','High noise',
];

function classColor(cls: number, out: Float32Array, i: number) {
    const c = Math.min(cls, 18) * 3;
    out[i]   = CLS_RGB[c];
    out[i+1] = CLS_RGB[c + 1];
    out[i+2] = CLS_RGB[c + 2];
}

// posArr[ci+2] is already Z - coordOffset.z = Z - gMinZ, so dividing by span
// gives the normalised height directly — no separate zArr needed.
export function applyNodeColors(node: Node, from: number, to: number) {
    const span = globalZMax - globalZMin || 1;
    for (let i = from; i < to; i++) {
        const ci = i * 3;
        if (colourMode === 'height') {
            if ((node.posArr === null) || (node.colArr === null)) return;
            heightColor(node.posArr[ci + 2] / span, node.colArr, ci);
        } else if (colourMode === 'classification') {
            if ((node.clsArr === null) || (node.colArr === null)) return;
            classColor(node.clsArr[i], node.colArr, ci);
        } else if (colourMode === 'rgb' && node.tile.hasRGB) {
            if ((node.colArr === null) || (node.rgbArr === null)) return;
            node.colArr[ci]   = node.rgbArr[ci]   / 255;
            node.colArr[ci+1] = node.rgbArr[ci+1] / 255;
            node.colArr[ci+2] = node.rgbArr[ci+2] / 255;
        // } else if (colourMode === 'landcover' && lcPixels) {
        //     if ((node.posArr === null) || (node.colArr === null)) return;
        //     // Convert from world-space back to absolute SWEREF99TM, then to raster pixel
        //     const absX = node.posArr[ci]   + coordOffset.x;
        //     const absY = node.posArr[ci+1] + coordOffset.y;
        //     const px = Math.floor((absX - lcMeta.xMin) / lcMeta.pixelSize);
        //     const py = Math.floor((lcMeta.yMax - absY) / lcMeta.pixelSize);
        //     if (px >= 0 && px < lcMeta.width && py >= 0 && py < lcMeta.height) {
        //         const pidx = (py * lcMeta.width + px) * 4;
        //         node.colArr[ci]   = lcPixels[pidx]   / 255;
        //         node.colArr[ci+1] = lcPixels[pidx+1] / 255;
        //         node.colArr[ci+2] = lcPixels[pidx+2] / 255;
            // } else {
            //     if (node.colArr === null) return;
            //     node.colArr[ci] = node.colArr[ci+1] = node.colArr[ci+2] = 0.3;
            // }
        } else {
            if ((node.posArr === null) || (node.colArr === null)) return;
            heightColor(node.posArr[ci + 2] / span, node.colArr, ci);
        }
    }
}

export function recolorAll(tileState: Tile[]) {
    for (const tile of tileState) {
        for (const node of tile.allNodes) {
            if (!node.loaded || !node.geo) continue;
            applyNodeColors(node, 0, node.pointCount);
            node.geo.attributes.color.needsUpdate = true;
        }
    }
}

// ── Classification legend (built once all depth-0 nodes are loaded) ───────────

let legendBuilt = false;
export function maybeUpdateClsLegend(tileState: Tile[]) {
    if (legendBuilt) return;
    for (const tile of tileState) {
        if (tile.failed) continue;
        const d0 = tile.allNodes.filter(n => n.depth === 0);
        if (d0.length === 0) return;  // hierarchy not loaded yet
        if (d0.some(n => !n.loaded && !n.failed)) return;
    }

    legendBuilt = true;
    const seen: Set<number> = new Set();
    for (const tile of tileState) for (const cls of tile.seenClasses) seen.add(cls);

    const clsLegend = document.getElementById('cls-legend')!;
    for (const cls of [...seen].sort((a, b) => a - b)) {
        if (cls > 18) continue;
        const c = cls * 3;
        const hex = '#' + [CLS_RGB[c], CLS_RGB[c+1], CLS_RGB[c+2]]
        .map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
        const row = document.createElement('div');
        row.className = 'cls-row';
        row.innerHTML = `<span>${CLS_LABELS[cls]}</span><span class="cls-swatch" style="background:${hex}"></span>`;
        clsLegend.appendChild(row);
    }
}
