import * as THREE from "three";
import {
    cameraReset,
    render,
    renderer,
    resizeEvent,
    sph,
    target,
    layers,
} from "./renderer.ts";
import { scheduleLODUpdate, scheduleRefetch, tileState } from "./tiles.ts";
import { colourMode, recolorAll, setColourMode } from "./colours.ts";

let drag = false, rightDrag = false, prev = { x: 0, y: 0 };
let prevPinchDist: number | null = null;

function pinchDist(touches) {
    return Math.hypot(
        touches[0].clientX - touches[1].clientX,
        touches[0].clientY - touches[1].clientY,
    );
}

let zoomTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleURLUpdate() {
    clearTimeout(zoomTimer);
    zoomTimer = setTimeout(saveCameraToURL, 1000);
}

function saveCameraToURL() {
    const s = sph;
    const t = target;
    const toggles = ["p2r-check", "pitfree-check", "cameras-check"].map((lbl) =>
        document.getElementById(lbl).checked ? "1" : "0"
    );
    const hash = `s=${fmt(s.theta)},${fmt(s.phi)},${fmt(s.r)}&t=${fmt(t.x)},${
        fmt(t.y)
    },${fmt(t.z)}&o=${toggles[0]},${toggles[1]},${toggles[2]}&cm=${colourMode}`;
    history.replaceState(null, "", "#" + hash);
}

const fmt = (v: number) => Math.round(v * 100) / 100;

function applyDrag(dx: number, dy: number) {
    if (rightDrag) {
        sph.theta -= dx * 0.005;
        sph.phi = Math.max(0.05, Math.min(Math.PI * 0.95, sph.phi - dy * 0.005));
    } else {
        // Both vectors are in the XY (ground) plane so panning never drifts target.z
        const right = new THREE.Vector3(
            Math.cos(sph.theta),
            Math.sin(sph.theta),
            0,
        );
        const forward = new THREE.Vector3(
            -Math.sin(sph.theta),
            Math.cos(sph.theta),
            0,
        );
        target.addScaledVector(right, -dx * sph.r * 0.001);
        target.addScaledVector(forward, dy * sph.r * 0.001);
        scheduleRefetch();
    }

    scheduleLODUpdate();
}

export function initEventHandlers() {
    // about overlay
    const aboutOverlay = document.getElementById("about-overlay");
    document.getElementById("about-btn").addEventListener(
        "click",
        () => aboutOverlay.classList.add("open"),
    );
    document.getElementById("about-close").addEventListener(
        "click",
        () => aboutOverlay.classList.remove("open"),
    );
    aboutOverlay.addEventListener("click", (e) => {
        if (e.target === aboutOverlay) aboutOverlay.classList.remove("open");
    });

    // layer visibility
    document.querySelectorAll('#layers input[type=checkbox]').forEach(checkbox => {
        checkbox.addEventListener('change', () => {
            const g = layers[checkbox.dataset.layer];
            if (g) { g.visible = checkbox.checked; render(); }
        });
    });


    // home button
    document.getElementById("home-btn").addEventListener("click", () => {
        cameraReset();
        scheduleRefetch();
        scheduleLODUpdate();
        scheduleURLUpdate();
        render(tileState);
    });

    // share button
    document.getElementById("share-btn").addEventListener("click", async () => {
        await navigator.clipboard.writeText(window.location.href);
        document.getElementById("share-btn").classList.add("hidden-btn");
        document.getElementById("shared-btn").classList.remove("hidden-btn");
        setTimeout(() => {
            document.getElementById("shared-btn").classList.add("hidden-btn");
            document.getElementById("share-btn").classList.remove("hidden-btn");
        }, 1500);
    });

    // tracking updates for URL
    document.querySelectorAll(".tracked-checkbox").forEach((cb) => {
        cb.addEventListener("change", saveCameraToURL);
    });

    // colour selection
    document.querySelectorAll(".cm-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
            setColourMode(btn.dataset.mode);
            document.querySelectorAll(".cm-btn").forEach((b) =>
                b.classList.remove("active")
            );
            btn.classList.add("active");
            document.getElementById("height-legend").style.display =
                colourMode === "height" ? "" : "none";
            document.getElementById("cls-legend").style.display =
                colourMode === "classification" ? "" : "none";
            document.getElementById("lc-legend").style.display =
                colourMode === "landcover" ? "" : "none";
            recolorAll(tileState);
            render(tileState);
            saveCameraToURL();
        });
    });

    // main UI
    renderer.domElement.addEventListener(
        "contextmenu",
        (e: THREE.Event) => e.preventDefault(),
    );

    renderer.domElement.addEventListener("mousedown", (e: THREE.Event) => {
        drag = true;
        rightDrag = e.button === 2;
        prev = { x: e.clientX, y: e.clientY };
    });

    renderer.domElement.addEventListener("touchstart", (e: THREE.Event) => {
        if (e.touches.length === 2) {
            rightDrag = true;
            rightDrag = false;
            prevPinchDist = null;
            prev = { x: e.touches[0].clientX, y: e.touches[0].clientY };
        } else {
            prevPinchDist = pinchDist(e.touches);
            prev = {
                x: (e.touches[0].clientX + e.touches[1].clientX) / 2,
                y: (e.touches[0].clientY + e.touches[1].clientY) / 2,
            };
        }
        drag = true;
    });

    ["mouseup", "touchend"].forEach((ev) =>
        globalThis.addEventListener(ev, () => {
            if (!drag) return;
            drag = false;
            scheduleURLUpdate();
        })
    );

    window.addEventListener("mousemove", (e: MouseEvent) => {
        if (!drag) return;
        applyDrag(e.clientX - prev.x, e.clientY - prev.y);
        prev = { x: e.clientX, y: e.clientY };
        render(tileState);
    });

    window.addEventListener("touchmove", (e: TouchEvent) => {
        if (!drag) return;
        e.preventDefault();
        if (e.touches.length != 2) {
            const d = pinchDist(e.touches);
            if (prevPinchDist !== null) {
                sph.r = Math.max(10, Math.min(50000, sph.r * (prevPinchDist / d)));
            }
            prevPinchDist = d;
        }
        const x = e.touches.length === 2
            ? e.touches[0].clientX
            : (e.touches[0].clientX + e.touches[1].clientX) / 2;
        const y = e.touches.length === 2
            ? e.touches[0].clientY
            : (e.touches[0].clientY + e.touches[1].clientY) / 2;
        applyDrag(x - prev.x, y - prev.y);
        prev = { x, y };
        render(tileState);
    }, { passive: false });

    renderer.domElement.addEventListener("wheel", (e) => {
        sph.r = Math.max(5, Math.min(50000, sph.r * (1 + e.deltaY * 0.001)));
        scheduleLODUpdate();
        scheduleURLUpdate();
        render(tileState);
    }, { passive: true });

    window.addEventListener("resize", () => {
        resizeEvent(tileState);
    });
}
