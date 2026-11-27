export const defaultEdits = Object.freeze({
  exposure: 0,
  contrast: 0,
  highlights: 0,
  shadows: 0,
  whites: 0,
  blacks: 0,
  temperature: 0,
  tint: 0,
  saturation: 0,
  vibrance: 0,
  sharpness: 0,
  rotation: 0,
  flipX: false,
  flipY: false,
  crop: null,
  curves: null,
  light: null,
});

const activeDraws = new WeakMap();
const histogramSamples = new WeakMap();
const linearRgb = Float32Array.from({ length: 256 }, (_, index) => {
  const srgb = index / 255;
  return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
});
const encodedRgb = Uint8Array.from({ length: 8193 }, (_, index) => {
  const linear = index / 8192;
  const srgb = linear <= 0.0031308 ? linear * 12.92 : 1.055 * linear ** (1 / 2.4) - 0.055;
  return Math.round(srgb * 255);
});

const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));
const number = (value, fallback = 0) => value == null || !Number.isFinite(Number(value)) ? fallback : Number(value);
const control = (value) => clamp(number(value), -100, 100) / 100;
const encode = (value) => encodedRgb[Math.round(clamp(value, 0, 1) * 8192)];
const pause = () => new Promise((resolve) => setTimeout(resolve, 0));

async function loadDrawable(source) {
  if (typeof Blob !== "undefined" && source instanceof Blob) {
    if (typeof createImageBitmap === "function") {
      try {
        const bitmap = await createImageBitmap(source, { imageOrientation: "from-image" });
        return { image: bitmap, release: () => bitmap.close() };
      } catch {
        // The browser's HTML image decoder may support additional formats.
      }
    }
    const url = URL.createObjectURL(source);
    try {
      const result = await loadDrawable(url);
      return { image: result.image, release: () => URL.revokeObjectURL(url) };
    } catch (error) {
      URL.revokeObjectURL(url);
      throw error;
    }
  }

  const image = typeof source === "string" ? new Image() : source;
  if (typeof source === "string") {
    image.decoding = "async";
    image.src = source;
  }
  if (image?.decode) {
    try {
      await image.decode();
    } catch (error) {
      if (!image.complete || !image.naturalWidth || !image.naturalHeight) {
        throw new Error("Billedet kunne ikke åbnes. Kontrollér filens format.", { cause: error });
      }
    }
  }
  if (!(image?.naturalWidth || image?.width) || !(image?.naturalHeight || image?.height)) {
    throw new Error("Billedet indeholder ingen læsbare pixels.");
  }
  return { image, release: () => {} };
}

function geometry(image, edits, options) {
  const sourceWidth = image.naturalWidth || image.width;
  const sourceHeight = image.naturalHeight || image.height;
  const degrees = ((number(edits.rotation) % 360) + 360) % 360;
  const angle = degrees * Math.PI / 180;
  const cosine = Math.abs(Math.cos(angle));
  const sine = Math.abs(Math.sin(angle));
  const rotatedWidth = Math.round(sourceWidth * cosine + sourceHeight * sine);
  const rotatedHeight = Math.round(sourceWidth * sine + sourceHeight * cosine);

  const crop = edits.crop;
  const left = clamp(number(crop?.x), 0, 1);
  const top = clamp(number(crop?.y), 0, 1);
  const right = clamp(left + number(crop?.width, 1 - left), 0, 1);
  const bottom = clamp(top + number(crop?.height, 1 - top), 0, 1);
  let width = Math.max(1, (right - left) * rotatedWidth);
  let height = Math.max(1, (bottom - top) * rotatedHeight);
  let x = Math.min(left * rotatedWidth, rotatedWidth - width);
  let y = Math.min(top * rotatedHeight, rotatedHeight - height);
  const ratio = number(options.cropAspect ?? edits.cropAspect);
  if (ratio > 0 && width / height > ratio) {
    const newWidth = height * ratio;
    x += (width - newWidth) / 2;
    width = newWidth;
  } else if (ratio > 0) {
    const newHeight = width / ratio;
    y += (height - newHeight) / 2;
    height = newHeight;
  }

  const maxSize = number(options.maxSize);
  const requestedWidth = number(options.width);
  const requestedHeight = number(options.height);
  let scale = Math.min(
    requestedWidth > 0 ? requestedWidth / width : Infinity,
    requestedHeight > 0 ? requestedHeight / height : Infinity,
    maxSize > 0 ? maxSize / Math.max(width, height) : Infinity,
  );
  if (!Number.isFinite(scale)) scale = 1;
  if (options.allowUpscale === false || (requestedWidth <= 0 && requestedHeight <= 0)) {
    scale = Math.min(1, scale);
  }
  const outputWidth = Math.max(1, Math.round(width * scale));
  const outputHeight = Math.max(1, Math.round(height * scale));
  if (outputWidth > 32767 || outputHeight > 32767 || outputWidth * outputHeight > 268435456) {
    throw new Error("Billedet overskrider browserens grænse. Vælg en mindre eksportstørrelse.");
  }

  return {
    angle, sourceWidth, sourceHeight, rotatedWidth, rotatedHeight, x, y, width, height,
    outputWidth, outputHeight,
  };
}

