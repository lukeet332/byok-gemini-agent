// Generates the Fraude app icons from an inline SVG (dev-only; uses sharp).
// The mark: a neon-green Claude-ish sunburst wearing an incognito disguise
// (groucho glasses + nose + moustache) — the "impostor" joke.
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");

const GREEN = "#39FF14";
const DARK = "#0b0f14";
const BLACK = "#0b0b0b";

function rays() {
  const N = 12;
  const out = [];
  for (let i = 0; i < N; i++) {
    const angle = i * (360 / N);
    const len = i % 2 === 0 ? 340 : 250;
    const w = 48;
    out.push(
      `<rect x="${512 - w / 2}" y="${512 - len}" width="${w}" height="${len}" rx="${w / 2}" fill="${GREEN}" transform="rotate(${angle} 512 512)"/>`
    );
  }
  return out.join("\n");
}

// Incognito disguise (sunglasses + brows + moustache), black, over the burst.
const disguise = `
  <g fill="${BLACK}" stroke-linejoin="round" stroke-linecap="round">
    <!-- eyebrows -->
    <rect x="344" y="452" width="138" height="38" rx="19" transform="rotate(-13 413 471)"/>
    <rect x="542" y="452" width="138" height="38" rx="19" transform="rotate(13 611 471)"/>
    <!-- bridge -->
    <rect x="484" y="528" width="56" height="22" rx="11"/>
    <!-- lenses (clearly separated, rimmed for contrast on the burst) -->
    <circle cx="412" cy="554" r="76" stroke="${DARK}" stroke-width="12"/>
    <circle cx="612" cy="554" r="76" stroke="${DARK}" stroke-width="12"/>
    <!-- moustache, below the lenses -->
    <path d="M 512 632 C 470 618 426 628 402 676 C 438 694 486 686 512 660 C 538 686 586 694 622 676 C 598 628 554 618 512 632 Z"/>
  </g>`;

function svg({ bg, scale }) {
  const content = `<g transform="translate(512 512) scale(${scale}) translate(-512 -512)">
    <g>${rays()}</g>
    <circle cx="512" cy="512" r="74" fill="${GREEN}"/>
    ${disguise}
  </g>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
    ${bg ? `<rect width="1024" height="1024" rx="224" fill="${DARK}"/>` : ""}
    ${content}
  </svg>`;
}

const assets = path.join(__dirname, "..", "assets");
fs.mkdirSync(assets, { recursive: true });

async function render(name, opts) {
  await sharp(Buffer.from(svg(opts))).png().toFile(path.join(assets, name));
  console.log("wrote", name);
}

(async () => {
  await render("icon.png", { bg: true, scale: 0.86 }); // full-bleed app icon
  await render("splash-icon.png", { bg: true, scale: 0.7 }); // native splash
  await render("adaptive-icon.png", { bg: false, scale: 0.62 }); // Android foreground (safe zone)
  await render("logo-mark.png", { bg: false, scale: 0.92 }); // transparent mark for the animated splash
})();
