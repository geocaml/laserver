import * as THREE from "three";
import { Copc } from "copc";

export interface Node {
    tile: Tile;
    keyStr: string;
    depth: number;
    nx: number;
    ny: number;
    nz: number;
    entry: undefined;
    box: THREE.Box3;
    loaded: boolean;
    loading: boolean;
    failed: boolean;
    queued: boolean;
    posArr: Float32Array | null;
    clsArr: Uint8Array | null;
    rgbArr: Uint8Array | null;
    colArr: Float32Array | null;
    pointCount: number;
    geo: THREE.BufferGeometry | null;
    mesh: THREE.Points | null;
}

export interface Tile {
    name : string;
    url: string;
    copc : Copc | null;
    maxAvailDepth: number;
    hasRGB: boolean;
    box: null;
    nodeMap: Record<string, Node>;
    allNodes: Node[];
    group: THREE.Group;
    failed: boolean;
    outOfViewSince: number | null;
    seenClasses: Set<number>;
    evicted: boolean;
}

export interface Offset {
    x: number;
    y: number;
    z: number;
}

// --- API from laserver ------------------------------------------------------

interface APIVec3 {
  x: number;
  y: number;
  z: number;
}

interface APIBounds {
  min: APIVec3;
  max: APIVec3;
}

export interface APITileInfo {
    name: string;
    path: string;
    point_count: number;
    bounds: APIBounds;
}