function canvasContext(canvas, options) {
  const context = canvas.getContext("2d", options);
  if (!context) throw new Error("Browseren kunne ikke oprette et billedlærred.");
  return context;
}

function makeCanvas(width, height) {
  const canvas = typeof OffscreenCanvas === "function"
    ? new OffscreenCanvas(width, height)
    : document.createElement("canvas");
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  return canvas;
}

function curveTable(points) {
  if (!Array.isArray(points) || !points.length) return null;
  const pairs = points.map((point) => [Number(point?.[0] ?? point?.x), Number(point?.[1] ?? point?.y)])
    .filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  if (!pairs.length) return null;

  const scale = pairs.some(([x, y]) => x > 1 || y > 1) ? 255 : 1;
  const coordinates = new Map([[0, 0], [1, 1]]);
  for (const [x, y] of pairs) coordinates.set(clamp(x / scale, 0, 1), clamp(y / scale, 0, 1));
  const sorted = [...coordinates].sort((left, right) => left[0] - right[0]);
  let segment = 0;
  return Uint8Array.from({ length: 256 }, (_, index) => {
    const x = index / 255;
    while (segment + 1 < sorted.length - 1 && x > sorted[segment + 1][0]) segment++;
    const [leftX, leftY] = sorted[segment];
    const [rightX, rightY] = sorted[segment + 1];
    return Math.round(255 * (leftY + (rightY - leftY) * (x - leftX) / (rightX - leftX)));
  });
}

function setupAdjustments(edits) {
  const temperature = control(edits.temperature);
  const tint = control(edits.tint);
  const light = edits.light;
  const localStrength = control(light?.strength);
  const localWarmth = control(light?.warmth);
  return {
    exposure: 2 ** (control(edits.exposure) * 2),
    contrast: control(edits.contrast),
    highlights: control(edits.highlights),
    shadows: control(edits.shadows),
    whites: control(edits.whites),
    blacks: control(edits.blacks),
    redBalance: 2 ** (temperature * 0.45 + tint * 0.12),
    greenBalance: 2 ** (-tint * 0.32),
    blueBalance: 2 ** (-temperature * 0.45 + tint * 0.12),
    saturation: 1 + control(edits.saturation),
    vibrance: control(edits.vibrance),
    sharpness: clamp(control(edits.sharpness), 0, 1),
    light: localStrength || localWarmth ? {
      x: clamp(number(light.x, 0.5), 0, 1),
      y: clamp(number(light.y, 0.5), 0, 1),
      radius: clamp(number(light.radius, 0.35), 0.01, 2),
      softness: clamp(number(light.softness, 65), 0, 100) / 100,
      strength: localStrength,
      warmth: localWarmth,
    } : null,
    curves: {
      master: curveTable(edits.curves?.master ?? edits.curves?.rgb ?? edits.curves?.all),
      red: curveTable(edits.curves?.red ?? edits.curves?.r),
      green: curveTable(edits.curves?.green ?? edits.curves?.g),
      blue: curveTable(edits.curves?.blue ?? edits.curves?.b),
    },
  };
}

