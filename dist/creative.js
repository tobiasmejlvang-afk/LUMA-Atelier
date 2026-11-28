const formats = [
  { id: 'portrait', name: 'Annonce', width: 1080, height: 1350, ratio: '4:5' },
  { id: 'story', name: 'Story', width: 1080, height: 1920, ratio: '9:16' },
  { id: 'square', name: 'Kvadrat', width: 1080, height: 1080, ratio: '1:1' },
  { id: 'banner', name: 'Banner', width: 1600, height: 900, ratio: '16:9' },
];

const recipes = [
  { id: 'light', name: 'Løft skyggerne', icon: 'develop', edits: { exposure: 0.35, shadows: 24, highlights: -10 } },
  { id: 'warm', name: 'Varmt aftenslys', icon: 'light', edits: { temperature: 24, highlights: -12, saturation: 7 } },
  { id: 'soft', name: 'Bløde toner', icon: 'layers', edits: { contrast: -16, highlights: -18, shadows: 15, saturation: -9 } },
  { id: 'mono', name: 'Sort-hvid', icon: 'mask', edits: { saturation: -100, contrast: 15 } },
];

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[char]);

const assetsIn = (project) => (project.assets || []).filter((asset) => !asset.trashed);
const trimName = (asset) => asset.name.replace(/\.[^.]+$/, '');
const clone = (value) => JSON.parse(JSON.stringify(value));
const finite = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;

function assetOptions(assets, selected, empty) {
  const initial = empty ? `<option value="">${escapeHtml(empty)}</option>` : '';
  return initial + assets.map((asset) => `<option value="${escapeHtml(asset.id)}"${asset.id === selected ? ' selected' : ''}>${escapeHtml(asset.name)}</option>`).join('');
}

function errorMessage(error) {
  return error instanceof Error ? error.message : 'Handlingen kunne ikke fuldføres.';
}

function getCreative(project) {
  project.creative ??= { design: {}, book: { name: 'Min fotobog', spreads: [] }, recipes: [] };
  return project.creative;
}

function currentEdits(ctx, asset) {
  return clone(ctx.getEdits(asset) || ctx.defaultEdits || {});
}

function paintCover(context, image, frame, position) {
  const scale = Math.max(frame.width / image.width, frame.height / image.height);
  const width = image.width * scale;
  const height = image.height * scale;
  const x = frame.x - (width - frame.width) * position.x / 100;
  const y = frame.y - (height - frame.height) * position.y / 100;
  context.save();
  context.beginPath();
  context.rect(frame.x, frame.y, frame.width, frame.height);
  context.clip();
  context.drawImage(image, x, y, width, height);
  context.restore();
  return scale;
}

function wrapText(context, text, width) {
  const lines = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word;
      if (context.measureText(candidate).width <= width) {
        line = candidate;
        continue;
      }
      if (line) lines.push(line);
      line = '';
      for (const letter of word) {
        if (line && context.measureText(line + letter).width > width) {
          lines.push(line);
          line = '';
        }
        line += letter;
      }
    }
    lines.push(line);
  }
  return lines;
}

function composeDesign(canvas, source, format, layout, width = format.width) {
  canvas.width = width;
  canvas.height = Math.round(width * format.height / format.width);
  const context = canvas.getContext('2d');
  const height = canvas.height;
  const scale = paintCover(context, source, { x: 0, y: 0, width, height }, layout);
  const text = String(layout.text ?? '').trim();
  const issues = [];
  if (!text) return { issues, scale };

  const border = Math.round(width * 0.08);
  const fontSize = Math.max(10, Math.round(width * Number(layout.size || 7) / 100));
  const lineHeight = fontSize * 1.05;
  context.font = `700 ${fontSize}px Bricolage, Arial, sans-serif`;
  const lines = wrapText(context, text, width - 2 * border);
  const textHeight = lines.length * lineHeight;
  const position = layout.placement || 'bottom';
  const top = position === 'top' ? border : position === 'middle' ? (height - textHeight) / 2 : height - border - textHeight;
  if (textHeight > height - 2 * border) issues.push('Teksten fylder mere end sikkerhedsafstanden tillader.');
  const gradient = context.createLinearGradient(0, 0, 0, height);
  gradient.addColorStop(0, position === 'top' ? 'rgba(0,0,0,.72)' : 'transparent');
  gradient.addColorStop(0.5, position === 'middle' ? 'rgba(0,0,0,.38)' : 'transparent');
  gradient.addColorStop(1, position === 'bottom' ? 'rgba(0,0,0,.76)' : 'transparent');
  context.fillStyle = gradient;
  context.fillRect(0, 0, width, height);
  context.fillStyle = layout.color || '#ffffff';
  context.textBaseline = 'top';
  lines.forEach((line, index) => context.fillText(line, border, top + index * lineHeight));
  return { issues, scale };
}

function canvasBlob(canvas, type = 'image/jpeg', quality = 0.93) {
  return new Promise((resolve, reject) => canvas.toBlob((blob) => {
    if (!blob) reject(new Error('Billedet kunne ikke eksporteres.'));
    else resolve(blob);
  }, type, quality));
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1 ? 0xedb88320 : 0) ^ (crc >>> 1);
  return crc >>> 0;
});

