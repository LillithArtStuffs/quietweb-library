/**
 * Pull a colour palette out of a reference image.
 *
 * Decoding happens in Chromium, so anything the browser can open works: PNG,
 * JPEG, WebP, AVIF, GIF. Useful when building a theme from character art or a
 * screenshot instead of guessing hex codes.
 *
 *     node scripts/browser/palette.mjs ref-sheet.png [--colours 12]
 *
 * Prints the most common colours and, separately, the most saturated ones,
 * because the colour that *identifies* a design is rarely the one that covers
 * the most pixels.
 */

import { access, readFile } from "node:fs/promises";
import { extname } from "node:path";
import { chromium } from "playwright";

const MAX_EDGE = 480;

function parseArguments(argv) {
  const files = [];
  let colours = 10;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--colours" || argv[index] === "--colors") {
      colours = Number(argv[index + 1]) || colours;
      index += 1;
    } else {
      files.push(argv[index]);
    }
  }
  return { files, colours };
}

function toHex([red, green, blue]) {
  return "#" + [red, green, blue].map((value) => Math.round(value).toString(16).padStart(2, "0")).join("");
}

function toHsl([red, green, blue]) {
  const [r, g, b] = [red / 255, green / 255, blue / 255];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2;
  const delta = max - min;
  if (!delta) return [0, 0, Math.round(lightness * 100)];
  const saturation = delta / (1 - Math.abs(2 * lightness - 1));
  let hue;
  if (max === r) hue = ((g - b) / delta) % 6;
  else if (max === g) hue = (b - r) / delta + 2;
  else hue = (r - g) / delta + 4;
  hue = Math.round(hue * 60);
  return [hue < 0 ? hue + 360 : hue, Math.round(saturation * 100), Math.round(lightness * 100)];
}

const MEDIA_TYPES = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
  ".avif": "image/avif", ".gif": "image/gif", ".bmp": "image/bmp"
};

async function sample(page, file) {
  // A data: URL keeps the canvas same-origin, so getImageData is allowed.
  const bytes = await readFile(file);
  const type = MEDIA_TYPES[extname(file).toLowerCase()] || "image/png";
  const url = `data:${type};base64,${bytes.toString("base64")}`;
  return page.evaluate(async ({ url, maxEdge }) => {
    const image = new Image();
    image.src = url;
    await image.decode();
    const scale = Math.min(1, maxEdge / Math.max(image.naturalWidth, image.naturalHeight));
    const width = Math.max(1, Math.round(image.naturalWidth * scale));
    const height = Math.max(1, Math.round(image.naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.drawImage(image, 0, 0, width, height);
    const { data } = context.getImageData(0, 0, width, height);

    // Bucket to a coarse grid so near-identical pixels collapse together, then
    // average the real values inside each bucket for an honest centre.
    const STEP = 12;
    const buckets = new Map();
    let counted = 0;
    for (let index = 0; index < data.length; index += 4) {
      if (data[index + 3] < 128) continue;
      const [red, green, blue] = [data[index], data[index + 1], data[index + 2]];
      const key = [red, green, blue].map((value) => Math.round(value / STEP)).join(",");
      const bucket = buckets.get(key) || { count: 0, red: 0, green: 0, blue: 0 };
      bucket.count += 1;
      bucket.red += red;
      bucket.green += green;
      bucket.blue += blue;
      buckets.set(key, bucket);
      counted += 1;
    }
    return {
      dimensions: [image.naturalWidth, image.naturalHeight],
      counted,
      buckets: [...buckets.values()].map((bucket) => ({
        rgb: [bucket.red / bucket.count, bucket.green / bucket.count, bucket.blue / bucket.count],
        share: bucket.count / counted
      }))
    };
  }, { url, maxEdge: MAX_EDGE });
}

function report(title, rows) {
  console.log(`\n  ${title}`);
  rows.forEach(({ rgb, share }) => {
    const [hue, saturation, lightness] = toHsl(rgb);
    const bar = "█".repeat(Math.max(1, Math.round(share * 60)));
    console.log(`    ${toHex(rgb)}  ${String((share * 100).toFixed(1)).padStart(5)}%  hsl(${String(hue).padStart(3)} ${String(saturation).padStart(3)}% ${String(lightness).padStart(3)}%)  ${bar}`);
  });
}

async function main() {
  const { files, colours } = parseArguments(process.argv.slice(2));
  if (!files.length) {
    console.error("usage: node scripts/browser/palette.mjs <image> [more images...] [--colours N]");
    process.exit(2);
  }
  for (const file of files) {
    try { await access(file); }
    catch (error) { console.error(`cannot read ${file}`); process.exit(2); }
  }

  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const page = await browser.newPage();
  try {
    for (const file of files) {
      const { dimensions, counted, buckets } = await sample(page, file);
      console.log(`\n${file}  ${dimensions[0]}x${dimensions[1]}  ${counted} opaque pixels sampled`);
      const byShare = [...buckets].sort((a, b) => b.share - a.share).slice(0, colours);
      report("most of the image", byShare);
      // Weighting by saturation surfaces hair and accent colours, which a
      // frequency ranking buries under skin, background and linework.
      const byVividness = [...buckets]
        .map((bucket) => ({ ...bucket, score: bucket.share * (toHsl(bucket.rgb)[1] / 100) ** 2 }))
        .sort((a, b) => b.score - a.score)
        .slice(0, colours);
      report("most saturated (accents)", byVividness);
    }
  } finally {
    await browser.close();
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