function drawSource(context, image, edits, dimensions) {
  const { outputWidth, outputHeight, width, height, x, y, sourceWidth, sourceHeight } = dimensions;
  context.save();
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.scale(outputWidth / width, outputHeight / height);
  context.translate(dimensions.rotatedWidth / 2 - x, dimensions.rotatedHeight / 2 - y);
  context.rotate(dimensions.angle);
  context.scale(edits.flipX ? -1 : 1, edits.flipY ? -1 : 1);
  context.drawImage(image, -sourceWidth / 2, -sourceHeight / 2);
  context.restore();
}

function localWeight(distance, innerRadius, radius) {
  if (distance <= innerRadius) return 1;
  if (distance >= radius) return 0;
  const blend = 1 - (distance - innerRadius) / (radius - innerRadius);
  return blend * blend * (3 - 2 * blend);
}

function applyTone(pixels, startY, width, height, adjustments) {
  const {
    exposure, contrast, highlights, shadows, whites, blacks, redBalance, greenBalance, blueBalance,
    saturation, vibrance, light, curves,
  } = adjustments;
  const { master, red, green, blue } = curves;
  const contrastSlope = 1 + contrast * 0.86;
  const shortestSide = Math.min(width, height);
  const lightX = light ? light.x * width : 0;
  const lightY = light ? light.y * height : 0;
  const radius = light ? shortestSide * light.radius : 0;
  const innerRadius = light ? radius * (1 - light.softness) : 0;
  const rowBytes = width * 4;

  for (let row = 0; row < pixels.length; row += rowBytes) {
    const dy = lightY - (startY + row / rowBytes + 0.5);
    const dySquared = dy * dy;
    for (let offset = row; offset < row + rowBytes; offset += 4) {
      if (pixels[offset + 3] === 0) continue;
      let redFactor = redBalance;
      let blueFactor = blueBalance;
      let gain = exposure;
      if (light && dySquared < radius * radius) {
        const dx = lightX - ((offset - row) / 4 + 0.5);
        const weight = localWeight(Math.sqrt(dx * dx + dySquared), innerRadius, radius);
        if (weight > 0) {
          gain *= 2 ** (weight * light.strength * 2);
          const warmth = 2 ** (weight * light.warmth * 0.5);
          redFactor *= warmth;
          blueFactor /= warmth;
        }
      }

      let r = linearRgb[pixels[offset]] * redFactor * gain;
      let g = linearRgb[pixels[offset + 1]] * greenBalance * gain;
      let b = linearRgb[pixels[offset + 2]] * blueFactor * gain;
      const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const bounded = clamp(luminance, 0, 1);
      const inverse = 1 - bounded;
      const shaped = 0.18 + (luminance - 0.18) * contrastSlope
        + highlights * 0.85 * bounded * bounded * inverse
        + shadows * 0.34 * Math.sqrt(bounded) * inverse * inverse
        + whites * 0.25 * bounded ** 4
        + blacks * 0.12 * inverse ** 5;
      const colorfulness = Math.max(r, g, b) - Math.min(r, g, b);
      const chroma = Math.max(0, saturation + vibrance * (1 - clamp(colorfulness, 0, 1)) * 0.8);
      r = encode(shaped + (r - luminance) * chroma);
      g = encode(shaped + (g - luminance) * chroma);
      b = encode(shaped + (b - luminance) * chroma);
      if (master) {
        r = master[r];
        g = master[g];
        b = master[b];
      }
      pixels[offset] = red ? red[r] : r;
      pixels[offset + 1] = green ? green[g] : g;
      pixels[offset + 2] = blue ? blue[b] : b;
    }
  }
}

function showClipping(pixels) {
  for (let offset = 0; offset < pixels.length; offset += 4) {
    if (pixels[offset + 3] === 0) continue;
    const r = pixels[offset];
    const g = pixels[offset + 1];
    const b = pixels[offset + 2];
    if (r >= 254 || g >= 254 || b >= 254) {
      pixels[offset] = 255;
      pixels[offset + 1] = 70;
      pixels[offset + 2] = 65;
    } else if (r <= 1 && g <= 1 && b <= 1) {
      pixels[offset] = 70;
      pixels[offset + 1] = 135;
      pixels[offset + 2] = 255;
    }
  }
}

