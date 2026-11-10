// Reads a photo of the v2 paper sheet on the phone. Nothing is uploaded anywhere.
// Same steps as form_scanning/read_photos.py in berat-waste-db (keep the two in step):
//   1. find the 4 black corner squares and straighten the page, then line up each field on its own
//   2. tell the English sheet from the Albanian one
//   3. tick boxes: is there new ink in the box?
//   4. digit boxes: empty boxes are skipped, filled ones go to a tiny digit reader
// form.json, blank_<lang>.png and digits.bin are made by export_for_web.py.

const ScanReader = (() => {
  const BASE = new URL(".", document.currentScript.src).href;
  let config = null;
  let net = null;
  const blanks = {};

  // ---------- loading ----------

  let loading = null;
  function load() { // every caller waits for the same, complete load
    loading = loading || loadAll();
    return loading;
  }

  async function loadAll() {
    config = await (await fetch(BASE + "form.json")).json();
    const all = new Float32Array(await (await fetch(BASE + "digits.bin")).arrayBuffer());
    net = {};
    let offset = 0;
    for (const layer of config.digit_net.layers) {
      const size = layer.shape.reduce((a, b) => a * b, 1);
      net[layer.name] = all.subarray(offset, offset + size);
      offset += size;
    }
    for (const lang of Object.keys(config.forms)) {
      const gray = toGray(await loadBitmap(BASE + `blank_${lang}.png`), Infinity);
      const ink = inkMask(gray);
      blanks[lang] = { gray, ink, printed: dilateMask(ink, gray.w, gray.h, 4) }; // 9x9 like Python
    }
  }

  async function loadBitmap(source) {
    if (typeof source === "string") source = await (await fetch(source)).blob();
    return createImageBitmap(source); // phones' EXIF rotation is applied by the browser
  }

  // Image -> grey values (0-255), shrunk so the longest side is at most maxSide
  function toGray(bitmap, maxSide) {
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const w = Math.round(bitmap.width * scale), h = Math.round(bitmap.height * scale);
    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0, w, h);
    const rgba = ctx.getImageData(0, 0, w, h).data;
    const data = new Float32Array(w * h);
    for (let i = 0, j = 0; i < data.length; i++, j += 4) data[i] = 0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2];
    return { w, h, data };
  }

  // ---------- ink ----------

  // Max over a sliding window of 2r+1 along one line (van Herk: 3 steps per pixel)
  function maxLines(src, dst, w, h, r, horizontal) {
    const n = horizontal ? w : h, lines = horizontal ? h : w, k = 2 * r + 1, m = n + 2 * r;
    const line = new Float32Array(m), g = new Float32Array(m), hh = new Float32Array(m);
    for (let l = 0; l < lines; l++) {
      for (let i = 0; i < m; i++) {
        const p = i - r;
        line[i] = p < 0 || p >= n ? -Infinity : src[horizontal ? l * w + p : p * w + l];
      }
      for (let i = 0; i < m; i++) g[i] = i % k === 0 ? line[i] : Math.max(g[i - 1], line[i]);
      for (let i = m - 1; i >= 0; i--) hh[i] = i === m - 1 || (i + 1) % k === 0 ? line[i] : Math.max(hh[i + 1], line[i]);
      for (let i = 0; i < n; i++) dst[horizontal ? l * w + i : i * w + l] = Math.max(hh[i], g[i + 2 * r]);
    }
  }

  function maxFilter(data, w, h, r) {
    const tmp = new Float32Array(data.length), out = new Float32Array(data.length);
    maxLines(data, tmp, w, h, r, true);
    maxLines(tmp, out, w, h, r, false);
    return out;
  }

  // Ink regardless of uneven light: darker than 75% of the paper colour around it (25x25)
  function inkMask(gray) {
    const background = maxFilter(gray.data, gray.w, gray.h, 12);
    const ink = new Uint8Array(gray.data.length);
    for (let i = 0; i < ink.length; i++) ink[i] = gray.data[i] < 0.75 * background[i] ? 1 : 0;
    return ink;
  }

  function dilateMask(mask, w, h, r) {
    const out = maxFilter(Float32Array.from(mask), w, h, r);
    return Uint8Array.from(out, (v) => (v > 0 ? 1 : 0));
  }

  // ---------- corner squares ----------

  function findMarkers(gray) {
    // Work on a small copy: dark pixels compared with the average around them
    const scale = Math.min(1, 1000 / Math.max(gray.w, gray.h));
    const small = resizeArea(gray.data, gray.w, gray.h, Math.round(gray.w * scale), Math.round(gray.h * scale));
    const { w, h } = small;
    const integral = new Float64Array((w + 1) * (h + 1));
    for (let y = 0; y < h; y++) {
      let row = 0;
      for (let x = 0; x < w; x++) {
        row += small.data[y * w + x];
        integral[(y + 1) * (w + 1) + x + 1] = integral[y * (w + 1) + x + 1] + row;
      }
    }
    const r = Math.round(Math.max(w, h) / 30);
    const dark = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1), y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
        const sum = integral[y1 * (w + 1) + x1] - integral[y0 * (w + 1) + x1] - integral[y1 * (w + 1) + x0] + integral[y0 * (w + 1) + x0];
        dark[y * w + x] = small.data[y * w + x] < 0.6 * (sum / ((x1 - x0) * (y1 - y0))) ? 1 : 0;
      }
    }
    // Solid, roughly square blobs of a sensible size
    const labels = new Int32Array(w * h);
    const stack = new Int32Array(w * h);
    const blobs = [];
    const minSide = Math.max(w, h) / 120, maxSide = Math.max(w, h) / 15;
    for (let start = 0; start < w * h; start++) {
      if (!dark[start] || labels[start]) continue;
      let top = 0, area = 0, sx = 0, sy = 0, bx0 = w, by0 = h, bx1 = 0, by1 = 0;
      stack[top++] = start; labels[start] = 1;
      while (top) {
        const p = stack[--top], x = p % w, y = (p - x) / w;
        area++; sx += x; sy += y;
        if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y;
        for (const q of [p - 1, p + 1, p - w, p + w]) {
          if (q < 0 || q >= w * h || labels[q] || !dark[q]) continue;
          if ((q === p - 1 && x === 0) || (q === p + 1 && x === w - 1)) continue;
          labels[q] = 1; stack[top++] = q;
        }
      }
      const bw = bx1 - bx0 + 1, bh = by1 - by0 + 1;
      if (bw < minSide || bh < minSide || bw > maxSide || bh > maxSide) continue;
      if (bw / bh < 0.6 || bw / bh > 1.67 || area / (bw * bh) < 0.7) continue;
      blobs.push({ x: (sx / area + 0.5) / scale - 0.5, y: (sy / area + 0.5) / scale - 0.5, area });
    }
    if (blobs.length < 4) return null;
    // The corner-most blob in each direction: top-left, top-right, bottom-right, bottom-left
    const pick = (score) => blobs.reduce((best, b) => (score(b) > score(best) ? b : best));
    const corners = [pick((b) => -b.x - b.y), pick((b) => b.x - b.y), pick((b) => b.x + b.y), pick((b) => -b.x + b.y)];
    if (new Set(corners).size < 4) return null;
    const areas = corners.map((c) => c.area);
    if (Math.max(...areas) > 4 * Math.min(...areas)) return null; // not the same kind of square
    return corners;
  }

  // ---------- straighten ----------

  // 3x3 matrix H with H * (x, y, 1) ~ (u, v, 1) for 4 point pairs
  function homography(from, to) {
    const a = [], b = [];
    for (let i = 0; i < 4; i++) {
      const [x, y] = from[i], [u, v] = to[i];
      a.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
      a.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
    }
    for (let c = 0; c < 8; c++) { // Gaussian elimination
      let pivot = c;
      for (let r = c + 1; r < 8; r++) if (Math.abs(a[r][c]) > Math.abs(a[pivot][c])) pivot = r;
      [a[c], a[pivot]] = [a[pivot], a[c]]; [b[c], b[pivot]] = [b[pivot], b[c]];
      for (let r = 0; r < 8; r++) {
        if (r === c) continue;
        const f = a[r][c] / a[c][c];
        for (let k = c; k < 8; k++) a[r][k] -= f * a[c][k];
        b[r] -= f * b[c];
      }
    }
    return [...b.map((v, i) => v / a[i][i]), 1];
  }

  function straighten(gray, corners, form, size) {
    const S = config.dpi / 72;
    const H = homography(form.markers, corners.map((c) => [c.x, c.y]));
    const { w, h } = size;
    const out = new Float32Array(w * h).fill(255);
    for (let py = 0; py < h; py++) {
      const ptY = (py + 0.5) / S;
      for (let px = 0; px < w; px++) {
        const ptX = (px + 0.5) / S;
        const d = H[6] * ptX + H[7] * ptY + H[8];
        const x = (H[0] * ptX + H[1] * ptY + H[2]) / d, y = (H[3] * ptX + H[4] * ptY + H[5]) / d;
        const x0 = Math.floor(x), y0 = Math.floor(y);
        if (x0 < 0 || y0 < 0 || x0 >= gray.w - 1 || y0 >= gray.h - 1) continue;
        const fx = x - x0, fy = y - y0, i = y0 * gray.w + x0, g = gray.data;
        out[py * w + px] = (g[i] * (1 - fx) + g[i + 1] * fx) * (1 - fy) + (g[i + gray.w] * (1 - fx) + g[i + gray.w + 1] * fx) * fy;
      }
    }
    return { w, h, data: out };
  }

  // ---------- boxes ----------

  function region(box) { // points -> pixel box on the straightened page
    const S = config.dpi / 72;
    return [Math.trunc(box[0] * S), Math.trunc(box[1] * S), Math.trunc(box[2] * S), Math.trunc(box[3] * S)];
  }

  const tickBox = ([x, y]) => [x - 1, y - 2, x + 12, y + 11];
  const digitInside = (b) => [b[0] + 2, b[1] + 2, b[2] - 2, b[3] - 2];

  // ---------- digits (port of digits.py) ----------

  const pyRound = (v) => { const r = Math.round(v); return Math.abs(v % 1) === 0.5 && r % 2 ? r - 1 : r; };

  // Shrink by averaging (OpenCV INTER_AREA); grow with straight-line blending
  function resizeArea(src, sw, sh, dw, dh) {
    const out = new Float32Array(dw * dh), sx = sw / dw, sy = sh / dh;
    if (sx < 1 || sy < 1) { // growing
      for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) {
        const fx = Math.min(Math.max((x + 0.5) * sx - 0.5, 0), sw - 1), fy = Math.min(Math.max((y + 0.5) * sy - 0.5, 0), sh - 1);
        const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(x0 + 1, sw - 1), y1 = Math.min(y0 + 1, sh - 1);
        const ax = fx - x0, ay = fy - y0;
        out[y * dw + x] = (src[y0 * sw + x0] * (1 - ax) + src[y0 * sw + x1] * ax) * (1 - ay) + (src[y1 * sw + x0] * (1 - ax) + src[y1 * sw + x1] * ax) * ay;
      }
      return { w: dw, h: dh, data: out };
    }
    for (let y = 0; y < dh; y++) {
      const ya = y * sy, yb = (y + 1) * sy;
      for (let x = 0; x < dw; x++) {
        const xa = x * sx, xb = (x + 1) * sx;
        let sum = 0;
        for (let iy = Math.floor(ya); iy < Math.min(Math.ceil(yb), sh); iy++) {
          const wy = Math.min(iy + 1, yb) - Math.max(iy, ya);
          for (let ix = Math.floor(xa); ix < Math.min(Math.ceil(xb), sw); ix++) {
            sum += src[iy * sw + ix] * wy * (Math.min(ix + 1, xb) - Math.max(ix, xa));
          }
        }
        out[y * dw + x] = sum / (sx * sy);
      }
    }
    return { w: dw, h: dh, data: out };
  }

  // One box's ink -> 28x28 like MNIST: fit in 20x20, centre by centre of mass
  function toMnist(mask, w, h) {
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (mask[y * w + x]) {
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    if (x1 < 0) return null;
    const dw = x1 - x0 + 1, dh = y1 - y0 + 1;
    let digit = new Float32Array(dw * dh);
    for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) digit[y * dw + x] = mask[(y + y0) * w + x + x0];
    digit = blur3(digit, dw, dh);
    const s = 20 / Math.max(dw, dh);
    const r = resizeArea(digit, dw, dh, Math.max(1, pyRound(dw * s)), Math.max(1, pyRound(dh * s)));
    let canvas = new Float32Array(28 * 28);
    const top = Math.floor((28 - r.h) / 2), left = Math.floor((28 - r.w) / 2);
    for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) canvas[(y + top) * 28 + x + left] = r.data[y * r.w + x];
    let m00 = 0, m10 = 0, m01 = 0;
    for (let y = 0; y < 28; y++) for (let x = 0; x < 28; x++) { const v = canvas[y * 28 + x]; m00 += v; m10 += x * v; m01 += y * v; }
    if (m00) canvas = shift(canvas, 14 - m10 / m00, 14 - m01 / m00);
    let max = 1e-6;
    for (const v of canvas) if (v > max) max = v;
    return canvas.map((v) => Math.min(1, Math.max(0, v / max)));
  }

  function blur3(src, w, h) { // OpenCV GaussianBlur 3x3: [1 2 1]/4, mirrored edges
    const at = (i, n) => (n === 1 ? 0 : i < 0 ? -i : i >= n ? 2 * n - 2 - i : i);
    const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++)
      tmp[y * w + x] = 0.25 * src[y * w + at(x - 1, w)] + 0.5 * src[y * w + x] + 0.25 * src[y * w + at(x + 1, w)];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++)
      out[y * w + x] = 0.25 * tmp[at(y - 1, h) * w + x] + 0.5 * tmp[y * w + x] + 0.25 * tmp[at(y + 1, h) * w + x];
    return out;
  }

  function shift(src, tx, ty) { // move the picture by (tx, ty), blending pixels, empty outside
    const out = new Float32Array(28 * 28);
    for (let y = 0; y < 28; y++) for (let x = 0; x < 28; x++) {
      const fx = x - tx, fy = y - ty, x0 = Math.floor(fx), y0 = Math.floor(fy), ax = fx - x0, ay = fy - y0;
      const get = (xx, yy) => (xx < 0 || yy < 0 || xx > 27 || yy > 27 ? 0 : src[yy * 28 + xx]);
      out[y * 28 + x] = (get(x0, y0) * (1 - ax) + get(x0 + 1, y0) * ax) * (1 - ay) + (get(x0, y0 + 1) * (1 - ax) + get(x0 + 1, y0 + 1) * ax) * ay;
    }
    return out;
  }

  function conv(input, inC, size, weight, bias, outC) { // 3x3, padding 1, then ReLU
    const out = new Float32Array(outC * size * size);
    for (let o = 0; o < outC; o++) for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      let sum = bias[o];
      for (let c = 0; c < inC; c++) for (let ky = 0; ky < 3; ky++) {
        const yy = y + ky - 1;
        if (yy < 0 || yy >= size) continue;
        for (let kx = 0; kx < 3; kx++) {
          const xx = x + kx - 1;
          if (xx < 0 || xx >= size) continue;
          sum += input[(c * size + yy) * size + xx] * weight[((o * inC + c) * 3 + ky) * 3 + kx];
        }
      }
      out[(o * size + y) * size + x] = Math.max(0, sum);
    }
    return out;
  }

  function pool(input, channels, size) { // 2x2 max
    const half = size >> 1, out = new Float32Array(channels * half * half);
    for (let c = 0; c < channels; c++) for (let y = 0; y < half; y++) for (let x = 0; x < half; x++) {
      const i = (c * size + 2 * y) * size + 2 * x;
      out[(c * half + y) * half + x] = Math.max(input[i], input[i + 1], input[i + size], input[i + size + 1]);
    }
    return out;
  }

  function dense(input, weight, bias, outN, relu) {
    const inN = input.length, out = new Float32Array(outN);
    for (let o = 0; o < outN; o++) {
      let sum = bias[o];
      for (let i = 0; i < inN; i++) sum += input[i] * weight[o * inN + i];
      out[o] = relu ? Math.max(0, sum) : sum;
    }
    return out;
  }

  function readDigit(image) { // -> [digit, confidence]
    const { mean, std } = config.digit_net;
    let x = image.map((v) => (v - mean) / std);
    x = pool(conv(x, 1, 28, net["0.weight"], net["0.bias"], 16), 16, 28);
    x = pool(conv(x, 16, 14, net["3.weight"], net["3.bias"], 32), 32, 14);
    x = dense(dense(x, net["8.weight"], net["8.bias"], 64, true), net["10.weight"], net["10.bias"], 10, false);
    const max = Math.max(...x), exp = x.map((v) => Math.exp(v - max)), total = exp.reduce((a, b) => a + b);
    const best = x.indexOf(max);
    return [String(best), exp[best] / total];
  }

  // ---------- whole sheet ----------

  async function read(file) {
    await load();
    const started = performance.now();
    const photo = toGray(await loadBitmap(file), 2400);
    const corners = findMarkers(photo);
    if (!corners) return { ok: false, reason: "markers" };

    const anyBlank = Object.values(blanks)[0].gray;
    const page = straighten(photo, corners, Object.values(config.forms)[0], anyBlank); // markers are the same on both
    const ink = inkMask(page);

    // Which sheet: the one whose printed text best matches the ink on the page
    let lang = null, bestScore = -1;
    for (const [code, blank] of Object.entries(blanks)) {
      let hit = 0, total = 0;
      for (let i = 0; i < blank.ink.length; i += 7) if (blank.ink[i]) { total++; hit += ink[i]; }
      if (hit / total > bestScore) { bestScore = hit / total; lang = code; }
    }
    if (bestScore < 0.3) return { ok: false, reason: "match", score: bestScore };

    const form = config.forms[lang];
    const values = {}, unsure = [];
    for (const [field, boxes] of Object.entries(form.checkboxes)) {
      const fieldInk = new FieldInk(ink, page, lang, Object.values(boxes).map(tickBox));
      const amounts = Object.entries(boxes).map(([option, corner]) => [option, fieldInk.share(tickBox(corner))]);
      if (amounts.length === 1 && amounts[0][0] === "yes") values[field] = amounts[0][1] >= config.tick_min ? "yes" : "no";
      else {
        const [option, amount] = amounts.reduce((a, b) => (b[1] > a[1] ? b : a));
        values[field] = amount >= config.tick_min ? option : "";
      }
    }
    for (const [field, boxes] of Object.entries(form.multi)) { // several boxes may be ticked, or none
      const fieldInk = new FieldInk(ink, page, lang, Object.values(boxes).map(tickBox));
      values[field] = Object.entries(boxes).filter(([, corner]) => fieldInk.share(tickBox(corner)) >= config.tick_min)
        .map(([option]) => option).join(",");
    }
    for (const [field, boxes] of Object.entries(form.digits)) {
      const fieldInk = new FieldInk(ink, page, lang, boxes);
      let digits = "";
      for (const box of boxes) {
        if (fieldInk.share(digitInside(box)) < config.digit_min) continue;
        const crop = fieldInk.region(digitInside(box));
        const image = toMnist(crop.data, crop.w, crop.h);
        if (!image) continue;
        const [digit, confidence] = readDigit(image);
        digits += digit;
        if (confidence < config.digit_sure && !unsure.includes(field)) unsure.push(field);
      }
      values[field] = field === "date" && digits.length === 8 ? `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4)}` : digits;
    }
    return { ok: true, lang, values, unsure, page, seconds: (performance.now() - started) / 1000 };
  }

  // ---------- lining up each field (port of FieldInk in read_photos.py) ----------
  // The corner squares straighten the page as a whole, but a bent sheet can still be a few
  // millimetres off between them. So each field is shifted until its printed lines match the
  // blank sheet, then each box fine-tunes on its own (a long row can bend along its length).

  const ptsToPx = region;

  function clipWindow([x0, y0, x1, y1], w, h) {
    return [Math.max(x0, 0), Math.max(y0, 0), Math.min(x1, w), Math.min(y1, h)];
  }

  // Shift (dx, dy) within `reach` px of `around` where the photo's ink best covers the blank
  // sheet's printed pixels inside `win` (pixels on the blank sheet). Outside the page counts as no ink.
  function bestShift(ink, w, h, blankInk, win, around, reach) {
    const [x0, y0, x1, y1] = win, pts = [], limit = config.align.search;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (blankInk[y * w + x]) pts.push(x, y);
    const score = (dx, dy) => {
      let hits = 0;
      for (let i = 0; i < pts.length; i += 2) {
        const x = pts[i] + dx, y = pts[i + 1] + dy;
        if (x >= 0 && y >= 0 && x < w && y < h) hits += ink[y * w + x];
      }
      return hits - 0.01 * (Math.abs(dx - around[0]) + Math.abs(dy - around[1]));
    };
    const search = (centre, r, step) => {
      let best = -1, shift = centre;
      for (let dy = centre[1] - r; dy <= centre[1] + r; dy += step) {
        for (let dx = centre[0] - r; dx <= centre[0] + r; dx += step) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) > limit) continue;
          const s = score(dx, dy);
          if (s > best) { best = s; shift = [dx, dy]; }
        }
      }
      return shift;
    };
    return reach <= 8 ? search(around, reach, 1) : search(search(around, reach, 3), 2, 1); // every 3rd px, then every px
  }

  class FieldInk {
    constructor(ink, page, lang, boxes) {
      const { margin, search } = config.align;
      Object.assign(this, { ink, w: page.w, h: page.h, blankInk: blanks[lang].ink, printed: blanks[lang].printed, cache: new Map() });
      const win = clipWindow(ptsToPx([Math.min(...boxes.map((b) => b[0])) - margin, Math.min(...boxes.map((b) => b[1])) - margin,
        Math.max(...boxes.map((b) => b[2])) + margin, Math.max(...boxes.map((b) => b[3])) + margin]), this.w, this.h);
      this.shift = bestShift(ink, this.w, this.h, this.blankInk, win, [0, 0], search);
    }

    region(box) { // new ink inside `box` (points), lined up for that box: { data, w, h }
      const key = box.join(",");
      if (!this.cache.has(key)) {
        const { box_margin: m, box_search: reach } = config.align;
        const win = clipWindow(ptsToPx([box[0] - m, box[1] - m, box[2] + m, box[3] + m]), this.w, this.h);
        const [dx, dy] = bestShift(this.ink, this.w, this.h, this.blankInk, win, this.shift, reach);
        const [x0, y0, x1, y1] = ptsToPx(box), rw = x1 - x0, rh = y1 - y0, data = new Uint8Array(Math.max(rw, 0) * Math.max(rh, 0));
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
          const sx = x + dx, sy = y + dy;
          const inked = sx >= 0 && sy >= 0 && sx < this.w && sy < this.h && this.ink[sy * this.w + sx];
          data[(y - y0) * rw + (x - x0)] = inked && !this.printed[y * this.w + x] ? 1 : 0;
        }
        this.cache.set(key, { data, w: rw, h: rh });
      }
      return this.cache.get(key);
    }

    share(box) {
      const { data } = this.region(box);
      let sum = 0;
      for (const v of data) sum += v;
      return data.length ? sum / data.length : 0;
    }
  }

  // ---------- Kobo link ----------

  function koboLink(result, returnUrl) {
    const form = config.forms[result.lang], values = { ...result.values };
    const check = result.unsure.map((field) => form.field_names[field] || field);
    if (values.date) {
      const [d, m, y] = values.date.split("/").map(Number);
      const real = new Date(Date.UTC(y, m - 1, d));
      if (!(real.getUTCFullYear() === y && real.getUTCMonth() === m - 1 && real.getUTCDate() === d)) {
        check.unshift(form.field_names.date || "date"); // impossible date: leave it empty for the worker
        delete values.date;
      } else {
        values.date = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      }
    }
    const params = [["source", "paper_scan"]];
    if (check.length) params.push(["scan_check", [...new Set(check)].join(", ")]);
    for (const [field, value] of Object.entries(values)) {
      if (value && config.kobo_paths[field]) params.push([field, String(value).replaceAll(",", " ")]);
    }
    let url = form.kobo_link + "?" + params.map(([k, v]) => `d[${config.kobo_paths[k] || k}]=${encodeURIComponent(v)}`).join("&");
    if (returnUrl) url += `&returnUrl=${encodeURIComponent(returnUrl)}`;
    return url;
  }

  // Straightened page with boxes drawn: red = read as ticked / filled, blue = empty
  function drawResult(result, canvas) {
    const { page, lang } = result, form = config.forms[lang], S = config.dpi / 72;
    const scale = Math.min(1, 900 / page.w);
    canvas.width = Math.round(page.w * scale); canvas.height = Math.round(page.h * scale);
    const ctx = canvas.getContext("2d"), full = document.createElement("canvas");
    full.width = page.w; full.height = page.h;
    const image = full.getContext("2d").createImageData(page.w, page.h);
    for (let i = 0; i < page.data.length; i++) image.data.set([page.data[i], page.data[i], page.data[i], 255], i * 4);
    full.getContext("2d").putImageData(image, 0, 0);
    ctx.drawImage(full, 0, 0, canvas.width, canvas.height);
    ctx.lineWidth = 2;
    const rect = (box, on) => {
      ctx.strokeStyle = on ? "#d62728" : "rgba(31,119,180,0.5)";
      ctx.strokeRect(box[0] * S * scale, box[1] * S * scale, (box[2] - box[0]) * S * scale, (box[3] - box[1]) * S * scale);
    };
    for (const [field, boxes] of Object.entries({ ...form.checkboxes, ...form.multi })) {
      const chosen = String(result.values[field] || "").split(",");
      for (const [option, corner] of Object.entries(boxes)) rect(tickBox(corner), chosen.includes(option));
    }
    for (const [field, boxes] of Object.entries(form.digits)) {
      boxes.forEach((box, i) => rect(box, i < String(result.values[field] || "").replace(/\//g, "").length));
    }
  }

  return { load, read, koboLink, drawResult, config: () => config };
})();