async function bundleJpegs(files) {
  const encoder = new TextEncoder();
  const records = [];
  const directory = [];
  let offset = 0;
  let entriesSize = 0;
  for (const { filename, blob } of files) {
    const name = encoder.encode(filename);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let crc = 0xffffffff;
    for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
    crc = (crc ^ 0xffffffff) >>> 0;
    const header = new DataView(new ArrayBuffer(30 + name.length));
    header.setUint32(0, 0x04034b50, true);
    header.setUint16(4, 20, true);
    header.setUint16(6, 0x0800, true);
    header.setUint16(12, 33, true);
    header.setUint32(14, crc, true);
    header.setUint32(18, bytes.length, true);
    header.setUint32(22, bytes.length, true);
    header.setUint16(26, name.length, true);
    new Uint8Array(header.buffer).set(name, 30);

    const entry = new DataView(new ArrayBuffer(46 + name.length));
    entry.setUint32(0, 0x02014b50, true);
    entry.setUint16(4, 20, true);
    entry.setUint16(6, 20, true);
    entry.setUint16(8, 0x0800, true);
    entry.setUint16(14, 33, true);
    entry.setUint32(16, crc, true);
    entry.setUint32(20, bytes.length, true);
    entry.setUint32(24, bytes.length, true);
    entry.setUint16(28, name.length, true);
    entry.setUint32(42, offset, true);
    new Uint8Array(entry.buffer).set(name, 46);
    records.push(header.buffer, bytes);
    directory.push(entry.buffer);
    offset += header.byteLength + bytes.length;
    entriesSize += entry.byteLength;
  }
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, entriesSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...records, ...directory, end.buffer], { type: 'application/zip' });
}

async function photoCanvas(ctx, asset, edits, size) {
  const bitmap = document.createElement('canvas');
  const source = await ctx.getFile(asset);
  if (!source) throw new Error('Originalfilen mangler i projektet.');
  await ctx.drawPhoto(bitmap, source, edits, { maxSize: size });
  return bitmap;
}

function showProblem(node, error) {
  node.textContent = errorMessage(error);
  node.classList.add('cr-warning');
}

function emptyCreative(container, mode) {
  const titles = { design: 'Design', book: 'Fotobog', create: 'Skab' };
  container.innerHTML = `<section class="cr-shell"><h1>${titles[mode]}</h1><div class="cr-empty">Importér et billede i Bibliotek for at komme i gang.</div></section>`;
}

function designMarkup(assets, master, settings, active, icon) {
  const format = formats.find((entry) => entry.id === active);
  const layout = settings.layouts[active];
  return `<section class="cr-shell">
    <header class="cr-heading"><div><h1>Design</h1><p>Fire formater med samme masterfoto.</p></div>
      <button type="button" class="cr-primary" data-cr="export-all">${icon('export')} Hent alle · ZIP</button>
    </header>
    <div class="cr-design">
      <div class="cr-gallery" aria-label="Annonceformater">${formats.map((item) => `<button type="button" class="cr-card ${item.id === active ? 'cr-selected' : ''}" data-format="${item.id}" aria-pressed="${item.id === active}"><span class="cr-card-media"><canvas data-preview="${item.id}" aria-label="${item.name}, ${item.ratio}"></canvas></span><span class="cr-card-title">${item.name}<small>${item.ratio} · ${item.width} × ${item.height}</small></span></button>`).join('')}</div>
      <aside class="cr-panel">
        <label>Masterfoto<select data-cr="master">${assetOptions(assets, master.id)}</select></label>
        <button type="button" class="cr-secondary" data-cr="open-photo">Åbn master i Fremkald</button>
        <p class="cr-status" data-cr="version-status" role="status"></p>
        <button type="button" class="cr-secondary" data-cr="preview-update" hidden>Forhåndsvis masterændring</button>
        <button type="button" class="cr-secondary" data-cr="update" hidden>Godkend masteropdatering</button>
        <hr><h2>${format.name} <small>${format.ratio}</small></h2>
        <label><span>${icon('crop')} Vandret beskæring</span><input data-layout="x" type="range" min="0" max="100" value="${finite(layout.x, 50)}"></label>
        <label><span>${icon('crop')} Lodret beskæring</span><input data-layout="y" type="range" min="0" max="100" value="${finite(layout.y, 50)}"></label>
        <label>Overskrift<textarea data-layout="text" rows="2" maxlength="180" placeholder="Tilføj tekst">${escapeHtml(layout.text)}</textarea></label>
        <div class="cr-two"><label>Placering<select data-layout="placement"><option value="bottom" ${layout.placement === 'bottom' ? 'selected' : ''}>Nederst</option><option value="middle" ${layout.placement === 'middle' ? 'selected' : ''}>I midten</option><option value="top" ${layout.placement === 'top' ? 'selected' : ''}>Øverst</option></select></label>
        <label>Tekstfarve<input data-layout="color" type="color" value="${escapeHtml(layout.color)}"></label></div>
        <label>Tekststørrelse<input data-layout="size" type="range" min="3" max="20" value="${finite(layout.size, 7)}"></label>
        <hr><h2>Eksportkontrol</h2><ul class="cr-checks" data-cr="checks" aria-live="polite"><li>Kontrollerer billedet …</li></ul>
        <button type="button" class="cr-secondary" data-cr="export">${icon('export')} Hent ${format.name.toLowerCase()} · JPEG</button>
      </aside>
    </div></section>`;
}