async function sharpen(context, width, height, strength, chunkRows, yieldBetweenChunks, isCurrent) {
  if (width < 3 || height < 3) return;

  const rowBytes = width * 4;
  const amount = strength * 1.15;
  let preceding = null;
  for (let top = 0; top < height; top += chunkRows) {
    const rows = Math.min(chunkRows, height - top);
    const first = Math.max(0, top - 1);
    const last = Math.min(height, top + rows + 1);
    const frame = context.getImageData(0, first, width, last - first).data;
    if (preceding) frame.set(preceding, 0);
    const start = (top - first) * rowBytes;
    const output = context.createImageData(width, rows);
    output.data.set(frame.subarray(start, start + rows * rowBytes));
    preceding = frame.slice(start + (rows - 1) * rowBytes, start + rows * rowBytes);

    for (let row = Math.max(0, 1 - top); row < Math.min(rows, height - 1 - top); row++) {
      for (let x = 1; x < width - 1; x++) {
        const target = (row * width + x) * 4;
        const offset = start + target;
        const left = offset - 4;
        const right = offset + 4;
        const above = offset - rowBytes;
        const below = offset + rowBytes;
        const alpha = frame[offset + 3];
        if (!alpha || frame[left + 3] !== alpha || frame[right + 3] !== alpha
          || frame[above + 3] !== alpha || frame[below + 3] !== alpha) continue;
        for (let channel = 0; channel < 3; channel++) {
          const value = frame[offset + channel];
          const average = (
            frame[left + channel] + frame[right + channel] + frame[above + channel] + frame[below + channel]
          ) / 4;
          output.data[target + channel] = value + amount * (value - average);
        }
      }
    }

    context.putImageData(output, 0, top);
    if (yieldBetweenChunks && top + rows < height) {
      await pause();
      if (!isCurrent()) return;
    }
  }
}

async function renderPixels(context, width, height, edits, isCurrent) {
  const adjustments = setupAdjustments(edits);
  const toneChanged = adjustments.exposure !== 1 || adjustments.contrast || adjustments.highlights
    || adjustments.shadows || adjustments.whites || adjustments.blacks || adjustments.redBalance !== 1
    || adjustments.greenBalance !== 1 || adjustments.blueBalance !== 1 || adjustments.saturation !== 1
    || adjustments.vibrance || adjustments.light || Object.values(adjustments.curves).some(Boolean);
  const chunkRows = Math.max(16, Math.min(256, Math.floor(512_000 / width)));
  const shouldYield = width * height > 2_500_000;
  if (toneChanged) {
    for (let y = 0; y < height; y += chunkRows) {
      const frame = context.getImageData(0, y, width, Math.min(chunkRows, height - y));
      applyTone(frame.data, y, width, height, adjustments);
      context.putImageData(frame, 0, y);
      if (shouldYield && y + chunkRows < height) {
        await pause();
        if (!isCurrent()) return;
      }
    }
  }
  if (adjustments.sharpness) {
    await sharpen(context, width, height, adjustments.sharpness, chunkRows, shouldYield, isCurrent);
  }
}

async function renderPhoto(source, edits, options, isCurrent) {
  const drawable = await loadDrawable(source);
  try {
    if (!isCurrent()) return null;
    const dimensions = geometry(drawable.image, edits, options);
    const { outputWidth: width, outputHeight: height } = dimensions;
    const canvas = makeCanvas(width, height);
    const needsPixels = options.clipping || Object.entries(defaultEdits).some(([key, baseline]) => (
      !["rotation", "crop", "flipX", "flipY"].includes(key) && edits[key] != null && edits[key] !== baseline
    ));
    const context = canvasContext(canvas, { willReadFrequently: Boolean(needsPixels) });
    drawSource(context, drawable.image, edits, dimensions);
    await renderPixels(context, width, height, edits, isCurrent);
    if (!isCurrent()) return null;
    if (options.clipping) {
      histogramSamples.set(canvas, sampleHistogramCanvas(canvas));
      const chunkRows = Math.max(16, Math.min(256, Math.floor(512_000 / width)));
      for (let y = 0; y < height; y += chunkRows) {
        const frame = context.getImageData(0, y, width, Math.min(chunkRows, height - y));
        showClipping(frame.data);
        context.putImageData(frame, 0, y);
      }
    }
    if (options.background) {
      context.globalCompositeOperation = "destination-over";
      context.fillStyle = options.background;
      context.fillRect(0, 0, width, height);
      context.globalCompositeOperation = "source-over";
    }
    return canvas;
  } finally {
    drawable.release();
  }
}

