// Run once with: node generate-icons.js
// Generates icons/icon16.png, icons/icon48.png, icons/icon128.png

const { createCanvas } = require("canvas");
const fs = require("fs");
const path = require("path");

function roundedRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

function makeIcon(size) {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext("2d");
  const cx = size / 2;
  const cy = size / 2;
  const s = size; // shorthand

  // ── Background: rounded square with blue gradient ────────────────────────
  const bgRadius = s * 0.22;
  roundedRect(ctx, 0, 0, s, s, bgRadius);
  const bg = ctx.createLinearGradient(0, 0, s, s);
  bg.addColorStop(0, "#5B9CF6");
  bg.addColorStop(1, "#1558B0");
  ctx.fillStyle = bg;
  ctx.fill();

  // ── Padlock ──────────────────────────────────────────────────────────────
  // Body
  const bw = s * 0.50;
  const bh = s * 0.34;
  const bx = cx - bw / 2;
  const by = cy - bh * 0.15;           // nudge slightly above true center
  const br = s * 0.065;

  ctx.fillStyle = "#ffffff";
  roundedRect(ctx, bx, by, bw, bh, br);
  ctx.fill();

  // Shackle (U-shaped arc)
  const shackleWidth  = bw * 0.48;
  const shackleRadius = shackleWidth / 2;
  const shackleCx     = cx;
  const shackleCy     = by + s * 0.01;  // sits on top of body
  const lw = s * 0.08;

  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth   = lw;
  ctx.lineCap     = "round";
  ctx.beginPath();
  ctx.arc(shackleCx, shackleCy, shackleRadius, Math.PI, 0, false);
  ctx.stroke();

  // Keyhole — coloured circle + downward line
  const khR = s * 0.055;
  const khCy = by + bh * 0.40;

  ctx.fillStyle = "#1a73e8";
  ctx.beginPath();
  ctx.arc(cx, khCy, khR, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = "#1a73e8";
  ctx.lineWidth   = s * 0.038;
  ctx.lineCap     = "round";
  ctx.beginPath();
  ctx.moveTo(cx, khCy + khR);
  ctx.lineTo(cx, by + bh * 0.75);
  ctx.stroke();

  // ── Subtle inner shadow on background (polish) ───────────────────────────
  // top-left highlight
  const highlight = ctx.createLinearGradient(0, 0, 0, s * 0.5);
  highlight.addColorStop(0, "rgba(255,255,255,0.12)");
  highlight.addColorStop(1, "rgba(255,255,255,0)");
  roundedRect(ctx, 0, 0, s, s, bgRadius);
  ctx.fillStyle = highlight;
  ctx.fill();

  return canvas.toBuffer("image/png");
}

fs.mkdirSync(path.join(__dirname, "icons"), { recursive: true });

for (const size of [16, 48, 128]) {
  const buf = makeIcon(size);
  const outPath = path.join(__dirname, "icons", `icon${size}.png`);
  fs.writeFileSync(outPath, buf);
  console.log(`✓  icons/icon${size}.png`);
}