async function renderDesign(container, ctx, assets) {
  const data = getCreative(ctx.project).design;
  const originalDimensions = new Map();
  const typeReady = document.fonts?.load('700 16px Bricolage').catch(() => {});
  let master = assets.find((asset) => asset.id === data.masterId) || ctx.activeAsset || assets[0];
  if (!assets.includes(master)) master = assets[0];
  let active = formats.some((item) => item.id === data.active) ? data.active : formats[0].id;
  let previewLatest = false;
  data.projects ??= {};

  function setup() {
    if (!Object.hasOwn(data.projects, master.id)) {
      Object.defineProperty(data.projects, master.id, { value: {
        edits: currentEdits(ctx, master),
        layouts: Object.fromEntries(formats.map(({ id }) => [id, { x: 50, y: 50, text: '', size: 7, placement: 'bottom', color: '#ffffff' }])),
      }, enumerable: true, writable: true, configurable: true });
    }
    const settings = data.projects[master.id];
    data.masterId = master.id;
    data.active = active;
    return settings;
  }

  const render = async () => {
    const settings = setup();
    const mountedAsset = master;
    container.innerHTML = designMarkup(assets, mountedAsset, settings, active, ctx.icon);
    const shell = container.firstElementChild;
    const element = (key) => shell.querySelector(`[data-cr="${key}"]`);
    const checks = element('checks');
    const exportButtons = [element('export'), element('export-all')];
    exportButtons.forEach((button) => { button.disabled = true; });
    let preview;
    const draw = () => {
      if (!preview) return;
      const format = formats.find((item) => item.id === active);
      let issues;
      for (const item of formats) {
        const canvas = shell.querySelector(`[data-preview="${item.id}"]`);
        const result = composeDesign(canvas, preview, item, settings.layouts[item.id], 420);
        if (item.id === active) issues = result.issues;
      }
      const dimensions = originalDimensions.get(mountedAsset.id);
      if (dimensions && (dimensions.width < format.width || dimensions.height < format.height)) {
        issues.push(`Masterfotoet er ${dimensions.width} × ${dimensions.height} px og skaleres op.`);
      }
      checks.classList.toggle('cr-warning', !!issues.length);
      checks.innerHTML = (issues.length ? issues : ['Beskæring og tekst inden for sikkerhedsafstand.', `${format.width} × ${format.height} px · JPEG`]).map((message) => `<li>${escapeHtml(message)}</li>`).join('');
    };
    const latestEdits = currentEdits(ctx, mountedAsset);
    const changed = JSON.stringify(latestEdits) !== JSON.stringify(settings.edits);
    const showingLatest = previewLatest && changed;
    element('version-status').textContent = showingLatest ? 'Viser den foreslåede master i alle fire formater.' : changed ? 'Master er redigeret. Opdateringen omfatter alle fire formater.' : 'Alle formater bruger samme godkendte master.';
    element('preview-update').hidden = !changed;
    element('preview-update').textContent = showingLatest ? 'Vis godkendt master' : 'Forhåndsvis masterændring';
    element('preview-update').addEventListener('click', () => { previewLatest = !previewLatest; void render(); });
    element('update').hidden = !changed;
    element('update').addEventListener('click', async () => {
      try {
        settings.edits = latestEdits;
        previewLatest = false;
        await ctx.persist();
        ctx.notify('Masteren er opdateret i fire formater.');
        if (shell.isConnected) await render();
      } catch (error) { showProblem(element('version-status'), error); }
    });
    element('open-photo').addEventListener('click', () => ctx.showEditor(mountedAsset));
    const persistSelection = () => {
      setup();
      void ctx.persist().catch((error) => showProblem(checks, error));
      void render();
    };
    element('master').addEventListener('change', (event) => {
      master = assets.find((asset) => asset.id === event.target.value) || mountedAsset;
      previewLatest = false;
      persistSelection();
    });
    shell.querySelectorAll('[data-format]').forEach((button) => button.addEventListener('click', () => {
      active = button.dataset.format;
      persistSelection();
    }));
    shell.querySelectorAll('[data-layout]').forEach((input) => {
      input.addEventListener('input', () => {
        settings.layouts[active][input.dataset.layout] = input.type === 'range' ? Number(input.value) : input.value;
        draw();
      });
      input.addEventListener('change', () => { void ctx.persist().catch((error) => showProblem(checks, error)); });
    });
    const exportDesign = async (selected) => {
      exportButtons.forEach((button) => { button.disabled = true; });
      try {
        const aspect = preview.width / preview.height;
        const required = Math.ceil(Math.max(...selected.map((item) => Math.max(item.width / aspect, item.height) * Math.max(aspect, 1))));
        const photo = await photoCanvas(ctx, mountedAsset, settings.edits, required);
        const files = [];
        for (const item of selected) {
          const canvas = document.createElement('canvas');
          composeDesign(canvas, photo, item, settings.layouts[item.id]);
          files.push({ filename: `${trimName(mountedAsset)}-${item.name.toLowerCase()}.jpg`, blob: await canvasBlob(canvas) });
        }
        const first = files[0];
        if (files.length === 1) download(first.blob, first.filename);
        else download(await bundleJpegs(files), `${trimName(mountedAsset)}-formater.zip`);
        ctx.notify(files.length === 1 ? 'Formatet er eksporteret.' : 'Fire formater er eksporteret.');
      } catch (error) { showProblem(checks, error); }
      finally { exportButtons.forEach((button) => { button.disabled = false; }); }
    };
    element('export').addEventListener('click', () => exportDesign(formats.filter(({ id }) => id === active)));
    element('export-all').addEventListener('click', () => exportDesign(formats));
    try {
      const shownEdits = showingLatest ? latestEdits : settings.edits;
      preview = await photoCanvas(ctx, mountedAsset, shownEdits, 1000);
      const source = await ctx.getFile(mountedAsset);
      const info = await editedDimensions(source, shownEdits).catch(() => null);
      originalDimensions.set(mountedAsset.id, info);
      await typeReady;
      if (!shell.isConnected) return;
      draw();
      exportButtons.forEach((button) => { button.disabled = showingLatest; });
    } catch (error) { showProblem(checks, error); }
  };
  await render();
}