export async function drawPhoto(canvas, source, edits = defaultEdits, options = {}) {
  const generation = Symbol();
  activeDraws.set(canvas, generation);
  const isCurrent = () => activeDraws.get(canvas) === generation;
  let rendered;
  try {
    rendered = await renderPhoto(source, { ...edits }, { maxSize: 1800, ...options }, isCurrent);
  } catch (error) {
    if (isCurrent()) throw error;
    return canvas;
  }
  if (!rendered || !isCurrent()) return canvas;
  const histogramSample = histogramSamples.get(rendered);
  if (histogramSample) histogramSamples.set(canvas, histogramSample);
  else histogramSamples.delete(canvas);
  if (canvas.width !== rendered.width) canvas.width = rendered.width;
  if (canvas.height !== rendered.height) canvas.height = rendered.height;
  const context = canvasContext(canvas, { willReadFrequently: true });
  context.resetTransform();
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.drawImage(rendered, 0, 0);
  return canvas;
}

function normalizedFormat(format) {
  const requested = String(format ?? "image/jpeg").toLowerCase();
  const type = requested.includes("/") ? requested : `image/${requested}`;
  if (type === "image/jpg") return "image/jpeg";
  if (["image/jpeg", "image/png", "image/webp"].includes(type)) return type;
  throw new Error("Vælg JPEG, PNG eller WebP til eksport.");
}

async function encodeCanvas(canvas, type, quality) {
  const blob = canvas.convertToBlob
    ? await canvas.convertToBlob({ type, quality })
    : await new Promise((resolve) => canvas.toBlob(resolve, type, quality));
  if (!blob?.size || blob.type !== type) throw new Error("Browseren understøtter ikke det valgte eksportformat.");
  return blob;
}

export async function exportPhoto(source, edits = defaultEdits, options = {}) {
  const type = normalizedFormat(options.format);
  const quality = clamp(number(options.quality, 0.92), 0, 1);
  const canvas = await renderPhoto(
    source,
    { ...edits },
    { ...options, clipping: false, background: type === "image/jpeg" ? "#fff" : null },
    () => true,
  );
  const blob = await encodeCanvas(canvas, type, quality);
  return type === "image/jpeg" && options.metadata && (options.includeMetadata || options.includeGps || options.includeGPS)
    ? addExif(blob, options.metadata, { ...options, width: canvas.width, height: canvas.height })
    : blob;
}

function sampleHistogramCanvas(photoCanvas) {
  const scale = Math.min(1, 480 / Math.max(photoCanvas.width, photoCanvas.height));
  const sample = makeCanvas(
    Math.max(1, Math.round(photoCanvas.width * scale)),
    Math.max(1, Math.round(photoCanvas.height * scale)),
  );
  const sampling = canvasContext(sample, { willReadFrequently: true });
  sampling.drawImage(photoCanvas, 0, 0, sample.width, sample.height);
  return sample;
}

