/**
 * Generate all icon sizes from the ArmorClaw mascot source image.
 *
 * Produces:
 *   - App icons: assets/icon-{16,32,64,128,256,512}.png
 *   - macOS .icns: assets/icon.icns (via iconutil)
 *   - Tray icons: assets/tray-icon.png (white silhouette, 22x22)
 *     + tray-green.png, tray-amber.png, tray-red.png (with status dots)
 *   - DMG background: assets/dmg-background.png (540x380, dark)
 *
 * Run: node scripts/generate-icons.mjs
 */

import { execSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const __dirname = dirname(fileURLToPath(import.meta.url));
const assetsDir = join(__dirname, "..", "assets");
const src = join(assetsDir, "icon-source.png");

// ── 1. App icon sizes ────────────────────────────────────────────────────────

const sizes = [16, 32, 64, 128, 256, 512];
for (const size of sizes) {
  await sharp(src)
    .resize(size, size)
    .png()
    .toFile(join(assetsDir, `icon-${size}.png`));
  console.log(`  icon-${size}.png`);
}

// ── 2. macOS iconset → .icns ─────────────────────────────────────────────────

const iconsetDir = join(assetsDir, "icon.iconset");
mkdirSync(iconsetDir, { recursive: true });

const iconsetMap = {
  "icon_16x16.png": 16,
  "icon_16x16@2x.png": 32,
  "icon_32x32.png": 32,
  "icon_32x32@2x.png": 64,
  "icon_128x128.png": 128,
  "icon_128x128@2x.png": 256,
  "icon_256x256.png": 256,
  "icon_256x256@2x.png": 512,
  "icon_512x512.png": 512,
  "icon_512x512@2x.png": 512, // use 512 as largest available
};

for (const [name, size] of Object.entries(iconsetMap)) {
  await sharp(src).resize(size, size).png().toFile(join(iconsetDir, name));
}

execSync(`iconutil -c icns "${iconsetDir}" -o "${join(assetsDir, "icon.icns")}"`);
rmSync(iconsetDir, { recursive: true });
console.log("  icon.icns");

// ── 3. Tray icons (22x22) ───────────────────────────────────────────────────

// Extract the center of the image (the mascot+shield area) and resize to 22x22
const meta = await sharp(src).metadata();
const w = meta.width ?? 1024;
const h = meta.height ?? 1024;
// Crop to center square (the mascot is centered in the image)
const cropSize = Math.min(w, h);
const left = Math.floor((w - cropSize) / 2);
const top = Math.floor((h - cropSize) / 2);

const trayBase = await sharp(src)
  .extract({ left, top, width: cropSize, height: cropSize })
  .resize(22, 22)
  .png()
  .toBuffer();

// White silhouette for macOS template: extract alpha, fill white
// Strategy: threshold alpha to create mask, composite white over transparent
const trayGrayscale = await sharp(trayBase).ensureAlpha().extractChannel("alpha").toBuffer();

// Create a white image the same size
const whiteBuf = await sharp({
  create: { width: 22, height: 22, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } },
})
  .png()
  .toBuffer();

// Use the alpha channel from the original as the mask for the white fill
const _trayTemplate = await sharp(whiteBuf)
  .joinChannel(trayGrayscale) // This adds it as alpha
  .png()
  .toFile(join(assetsDir, "tray-icon.png"));

console.log("  tray-icon.png (white silhouette)");

// Status dot overlay function
async function addStatusDot(color, filename) {
  // Create a 6x6 colored dot
  const dotSize = 6;
  const dot = await sharp({
    create: {
      width: dotSize,
      height: dotSize,
      channels: 4,
      background: { ...color, alpha: 1 },
    },
  })
    .png()
    .toBuffer();

  // Round the dot corners (make it a circle via mask)
  const circleSvg = `<svg width="${dotSize}" height="${dotSize}"><circle cx="${dotSize / 2}" cy="${dotSize / 2}" r="${dotSize / 2}" fill="white"/></svg>`;
  const circledDot = await sharp(dot)
    .composite([{ input: Buffer.from(circleSvg), blend: "dest-in" }])
    .png()
    .toBuffer();

  // Composite the dot onto the tray base image at bottom-right
  await sharp(trayBase)
    .composite([
      {
        input: circledDot,
        left: 22 - dotSize - 1,
        top: 22 - dotSize - 1,
      },
    ])
    .png()
    .toFile(join(assetsDir, filename));

  console.log(`  ${filename}`);
}

await addStatusDot({ r: 29, g: 158, b: 117 }, "tray-green.png");
await addStatusDot({ r: 186, g: 117, b: 23 }, "tray-amber.png");
await addStatusDot({ r: 163, g: 45, b: 45 }, "tray-red.png");

// ── 4. DMG background (540x380, dark) ────────────────────────────────────────

const dmgW = 540;
const dmgH = 380;
const bgColor = { r: 12, g: 14, b: 13, alpha: 1 }; // #0C0E0D

// Create dark background
const dmgBase = sharp({
  create: { width: dmgW, height: dmgH, channels: 4, background: bgColor },
});

// Scale the mascot icon for the top area
const mascotForDmg = await sharp(src).resize(80, 80).png().toBuffer();

// "ArmorClaw" wordmark as SVG text
const wordmarkSvg = Buffer.from(`
  <svg width="${dmgW}" height="${dmgH}">
    <text x="${dmgW / 2}" y="125" text-anchor="middle"
          font-family="system-ui, -apple-system, sans-serif"
          font-size="28" font-weight="600" fill="white">ArmorClaw</text>
    <text x="${dmgW / 2}" y="340" text-anchor="middle"
          font-family="system-ui, -apple-system, sans-serif"
          font-size="14" fill="#9C9991">Drag to Applications to install</text>
  </svg>
`);

await dmgBase
  .composite([
    { input: mascotForDmg, left: Math.floor(dmgW / 2 - 40), top: 30 },
    { input: wordmarkSvg, left: 0, top: 0 },
  ])
  .png()
  .toFile(join(assetsDir, "dmg-background.png"));

console.log("  dmg-background.png");
console.log("\nIcons generated successfully");
