import * as THREE from "three";
import {
    cameraReset,
    updateCamera,
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

function pinchDist(touches: TouchList) {
    return Math.hypot(
        touches[0].clientX - touches[1].clientX,
        touches[0].clientY - touches[1].clientY,
    );
}

let zoomTimer: ReturnType<typeof setTimeout> | undefined = undefined;
function scheduleURLUpdate() {
    clearTimeout(zoomTimer);
    zoomTimer = setTimeout(saveCameraToURL, 1000);
}

function saveCameraToURL() {
    const s = sph;
    const t = target;
    const toggles = ["p2r-check", "pitfree-check", "cameras-check"].map((lbl) =>
        (document.getElementById(lbl)! as HTMLInputElement).checked ? "1" : "0"
    );
    const hash = `s=${fmt(s.theta)},${fmt(s.phi)},${fmt(s.r)}&t=${fmt(t.x)},${
        fmt(t.y)
    },${fmt(t.z)}&o=${toggles[0]},${toggles[1]},${toggles[2]}&cm=${colourMode}`;
    history.replaceState(null, "", "#" + hash);
}

const fmt = (v: number) => Math.round(v * 100) / 100;

function applyDrag(dx: number, dy: number) {
    updateCamera(dx, dy, !rightDrag);
    if (!rightDrag) {
        scheduleRefetch();
    }
    scheduleLODUpdate();
}

export function initEventHandlers() {
    // about overlay
    const aboutOverlay = document.getElementById("about-overlay")!;
    document.getElementById("about-btn")!.addEventListener(
        "click",
        () => aboutOverlay.classList.add("open"),
    );
    document.getElementById("about-close")!.addEventListener(
        "click",
        () => aboutOverlay.classList.remove("open"),
    );
    aboutOverlay.addEventListener("click", (e) => {
        if (e.target === aboutOverlay) aboutOverlay.classList.remove("open");
    });

    // layer visibility
    document.querySelectorAll('#layers input[type=checkbox]').forEach(checkbox => {
        const typedCheckbox = checkbox as HTMLInputElement;
        typedCheckbox.addEventListener('change', () => {
            const g = layers[typedCheckbox.dataset.layer!];
            if (g) {
                g.visible = typedCheckbox.checked;
                render(tileState);
            }
        });
    });


    // home button
    document.getElementById("home-btn")!.addEventListener("click", () => {
        cameraReset();
        scheduleRefetch();
        scheduleLODUpdate();
        scheduleURLUpdate();
        render(tileState);
    });

    // share button
    document.getElementById("share-btn")!.addEventListener("click", async () => {
        await navigator.clipboard.writeText(globalThis.location.href);
        document.getElementById("share-btn")!.classList.add("hidden-btn");
        document.getElementById("shared-btn")!.classList.remove("hidden-btn");
        setTimeout(() => {
            document.getElementById("shared-btn")!.classList.add("hidden-btn");
            document.getElementById("share-btn")!.classList.remove("hidden-btn");
        }, 1500);
    });

    // tracking updates for URL
    document.querySelectorAll(".tracked-checkbox").forEach((cb) => {
        cb.addEventListener("change", saveCameraToURL);
    });

    // colour selection
    document.querySelectorAll(".cm-btn").forEach(btn => {
        btn.addEventListener("click", () => {
            setColourMode((btn as HTMLElement).dataset.mode!);
            document.querySelectorAll(".cm-btn")!.forEach((b) =>
                b.classList.remove("active")
            );
            btn.classList.add("active");
            document.getElementById("height-legend")!.style.display =
                colourMode === "height" ? "" : "none";
            document.getElementById("cls-legend")!.style.display =
                colourMode === "classification" ? "" : "none";
            document.getElementById("lc-legend")!.style.display =
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

    renderer.domElement.addEventListener("mousedown", (e: MouseEvent) => {
        drag = true;
        rightDrag = e.button === 2;
        prev = { x: e.clientX, y: e.clientY };
    });

    renderer.domElement.addEventListener("touchstart", (e: TouchEvent) => {
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

    globalThis.addEventListener("mousemove", (e: MouseEvent) => {
        if (!drag) return;
        applyDrag(e.clientX - prev.x, e.clientY - prev.y);
        prev = { x: e.clientX, y: e.clientY };
        render(tileState);
    });

    globalThis.addEventListener("touchmove", (e: TouchEvent) => {
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

    renderer.domElement.addEventListener("wheel", (e: WheelEvent) => {
        sph.r = Math.max(5, Math.min(50000, sph.r * (1 + e.deltaY * 0.001)));
        scheduleLODUpdate();
        scheduleURLUpdate();
        render(tileState);
    }, { passive: true });

    globalThis.addEventListener("resize", () => {
        resizeEvent(tileState);
    });
}