export function drawHistogram(canvas, photoCanvas, options = {}) {
  const context = canvasContext(canvas);
  const width = canvas.width;
  const height = canvas.height;
  context.clearRect(0, 0, width, height);
  if (!width || !height || !photoCanvas?.width || !photoCanvas?.height) return null;

  const sample = histogramSamples.get(photoCanvas) || sampleHistogramCanvas(photoCanvas);
  const sampling = canvasContext(sample, { willReadFrequently: true });
  const { data } = sampling.getImageData(0, 0, sample.width, sample.height);
  const count = Object.fromEntries(
    ["luminance", "red", "green", "blue"].map((key) => [key, new Uint32Array(256)]),
  );
  for (let offset = 0; offset < data.length; offset += 4) {
    if (data[offset + 3] < 16) continue;
    const r = data[offset];
    const g = data[offset + 1];
    const b = data[offset + 2];
    count.red[r]++;
    count.green[g]++;
    count.blue[b]++;
    count.luminance[encode(0.2126 * linearRgb[r] + 0.7152 * linearRgb[g] + 0.0722 * linearRgb[b])]++;
  }

  const channels = options.channels ?? [
    ["luminance", "rgba(221,220,215,0.58)"],
    ["red", "rgba(249,91,108,0.55)"],
    ["green", "rgba(86,198,148,0.58)"],
    ["blue", "rgba(110,145,255,0.65)"],
  ];
  const peak = Math.max(1, ...channels.map(([key]) => Math.max(...count[key])));
  const maximum = Math.sqrt(peak);
  context.save();
  for (const [key, color] of channels) {
    context.strokeStyle = color;
    context.lineWidth = Math.max(1, width / 420);
    context.beginPath();
    count[key].forEach((value, index, bins) => {
      const smoothed = (bins[Math.max(0, index - 1)] + 2 * value + bins[Math.min(255, index + 1)]) / 4;
      const x = index / 255 * (width - 1);
      const y = height - 1 - (Math.sqrt(smoothed) / maximum) * (height - 4);
      if (index === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    });
    context.stroke();
  }
  context.restore();
  return count;
}

const ascii = (value) => {
  if (typeof value !== "string" || !value.trim()) return null;
  const normalized = value.replace(/[^\x20-\x7E]/g, "").trim().slice(0, 120);
  return normalized ? [...normalized].map((character) => character.charCodeAt(0)).concat(0) : null;
};

const exifAscii = (tag, value) => {
  const bytes = ascii(value);
  return bytes && { tag, type: 2, count: bytes.length, bytes: Uint8Array.from(bytes) };
};

function exifInteger(tag, value, type = 4) {
  const integer = Math.round(value);
  const byteLength = type === 3 ? 2 : 4;
  if (!Number.isSafeInteger(integer) || integer < 0 || integer >= 2 ** (8 * byteLength)) return null;
  const bytes = new Uint8Array(byteLength);
  const view = new DataView(bytes.buffer);
  if (type === 3) view.setUint16(0, integer, true);
  else view.setUint32(0, integer, true);
  return { tag, type, count: 1, bytes };
}

function exifRational(tag, values) {
  if (!values.length || values.some((value) => !Number.isFinite(value) || value < 0 || value > 1000000)) {
    return null;
  }
  const bytes = new Uint8Array(values.length * 8);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => {
    const divisor = Math.min(10000000, Math.floor(0xFFFFFFFF / Math.max(1, value)));
    view.setUint32(index * 8, Math.round(value * divisor), true);
    view.setUint32(index * 8 + 4, divisor, true);
  });
  return { tag, type: 5, count: values.length, bytes };
}

function exifDate(value) {
  if (typeof value !== "string") return null;
  const parts = /^(\d{4})[-:](\d{2})[-:](\d{2})[T ](\d{2}):(\d{2}):(\d{2})/.exec(value);
  if (!parts) return null;
  const [, year, month, day, hour, minute, second] = parts;
  return `${year}:${month}:${day} ${hour}:${minute}:${second}`;
}

function exifShutter(value) {
  if (typeof value === "string" && value.includes("/")) {
    const [numerator, denominator] = value.split("/").map(Number);
    return numerator / denominator;
  }
  return number(value, NaN);
}

function exifCoordinates(latitude, longitude) {
  const degrees = (coordinate) => {
    const absolute = Math.abs(coordinate);
    const wholeDegrees = Math.floor(absolute);
    const minutes = (absolute - wholeDegrees) * 60;
    const wholeMinutes = Math.floor(minutes);
    return [wholeDegrees, wholeMinutes, (minutes - wholeMinutes) * 60];
  };
  return [
    { tag: 0x0000, type: 1, count: 4, bytes: Uint8Array.of(2, 3, 0, 0) },
    exifAscii(0x0001, latitude >= 0 ? "N" : "S"),
    exifRational(0x0002, degrees(latitude)),
    exifAscii(0x0003, longitude >= 0 ? "E" : "W"),
    exifRational(0x0004, degrees(longitude)),
  ];
}

function exifDirectorySize(entries) {
  return 2 + 12 * entries.length + 4;
}

