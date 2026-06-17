import { lasinit, scheduleRefetch, setOffset } from "./tiles.ts";
import { cameraSet, sph, target } from "./renderer.ts";
import { setHeightLimits } from "./colours.ts";
import { initEventHandlers } from "./input.ts";
import { colourMode, setColourMode } from "./colours.ts";

function loadCameraFromURL() {
  const params = new URLSearchParams(globalThis.location.hash.slice(1));
  const s = params.get("s")?.split(",").map(Number);
  const t = params.get("t")?.split(",").map(Number);
  const toggles = params.get("o")?.split(",").map(Number);
  if (s?.length === 3) {
    sph.theta = s[0];
    sph.phi = s[1];
    sph.r = s[2];
  }
  if (t?.length === 3) target.set(...t);
  if (toggles?.length === 3) {
    document.getElementById("p2r-check").checked = toggles[0] === 1;
    document.getElementById("pitfree-check").checked = toggles[1] === 1;
    document.getElementById("cameras-check").checked = toggles[2] === 1;
  }
  if (params.has("cm")) {
    setColourMode(params.get("cm"));
    document.querySelectorAll(".cm-btn").forEach((b) => {
      b.classList.toggle("active", b.dataset.mode === colourMode);
    });
  }
}

async function init() {
  const loadingEl = document.getElementById("loading");

  await lasinit();

  initEventHandlers();

  // Get overall bounds and calculate the centre and height limits
  const bounds = await fetch(`/api/overview`).then((r) => r.json());
  const center_x = ((bounds.xmax - bounds.xmin) / 2) + bounds.xmin;
  const center_y = ((bounds.ymax - bounds.ymin) / 2) + bounds.ymin;

  setHeightLimits(bounds.zmin, bounds.zmax);

  setOffset(center_x, center_y, bounds.zmin);

  cameraSet(
    center_x - 5000,
    center_y - 5000,
    bounds.zmin,
    center_x + 5000,
    center_y + 5000,
    bounds.zmax,
  );

  document.getElementById("z-max").textContent = Math.round(bounds.zmax) + " m";
  document.getElementById("z-min").textContent = Math.round(bounds.zmin) + " m";

  // const anyRGB = tileStates.some(t => t.hasRGB);
  // document.getElementById('btn-rgb').style.display = anyRGB ? '' : 'none';

  loadingEl.style.display = "none";
  document.getElementById("ui").style.display = "block";
  document.getElementById("legend").style.display = "block";

  loadCameraFromURL();

  scheduleRefetch();
}

init().catch((err) => {
  document.getElementById("loading").textContent = "Error: " + err.message;
  console.error(err);
});