async function imageDimensions(source) {
  if (source instanceof Blob && typeof createImageBitmap === 'function') {
    try {
      const image = await createImageBitmap(source);
      const size = { width: image.width, height: image.height };
      image.close();
      return size;
    } catch { /* Try the image element's supported decoders. */ }
  }
  const url = source instanceof Blob ? URL.createObjectURL(source) : source;
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    return { width: image.naturalWidth, height: image.naturalHeight };
  } finally {
    if (source instanceof Blob) URL.revokeObjectURL(url);
  }
}

async function editedDimensions(source, edits) {
  const original = await imageDimensions(source);
  const rotation = (edits.rotation || 0) * Math.PI / 180;
  const x = Math.abs(Math.cos(rotation));
  const y = Math.abs(Math.sin(rotation));
  const width = Math.round(original.width * x + original.height * y);
  const height = Math.round(original.width * y + original.height * x);
  const crop = edits.crop;
  return { width: Math.round(width * (crop?.width ?? 1)), height: Math.round(height * (crop?.height ?? 1)) };
}

const pagePrintSize = { width: 2835, height: 2362 };
const newPage = (asset) => ({ assetId: asset?.id || '', caption: '', x: 50, y: 50 });

function bookPage(assets, page, index) {
  return `<div class="cr-page"><div class="cr-paper"><canvas data-page-canvas="${index}" aria-label="Forhåndsvisning af ${index ? 'højre' : 'venstre'} side"></canvas></div>
    <label>Billede · ${index ? 'højre' : 'venstre'} side<select data-page="${index}" data-key="assetId">${assetOptions(assets, page.assetId, 'Tom side')}</select></label>
    <label>Billedtekst<input data-page="${index}" data-key="caption" type="text" maxlength="120" value="${escapeHtml(page.caption)}" placeholder="Tilføj en billedtekst"></label>
    <div class="cr-two"><label>Vandret udsnit<input data-page="${index}" data-key="x" type="range" min="0" max="100" value="${finite(page.x, 50)}"></label><label>Lodret udsnit<input data-page="${index}" data-key="y" type="range" min="0" max="100" value="${finite(page.y, 50)}"></label></div>
  </div>`;
}

function bookFrame(width, height, hasCaption) {
  const margin = Math.round(width / 24);
  return { x: margin, y: margin, width: width - 2 * margin, height: height - 2 * margin - (hasCaption ? Math.round(height * 0.13) : 0) };
}

function paintBookPage(canvas, source, page, width) {
  canvas.width = width;
  canvas.height = Math.round(width * pagePrintSize.height / pagePrintSize.width);
  const context = canvas.getContext('2d');
  context.fillStyle = '#faf8f2';
  context.fillRect(0, 0, canvas.width, canvas.height);
  const caption = page.caption.trim();
  const frame = bookFrame(canvas.width, canvas.height, !!caption);
  if (source) paintCover(context, source, frame, page);
  if (!caption) return;
  const fontSize = Math.max(10, Math.round(width * 0.024));
  const lineHeight = fontSize * 1.15;
  context.font = `${fontSize}px Georgia, serif`;
  context.fillStyle = '#18160f';
  context.textBaseline = 'top';
  wrapText(context, caption, frame.width).forEach((line, index) => context.fillText(line, frame.x, frame.y + frame.height + lineHeight * (0.55 + index)));
}