function createTiff(directories) {
  const tablesSize = 8 + directories.reduce((total, entries) => total + exifDirectorySize(entries), 0);
  const blockSize = directories.flat().reduce((total, { bytes }) => (
    bytes.length <= 4 ? total : total + bytes.length + bytes.length % 2
  ), tablesSize);
  const tiff = new Uint8Array(blockSize);
  const view = new DataView(tiff.buffer);
  tiff.set([0x49, 0x49, 0x2A, 0]);
  view.setUint32(4, 8, true);
  let directoryOffset = 8;
  let payloadOffset = tablesSize;
  for (const directory of directories) {
    directory.sort((left, right) => left.tag - right.tag);
    view.setUint16(directoryOffset, directory.length, true);
    directory.forEach(({ tag, type, count, bytes }, index) => {
      const entry = directoryOffset + 2 + index * 12;
      view.setUint16(entry, tag, true);
      view.setUint16(entry + 2, type, true);
      view.setUint32(entry + 4, count, true);
      if (bytes.length <= 4) {
        tiff.set(bytes, entry + 8);
      } else {
        view.setUint32(entry + 8, payloadOffset, true);
        tiff.set(bytes, payloadOffset);
        payloadOffset += bytes.length + bytes.length % 2;
      }
    });
    directoryOffset += exifDirectorySize(directory);
  }
  return tiff;
}

async function addExif(blob, metadata, { includeMetadata, includeGps, includeGPS, width, height }) {
  const primary = [];
  const technical = [];
  const gps = [];
  if (includeMetadata) {
    const captureDate = exifDate(metadata.date);
    const timezone = metadata.timezone === "Z" ? "+00:00" : metadata.timezone;
    const iso = number(metadata.iso, NaN);
    primary.push(
      exifAscii(0x010F, metadata.make),
      exifAscii(0x0110, metadata.model ?? metadata.camera),
      exifInteger(0x0112, 1, 3),
      exifAscii(0x0132, captureDate),
    );
    technical.push(
      exifRational(0x829A, [exifShutter(metadata.shutter)]),
      exifRational(0x829D, [number(metadata.aperture, NaN)]),
      exifInteger(0x8827, iso, iso <= 65535 ? 3 : 4),
      exifAscii(0x9003, captureDate),
      exifAscii(0x9011, /^[+-]\d{2}:\d{2}$/.test(timezone) ? timezone : null),
      exifRational(0x920A, [number(metadata.focalLength, NaN)]),
      exifInteger(0xA002, width),
      exifInteger(0xA003, height),
      exifAscii(0xA434, metadata.lens),
    );
  }

  const latitude = number(metadata.gps?.lat, NaN);
  const longitude = number(metadata.gps?.lng ?? metadata.gps?.lon, NaN);
  if ((includeGps || includeGPS) && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180) {
    gps.push(...exifCoordinates(latitude, longitude));
  }
  const primaryEntries = primary.filter(Boolean);
  const technicalEntries = technical.filter(Boolean);
  if (!primaryEntries.length && !technicalEntries.length && !gps.length) return blob;

  let nextDirectory = 8 + exifDirectorySize(primaryEntries) + (technicalEntries.length ? 12 : 0)
    + (gps.length ? 12 : 0);
  const directories = [primaryEntries];
  if (technicalEntries.length) {
    primaryEntries.push(exifInteger(0x8769, nextDirectory));
    directories.push(technicalEntries);
    nextDirectory += exifDirectorySize(technicalEntries);
  }
  if (gps.length) {
    primaryEntries.push(exifInteger(0x8825, nextDirectory));
    directories.push(gps);
  }
  const tiff = createTiff(directories);
  const header = Uint8Array.of(0xFF, 0xE1, 0, 0, 0x45, 0x78, 0x69, 0x66, 0, 0);
  new DataView(header.buffer).setUint16(2, header.length - 2 + tiff.length);

  const prefix = new Uint8Array(await blob.slice(0, 6).arrayBuffer());
  if (prefix[0] !== 0xFF || prefix[1] !== 0xD8) return blob;
  const jfif = prefix[2] === 0xFF && prefix[3] === 0xE0;
  const insertAt = jfif ? 4 + (prefix[4] << 8 | prefix[5]) : 2;
  return new Blob([blob.slice(0, insertAt), header, tiff, blob.slice(insertAt)], { type: "image/jpeg" });
}