function bookPdf(pages) {
  const encoder = new TextEncoder();
  const parts = [];
  const offsets = [0];
  let bytes = 0;
  const append = (data) => {
    const chunk = typeof data === 'string' ? encoder.encode(data) : data;
    parts.push(chunk);
    bytes += chunk.byteLength ?? chunk.size;
  };
  const object = (id, ...data) => {
    offsets[id] = bytes;
    append(`${id} 0 obj\n`);
    data.forEach(append);
    append('\nendobj\n');
  };
  const width = (240 * 72 / 25.4).toFixed(3);
  const height = (200 * 72 / 25.4).toFixed(3);
  append('%PDF-1.4\n%âãÏÓ\n');
  object(1, '<< /Type /Catalog /Pages 2 0 R >>');
  object(2, `<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_, index) => `${3 + 3 * index} 0 R`).join(' ')}] >>`);
  pages.forEach((page, index) => {
    const id = 3 + 3 * index;
    object(id, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /XObject << /Photo ${id + 1} 0 R >> >> /Contents ${id + 2} 0 R >>`);
    object(id + 1, `<< /Type /XObject /Subtype /Image /Width ${pagePrintSize.width} /Height ${pagePrintSize.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.size} >>\nstream\n`, page, '\nendstream');
    const commands = `q\n${width} 0 0 ${height} 0 0 cm\n/Photo Do\nQ\n`;
    object(id + 2, `<< /Length ${commands.length} >>\nstream\n${commands}endstream`);
  });
  const xref = bytes;
  append(`xref\n0 ${offsets.length}\n0000000000 65535 f \n`);
  offsets.slice(1).forEach((offset) => append(`${String(offset).padStart(10, '0')} 00000 n \n`));
  append(`trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(parts, { type: 'application/pdf' });
}

function renderBook(container, ctx, assets) {
  const book = getCreative(ctx.project).book;
  const initialSpread = { pages: [newPage(assets[0]), newPage(assets[1])] };
  let selected = Math.max(0, Math.min(book.active || 0, book.spreads.length - 1));
  let printInProgress = false;

  async function exportBook(button, status) {
    if (printInProgress) return;
    printInProgress = true;
    button.disabled = true;
    status.classList.remove('cr-warning');
    status.textContent = 'Klargør sider til PDF …';
    try {
      const pages = [];
      for (const spread of clone(book.spreads)) {
        for (const page of spread.pages) {
          const asset = assets.find((entry) => entry.id === page.assetId);
          if (page.assetId && !asset) throw new Error('Et billede i bogen mangler. Vælg et nyt billede til siden.');
          const canvas = document.createElement('canvas');
          const source = asset ? await photoCanvas(ctx, asset, currentEdits(ctx, asset), 0) : undefined;
          paintBookPage(canvas, source, page, pagePrintSize.width);
          pages.push(await canvasBlob(canvas, 'image/jpeg', 0.94));
          status.textContent = `Klargjort ${pages.length} sider …`;
        }
      }
      const filename = book.name.replace(/[\\/:*?"<>|]/g, '-');
      download(bookPdf(pages), `${filename}.pdf`);
      status.textContent = `${pages.length} sider eksporteret til PDF.`;
      ctx.notify('Fotobogen er eksporteret.');
    } catch (error) { showProblem(status, error); }
    finally { printInProgress = false; button.disabled = false; }
  }

  const render = () => {
    const spread = book.spreads[selected];
    container.innerHTML = `<section class="cr-shell"><header class="cr-heading"><div><h1>Fotobog</h1><p>Opslag med to sider · 24 × 20 cm pr. side.</p></div><button type="button" class="cr-primary" data-cr="print" ${book.spreads.length ? '' : 'disabled'}>${ctx.icon('export')} Hent fotobog · PDF</button></header>
      <div class="cr-book-bar"><label>Bogens titel<input type="text" data-cr="title" maxlength="100" value="${escapeHtml(book.name)}"></label><button type="button" class="cr-secondary" data-cr="add">Tilføj opslag</button>${book.spreads.length === 0 && assets.length > 1 ? '<button type="button" class="cr-secondary" data-cr="chronology">Opret efter optagedato</button>' : ''}</div>
      ${spread ? `<div class="cr-spreads" aria-label="Opslag">${book.spreads.map((_, index) => `<button type="button" class="cr-secondary ${index === selected ? 'cr-selected' : ''}" data-spread="${index}" aria-pressed="${index === selected}">Opslag ${index + 1}</button>`).join('')}</div>
      <div class="cr-book"><div class="cr-pages">${spread.pages.map((page, index) => bookPage(assets, page, index)).join('')}</div>
      <aside class="cr-panel"><h2>Trykkontrol</h2><p class="cr-status">10 mm sikkerhedsafstand. Billeder kontrolleres ved 300 dpi. Siderne har en lys kant.</p><ul class="cr-checks" data-cr="checks" aria-live="polite"><li>Kontrollerer opslaget …</li></ul><hr>
      <div class="cr-moves"><button type="button" class="cr-secondary" data-move="-1" ${selected === 0 ? 'disabled' : ''}>Flyt tilbage</button><button type="button" class="cr-secondary" data-move="1" ${selected === book.spreads.length - 1 ? 'disabled' : ''}>Flyt frem</button></div>
      <button type="button" class="cr-secondary" data-cr="remove">Fjern opslag</button></aside></div>` : '<div class="cr-empty">Tilføj et opslag og vælg billederne til din bog.</div>'}
      <p class="cr-status" data-cr="status" role="status"></p></section>`;
    const shell = container.firstElementChild;
    const element = (id) => shell.querySelector(`[data-cr="${id}"]`);
    const status = element('status');
    const save = () => ctx.persist().catch((error) => showProblem(status, error));
    element('title').addEventListener('change', (event) => { book.name = event.target.value.trim() || 'Min fotobog'; event.target.value = book.name; void save(); });
    const change = (step) => {
      step();
      book.active = selected;
      void save();
      render();
    };
    element('add').addEventListener('click', () => change(() => {
      book.spreads.push(book.spreads.length === 0 ? initialSpread : { pages: [newPage(), newPage()] });
      selected = book.spreads.length - 1;
    }));
    element('chronology')?.addEventListener('click', () => change(() => {
      const chronological = [...assets].sort((left, right) => String(left.overrides?.date || left.metadata?.date || '9999').localeCompare(String(right.overrides?.date || right.metadata?.date || '9999')));
      for (let index = 0; index < chronological.length; index += 2) {
        book.spreads.push({ pages: [newPage(chronological[index]), newPage(chronological[index + 1])] });
      }
      selected = 0;
    }));
    element('print').addEventListener('click', () => exportBook(element('print'), status));
    if (!spread) return;
    element('remove').addEventListener('click', () => change(() => {
      book.spreads.splice(selected, 1);
      selected = Math.max(0, Math.min(selected, book.spreads.length - 1));
    }));
    shell.querySelectorAll('[data-spread]').forEach((button) => button.addEventListener('click', () => change(() => { selected = Number(button.dataset.spread); })));
    shell.querySelectorAll('[data-move]').forEach((button) => button.addEventListener('click', () => change(() => {
      const target = selected + Number(button.dataset.move);
      [book.spreads[selected], book.spreads[target]] = [book.spreads[target], book.spreads[selected]];
      selected = target;
    })));
    const photos = [];
    const dimensions = [];
    const errors = [];
    const draw = (index) => {
      const page = spread.pages[index];
      paintBookPage(shell.querySelector(`[data-page-canvas="${index}"]`), photos[index], page, 840);
      const findings = spread.pages.map((entry, position) => {
        const name = position ? 'Højre side' : 'Venstre side';
        const info = dimensions[position];
        if (errors[position]) return [true, `${name} · ${errors[position]}`];
        if (!entry.assetId) return [false, `${name} · tom side`];
        if (!info) return [false, `${name} · kontrollerer opløsning`];
        const frame = bookFrame(pagePrintSize.width, pagePrintSize.height, !!entry.caption.trim());
        const dpi = Math.floor(300 * Math.min(info.width / frame.width, info.height / frame.height));
        return [dpi < 300, `${name} · ${dpi} dpi${dpi < 300 ? ' · under målet på 300 dpi' : ' · opløsning godkendt'}`];
      });
      element('checks').innerHTML = findings.map(([warning, note]) => `<li${warning ? ' class="cr-warning"' : ''}>${escapeHtml(note)}</li>`).join('');
    };
    const load = async (index) => {
      const id = spread.pages[index].assetId;
      const asset = assets.find((entry) => entry.id === id);
      photos[index] = undefined;
      dimensions[index] = undefined;
      errors[index] = id && !asset ? 'Billedet er i papirkurven eller mangler.' : '';
      draw(index);
      if (!asset) return;
      try {
        const edits = currentEdits(ctx, asset);
        const [photo, info] = await Promise.all([
          photoCanvas(ctx, asset, edits, 1100),
          Promise.resolve(ctx.getFile(asset)).then((source) => editedDimensions(source, edits)),
        ]);
        if (spread.pages[index].assetId !== id || !shell.isConnected) return;
        photos[index] = photo;
        dimensions[index] = info;
      } catch (error) {
        if (spread.pages[index].assetId === id) errors[index] = errorMessage(error);
      }
      draw(index);
    };
    spread.pages.forEach((_, index) => { void load(index); });
    shell.querySelectorAll('[data-page]').forEach((input) => {
      const index = Number(input.dataset.page);
      const key = input.dataset.key;
      input.addEventListener('input', () => {
        spread.pages[index][key] = input.type === 'range' ? Number(input.value) : input.value;
        if (key === 'assetId') void load(index);
        else draw(index);
      });
      input.addEventListener('change', () => { void save(); });
    });
  };
  render();
}

const promptRules = [
  { pattern: /sort.hvid|monokrom/u, recipe: recipes[3] },
  { pattern: /lysere|lysne|skygge|mørk/u, recipe: recipes[0] },
  { pattern: /varm|gylden|aften/u, recipe: recipes[1] },
  { pattern: /blød|dæmp|rolig/u, recipe: recipes[2] },
  { pattern: /kølig|kold|blålig/u, recipe: { name: 'Køligere toner', edits: { temperature: -24, saturation: -6 } } },
  { pattern: /kontrast|kraftigere|dramatisk/u, recipe: { name: 'Mere kontrast', edits: { contrast: 22, highlights: -8, shadows: -9 } } },
];

const editNames = { exposure: 'Eksponering', contrast: 'Kontrast', highlights: 'Højlys', shadows: 'Skygger', temperature: 'Temperatur', saturation: 'Mætning' };

function combinedEdits(base, adjustment, strength) {
  const result = { ...base };
  for (const [key, amount] of Object.entries(adjustment)) {
    const limit = key === 'exposure' ? 4 : 100;
    const next = (result[key] || 0) + amount * strength / 100;
    result[key] = Math.max(-limit, Math.min(limit, Math.round(next * 100) / 100));
  }
  return result;
}

function photoStats(photo) {
  const sample = document.createElement('canvas');
  sample.width = 96;
  sample.height = 96;
  const context = sample.getContext('2d', { willReadFrequently: true });
  context.drawImage(photo, 0, 0, 96, 96);
  const { data } = context.getImageData(0, 0, 96, 96);
  let tone = 0;
  let temperature = 0;
  let saturation = 0;
  let moment = 0;
  for (let index = 0; index < data.length; index += 4) {
    const [red, green, blue] = data.subarray(index, index + 3);
    const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
    tone += luminance;
    moment += luminance * luminance;
    temperature += red - blue;
    saturation += Math.max(red, green, blue) - Math.min(red, green, blue);
  }
  const count = data.length / 4;
  return { tone: tone / count, contrast: Math.sqrt(Math.max(0, moment / count - (tone / count) ** 2)), temperature: temperature / count, saturation: saturation / count };
}

function referenceAdjustment(source, reference) {
  const before = photoStats(source);
  const target = photoStats(reference);
  const limit = (value, max) => Math.max(-max, Math.min(max, Math.round(value)));
  return { exposure: limit((target.tone - before.tone) / 16, 15) / 10, contrast: limit(target.contrast - before.contrast, 30), temperature: limit((target.temperature - before.temperature) / 2, 30), saturation: limit(target.saturation - before.saturation, 30) };
}

function renderCreation(container, ctx, assets) {
  const data = getCreative(ctx.project);
  let asset = assets.includes(ctx.activeAsset) ? ctx.activeAsset : assets[0];
  let plan = null;
  let sequence = 0;
  container.innerHTML = `<section class="cr-shell"><header class="cr-heading"><div><h1>Skab</h1><p>Afprøv en opskrift, og gennemgå ændringerne før du gemmer.</p></div></header>
    <div class="cr-create"><div class="cr-create-main"><div class="cr-before-after"><figure><canvas data-cr="before" aria-label="Foto før opskrift"></canvas><figcaption>Før</figcaption></figure><figure><canvas data-cr="after" aria-label="Foto med foreslået opskrift"></canvas><figcaption>Forslag</figcaption></figure></div>
    <h2>Opskrifter</h2><div class="cr-recipes">${recipes.map((recipe) => `<button type="button" class="cr-secondary" data-recipe="${recipe.id}" aria-pressed="false">${ctx.icon(recipe.icon)} ${recipe.name}</button>`).join('')}</div>
    <div data-cr="saved"></div></div>
    <aside class="cr-panel"><label>Billede<select data-cr="image">${assetOptions(assets, asset.id)}</select></label>
    <form data-cr="prompt-form"><label>Beskriv en redigering<textarea data-cr="prompt" rows="3" maxlength="300" placeholder="F.eks. Gør billedet lysere og varmere"></textarea></label><button class="cr-secondary" type="submit">Lav forslag</button></form>
    <div class="cr-reference"><label>Referencefoto<select data-cr="reference">${assetOptions(assets, '', 'Vælg et billede')}</select></label><button type="button" class="cr-secondary" data-cr="match">Match toner</button></div>
    <hr><h2>Redigeringsplan</h2><ul class="cr-checks" data-cr="plan"><li>Vælg en opskrift eller lav et forslag.</li></ul>
    <label>Styrke<input data-cr="strength" type="range" min="0" max="100" value="100" disabled></label>
    <button type="button" class="cr-primary" data-cr="save" disabled>Gem som billedversion</button><button type="button" class="cr-secondary" data-cr="download" disabled>${ctx.icon('export')} Hent forslag · JPEG</button>
    <p class="cr-status" data-cr="status" role="status">Forslagene bruger lokale farve- og tonejusteringer.</p></aside></div></section>`;
  const shell = container.firstElementChild;
  const el = (id) => shell.querySelector(`[data-cr="${id}"]`);
  const status = el('status');
  const after = el('after');
  const before = el('before');
  const strength = el('strength');
  const save = el('save');
  const exportButton = el('download');
  const recipeEdits = () => combinedEdits(plan.base, Object.fromEntries(Object.entries(plan.edits).filter(([key]) => plan.activeKeys.includes(key))), Number(strength.value));
  const updateButtons = () => {
    for (const button of shell.querySelectorAll('[data-recipe]')) {
      button.setAttribute('aria-pressed', String(button.dataset.recipe === plan?.id));
    }
    strength.disabled = !plan;
    save.disabled = !plan?.activeKeys.length || !ctx.saveVersion;
    exportButton.disabled = !plan;
  };
  const report = (message) => {
    status.classList.remove('cr-warning');
    status.textContent = message;
  };
  const renderSaved = () => {
    const records = data.recipes.filter((entry) => entry.assetId === asset.id);
    el('saved').innerHTML = records.length ? `<h2>Gemte forslag</h2><div class="cr-recipes">${records.map((entry) => `<button type="button" class="cr-secondary" data-saved="${escapeHtml(entry.id)}">${escapeHtml(entry.name)}</button>`).join('')}</div>` : '';
    el('saved').querySelectorAll('[data-saved]').forEach((button) => button.addEventListener('click', () => {
      const record = records.find((entry) => entry.id === button.dataset.saved);
      setPlan(record);
    }));
  };
  const redraw = async () => {
    const request = ++sequence;
    const subject = asset;
    const base = plan?.base || currentEdits(ctx, subject);
    const target = plan ? recipeEdits() : base;
    try {
      const photo = await photoCanvas(ctx, subject, base, 1000);
      const suggestion = plan ? await photoCanvas(ctx, subject, target, 1000) : photo;
      if (request !== sequence || !shell.isConnected) return;
      for (const [canvas, image] of [[before, photo], [after, suggestion]]) {
        canvas.width = image.width;
        canvas.height = image.height;
        canvas.getContext('2d').drawImage(image, 0, 0);
      }
    } catch (error) { if (request === sequence) showProblem(status, error); }
  };
  function setPlan(recipe) {
    plan = { ...recipe, base: recipe.base || currentEdits(ctx, asset), activeKeys: recipe.activeKeys || Object.entries(recipe.edits).filter(([, value]) => value).map(([key]) => key) };
    strength.value = recipe.strength ?? 100;
    const steps = Object.entries(recipe.edits).filter(([, value]) => value).map(([key, value]) => `<li><label class="cr-step"><input type="checkbox" value="${escapeHtml(key)}" ${plan.activeKeys.includes(key) ? 'checked' : ''}> <span>${escapeHtml(editNames[key] || key)} ${value > 0 ? '+' : ''}${escapeHtml(String(value).replace('.', ','))}</span></label></li>`);
    el('plan').innerHTML = steps.length ? steps.join('') : '<li>Referencen har lignende toner.</li>';
    report(recipe.name);
    updateButtons();
    void redraw();
  }
  el('image').addEventListener('change', (event) => {
    asset = assets.find((entry) => entry.id === event.target.value) || assets[0];
    plan = null;
    el('plan').innerHTML = '<li>Vælg en opskrift eller lav et forslag.</li>';
    report('Forslagene bruger lokale farve- og tonejusteringer.');
    updateButtons();
    renderSaved();
    void redraw();
  });
  el('prompt-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const prompt = el('prompt').value.trim().toLocaleLowerCase('da');
    const matches = promptRules.filter(({ pattern }) => pattern.test(prompt)).map(({ recipe }) => recipe);
    if (!matches.length) {
      plan = null;
      el('plan').innerHTML = '<li>Ingen tonejusteringer fundet.</li>';
      updateButtons();
      report('Prøv en tonebeskrivelse som lysere, varmere, blødere eller sort-hvid.');
      void redraw();
      return;
    }
    const edits = Object.assign({}, ...matches.map((item) => item.edits));
    setPlan({ name: matches.map((item) => item.name).join(' + '), edits });
  });
  el('match').addEventListener('click', async (event) => {
    const reference = assets.find((entry) => entry.id === el('reference').value);
    if (!reference || reference === asset) { report('Vælg et andet billede som reference.'); return; }
    const subject = asset;
    const button = event.currentTarget;
    button.disabled = true;
    report('Sammenligner toner …');
    try {
      const [photo, referencePhoto] = await Promise.all([photoCanvas(ctx, subject, currentEdits(ctx, subject), 256), photoCanvas(ctx, reference, currentEdits(ctx, reference), 256)]);
      if (asset === subject) setPlan({ name: `Toner som ${trimName(reference)}`, edits: referenceAdjustment(photo, referencePhoto) });
    } catch (error) { if (asset === subject) showProblem(status, error); }
    finally { button.disabled = false; }
  });
  shell.querySelectorAll('[data-recipe]').forEach((button) => button.addEventListener('click', () => setPlan(recipes.find((recipe) => recipe.id === button.dataset.recipe))));
  el('plan').addEventListener('change', () => {
    if (!plan) return;
    plan.activeKeys = [...el('plan').querySelectorAll('input:checked')].map((input) => input.value);
    updateButtons();
    void redraw();
  });
  strength.addEventListener('change', () => { void redraw(); });
  save.addEventListener('click', async () => {
    if (!plan || !ctx.saveVersion) return;
    const subject = asset;
    const selectedPlan = clone(plan);
    const selectedStrength = Number(strength.value);
    const edits = recipeEdits();
    save.disabled = true;
    try {
      await ctx.saveVersion(subject, selectedPlan.name, edits);
      if (!data.recipes.some((record) => record.assetId === subject.id && record.name === selectedPlan.name && record.strength === selectedStrength && JSON.stringify(record.activeKeys) === JSON.stringify(selectedPlan.activeKeys) && JSON.stringify(record.base) === JSON.stringify(selectedPlan.base))) {
        data.recipes.push({ ...selectedPlan, id: crypto.randomUUID(), assetId: subject.id, strength: selectedStrength });
      }
      await ctx.persist();
      ctx.notify('Forslaget er gemt som billedversion.');
      renderSaved();
    } catch (error) { showProblem(status, error); }
    finally { updateButtons(); }
  });
  exportButton.addEventListener('click', async () => {
    if (!plan) return;
    exportButton.disabled = true;
    try {
      const edits = recipeEdits();
      const blob = await ctx.exportPhoto(await ctx.getFile(asset), edits, { format: 'image/jpeg', quality: 0.93 });
      download(blob, `${trimName(asset)}-forslag.jpg`);
      ctx.notify('Forslaget er eksporteret.');
    } catch (error) { showProblem(status, error); }
    finally { updateButtons(); }
  });
  renderSaved();
  void redraw();
}

export async function renderCreative(container, mode, ctx) {
  const assets = assetsIn(ctx.project);
  if (assets.length === 0) { emptyCreative(container, mode); return; }
  if (mode === 'design') await renderDesign(container, ctx, assets);
  if (mode === 'book') renderBook(container, ctx, assets);
  if (mode === 'create') renderCreation(container, ctx, assets);
}

