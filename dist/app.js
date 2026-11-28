import { openStore } from './store.js';
import { defaultEdits, drawPhoto, drawHistogram, exportPhoto } from './imaging.js';

const $ = (id) => document.getElementById(id);
const main = $('main');
const dialog = $('dialog');
const routes = { library: 'Bibliotek', develop: 'Fremkald', retouch: 'Retouchér', create: 'Skab', design: 'Design', book: 'Fotobog', viewer: 'Fremviser', trash: 'Papirkurv', settings: 'Projektindstillinger', duplicates: 'Dubletter' };
const paths = {
  sliders:'<path d="M4 4v16M12 4v16M20 4v16M2 9h4m4 6h4m4-7h4"/>',
  folder:'<path d="M3 6h7l2 2h9v11H3z"/>',
  search:'<circle cx="10.5" cy="10.5" r="5.5"/><path d="m15 15 5 5"/>',
  settings:'<circle cx="12" cy="12" r="3"/><path d="m8 4 2 2h4l2-2 4 4-2 2v4l2 2-4 4-2-2h-4l-2 2-4-4 2-2v-4L4 8z"/>',
  photo:'<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="9" r="1.5"/><path d="m4 18 6-6 3 3 3-4 5 6"/>',
  plus:'<path d="M12 4v16M4 12h16"/>',
  arrow:'<path d="M4 12h16m-6-6 6 6-6 6"/>',
  back:'<path d="M20 12H4m6-6-6 6 6 6"/>',
  copy:'<rect x="7" y="7" width="13" height="13" rx="2"/><path d="M17 4H4v13"/>',
  menu:'<path d="M4 6h16M4 12h16M4 18h16"/>',
  close:'<path d="m5 5 14 14M5 19 19 5"/>',
};
const symbolIds = new Set([
  'library', 'develop', 'retouch', 'create', 'design', 'photo-book', 'viewer',
  'import', 'export', 'crop', 'layers', 'mask', 'brush', 'light', 'compare',
  'capture-date', 'location', 'history', 'favorite', 'trash', 'grid-view', 'list-view'
]);
function ico(name) {
  const shape = symbolIds.has(name)
    ? `<use href="./assets/brand/bisfoto-symbols.svg#${name}"></use>`
    : (paths[name] || paths.photo);
  return `<span class="icon" aria-hidden="true"><svg viewBox="0 0 24 24" focusable="false">${shape}</svg></span>`;
}
const escape = (value = '') => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const button = (action, label, icon, style = '', id = '') => `<button type="button" class="btn ${style}" data-action="${action}" ${id ? `data-id="${escape(id)}"` : ''}>${icon ? ico(icon) : ''}${escape(label)}</button>`;
const id = () => crypto.randomUUID();
const time = () => new Date().toISOString();
const initials = [['Dolomitterne','Landskab','2025-02-08'],['Den blå time','Natur','2025-04-17'],['Nordligt lys','Arkitektur','2025-07-06'],['Mod kysten','Rejse','2025-08-21']];
const metadataNames = { date:'Optaget', timezone:'Tidszone', camera:'Kamera', lens:'Objektiv', aperture:'Blænde', shutter:'Lukketid', iso:'ISO', focalLength:'Brændvidde', location:'Sted', gps:'Lokation', dimensions:'Dimensioner' };
const controlList = [['exposure','Eksponering'],['contrast','Kontrast'],['highlights','Højlys'],['shadows','Skygger'],['temperature','Temperatur'],['saturation','Mætning'],['sharpness','Skarphed',0],['rotation','Horisont',-45,45]];
const pickable = new Set(['jpg','jpeg','png','gif','webp','bmp','avif','heic','heif','tif','tiff','dng','cr2','cr3','nef','arw','raf','rw2','orf']);
const state = { route:'library', album:null, active:null, selected:new Set(), query:'', sort:'import', page:1, tab:'adjust', studio:true, channel:'single', zoom:100, hold:false, clipping:false, neutral:false, split:49, viewerMode:'album', comparing:false, importing:null, menu:false, editSequence:0, viewerSequence:0, urls:new Set() };
let project;
let storage;
let lastSave = Promise.resolve();
let saveTimer;
let toastTimer;
let observer;
let frame;
let installPrompt;

function makeProject(samples = true) {
  return { id:id(), name:'Mit fotostudie', createdAt:time(), albums:[], assets:samples ? initials.map(([name, tag, date], i) => {
    const first = { id:`demo-${i + 1}-first`, name:'Original', date:time(), edits:{ ...defaultEdits } };
    return { id:`demo-${i + 1}`, name:`${name}.jpg`, title:name, type:'image/jpeg', size:0, demoUrl:`./assets/demo-${i + 1}.jpg`, createdAt:time(), metadata:{date}, overrides:{}, versions:[first], versionId:first.id, favorite:i === 0, rating:0, tags:[tag], trashed:false };
  }) : [], preferences:{ enabled:false, project:'', general:'' }, batchHistory:[] };
}

function assetBy(id) { return project.assets.find(a => a.id === id); }
const activeAssets = () => project.assets.filter(a => !a.trashed);
const selectedAsset = () => {
  const active = assetBy(state.active);
  return active && !active.trashed ? active : activeAssets()[0] ?? null;
};
const version = (asset) => asset.versions?.find(v => v.id === asset.versionId) ?? asset.versions?.[0];
const getEdits = (asset) => asset ? { ...defaultEdits, ...(version(asset)?.edits || {}) } : { ...defaultEdits };
const effectiveMetadata = (asset) => ({ ...asset.metadata, ...asset.overrides });
const titleOf = (asset) => asset.title || asset.name;
const ext = (name) => name.split('.').pop()?.toLowerCase() || '';
const getFile = (asset) => asset && (asset.demoUrl || storage.getFile(asset.id));

function notify(message) {
  const el = $('toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 4200);
}

function write(operation) {
  const pending = lastSave.catch(() => {}).then(operation);
  lastSave = pending;
  return pending;
}

function persist() {
  clearTimeout(saveTimer);
  return write(() => storage.save(project));
}

function queueSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => persist().catch(reportError), 120);
}

function reportError(error) { notify(error?.message || String(error) || 'Der opstod en fejl.'); }

function versionSave(asset, name, edits = getEdits(asset)) {
  const next = { id:id(), name:name.trim() || 'Ny version', date:time(), edits:structuredClone(edits) };
  asset.versions.push(next);
  asset.versionId = next.id;
  return persist();
}

function applyEdits(asset, changes) {
  let current = version(asset);
  if (!current?.draft) {
    if (!asset.versions) asset.versions = [];
    current = { id:id(), name:'Redigering', date:time(), edits:getEdits(asset), draft:true };
    asset.versions.push(current);
    asset.versionId = current.id;
  }
  Object.assign(current.edits, changes);
  queueSave();
  return current;
}

function userDownload(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const link = Object.assign(document.createElement('a'), { href:url, download:fileName });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

function go(route, options = {}) {
  const fromMenu = state.menu;
  state.route = route;
  state.album = options.album || null;
  state.menu = false;
  state.page = 1;
  state.query = '';
  state.selected.clear();
  if (options.asset) state.active = options.asset.id;
  render();
  if (fromMenu) main.focus({preventScroll:true});
  window.scrollTo(0,0);
}

function showEditor(asset) {
  if (!asset) { notify('Importér eller vælg et billede først.'); return; }
  go('develop', {asset});
}

function nav(action, label, icon, count = '', active = false, item = '') {
  return `<button class="nav-btn${active ? ' active' : ''}" type="button" data-action="${action}" data-id="${escape(item)}" ${active ? 'aria-current="page"' : ''}>${ico(icon)}<span>${escape(label)}</span>${count === '' ? '' : `<span class="nav-count">${count}</span>`}</button>`;
}

function renderFrame() {
  $('shell').classList.toggle('menu-open',state.menu);
  const album = project.albums.find(row => row.id === state.album);
  $('sidebar').innerHTML = `<div class="brand-row"><button class="brand" data-action="route" data-id="library" aria-label="BisFoto Editor, startside"><img class="brand-logo" src="./assets/brand/bisfoto-logo-dark.svg" alt=""></button><button type="button" class="icon-btn nav-close" data-action="menu" aria-label="Luk navigation">${ico('close')}</button></div>
    <div class="nav-heading">Arbejdsrum</div><nav class="nav-list" aria-label="Arbejdsrum">${Object.keys(routes).slice(0,7).map(key => nav('route',routes[key],key === 'book' ? 'photo-book' : key,'',state.route === key && !state.album,key)).join('')}</nav>
    <div class="nav-heading">Samlinger</div><nav class="nav-list" aria-label="Samlinger">
      ${nav('album','Favoritter','favorite',activeAssets().filter(a => a.favorite).length,state.album === 'favorites','favorites')}
      ${nav('route','Dubletter','copy','',state.route === 'duplicates','duplicates')}
      ${project.albums.map(row => nav('album',row.name,'folder','',state.album === row.id,row.id)).join('')}
      ${nav('create-album','Nyt album','plus')}
      ${nav('route','Papirkurv','trash',project.assets.filter(a => a.trashed).length,state.route === 'trash','trash')}
    </nav><div class="sidebar-bottom">${nav('route','Indstillinger','settings','',state.route === 'settings','settings')}<div class="storage-note"><span class="dot"></span> Lokalt projekt</div></div>`;
  $('topbar').innerHTML = `<div class="row" style="flex-wrap:nowrap;min-width:0"><button class="icon-btn menu-toggle" data-action="menu" aria-controls="sidebar" aria-label="Åbn navigation" aria-expanded="${state.menu}">${ico('menu')}</button><div class="breadcrumbs"><span class="crumb-root">${escape(project.name)}</span><span class="crumb-divider" aria-hidden="true">/</span><strong>${escape(album?.name || (state.album === 'favorites' ? 'Favoritter' : routes[state.route]))}</strong></div></div>
    <div class="top-actions">${button('project','Åbn projekt','folder','subtle')}${button('import','Importér billeder','import','primary')}</div>`;
  $('footer').innerHTML = `<div class="footer-group"><span class="dot"></span><span>Originaler gemmes på denne enhed</span></div><span>${activeAssets().length.toLocaleString('da-DK')} billeder</span>`;
}

function clearThumbs() {
  observer?.disconnect();
  observer = undefined;
  for (const url of state.urls) URL.revokeObjectURL(url);
  state.urls.clear();
}

function loadThumbs(container = main) {
  async function load(node) {
    const asset = assetBy(node.dataset.thumb);
    try {
      const source = await getFile(asset);
      if (!source || !node.isConnected) return;
      const url = typeof source === 'string' ? source : URL.createObjectURL(source);
      if (typeof source !== 'string') state.urls.add(url);
      const image = new Image();
      image.alt = '';
      image.decoding = 'async';
      image.onerror = () => image.remove();
      image.src = url;
      node.append(image);
    } catch { /* Keep the file type visible if the browser cannot decode it. */ }
  }
  observer?.disconnect();
  if ('IntersectionObserver' in window) {
    observer = new IntersectionObserver(entries => {
      for (const entry of entries) if (entry.isIntersecting) {
        observer.unobserve(entry.target);
        void load(entry.target);
      }
    }, {rootMargin:'120px'});
    container.querySelectorAll('[data-thumb]').forEach(node => observer.observe(node));
  } else container.querySelectorAll('[data-thumb]').forEach(load);
}

function dateDisplay(value) {
  if (!value) return 'Ukendt dato';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('da-DK',{ dateStyle:'medium' }).format(date);
}

function matches(asset, query) {
  const m = effectiveMetadata(asset);
  const date = m.date ? new Date(m.date) : null;
  const knownDate = date && !Number.isNaN(+date);
  const month = knownDate ? new Intl.DateTimeFormat('da-DK',{month:'long'}).format(date) : '';
  const orientation = m.width && m.height ? (m.width >= m.height ? 'liggende' : 'stående') : (asset.demoUrl ? 'liggende' : '');
  const searchable = [asset.name, asset.title, ...asset.tags || [], project.name, m.date, month, m.camera, m.lens, m.location, m.gps?.lat, m.gps?.lng, orientation, `${asset.rating || 0} stjerner`, asset.favorite ? 'favorit' : ''].filter(Boolean).join(' ').toLocaleLowerCase('da');
  return query.toLocaleLowerCase('da').split(/[\s,]+/).filter(Boolean).every(term => searchable.includes(term));
}

function libraryAssets() {
  let assets = state.route === 'trash' ? project.assets.filter(a => a.trashed) : activeAssets();
  if (state.album === 'favorites') assets = assets.filter(a => a.favorite);
  else if (state.album) {
    const album = project.albums.find(row => row.id === state.album);
    if (album) assets = assets.filter(a => album.query ? matches(a, album.query) : album.assetIds.includes(a.id));
  }
  if (state.route === 'duplicates') assets = assets.filter(a => a.duplicateOf && assetBy(a.duplicateOf) && !assetBy(a.duplicateOf).trashed);
  if (state.query.trim()) assets = assets.filter(a => matches(a,state.query.trim()));
  if (state.sort === 'date') assets.sort((a,b) => String(effectiveMetadata(b).date || '').localeCompare(String(effectiveMetadata(a).date || '')));
  if (state.sort === 'name') assets.sort((a,b) => a.name.localeCompare(b.name,'da'));
  if (state.sort === 'rating') assets.sort((a,b) => (b.rating || 0) - (a.rating || 0));
  return assets;
}

function photoCard(asset) {
  const key = escape(asset.id);
  const show = state.route === 'trash' ? 'trash-photo' : 'editor';
  const thumb = `<span class="placeholder">${ico('photo')}</span>`;
  const meta = effectiveMetadata(asset);
  const t = titleOf(asset).replace(/\.(jpe?g|png|webp|avif|bmp|tiff?|heic)$/i,'');
  return `<article class="photo-card"><button type="button" class="photo-thumb" data-action="${show}" data-id="${key}" data-thumb="${key}" aria-label="Åbn ${escape(t)}">${thumb}</button>
    ${state.route === 'trash' ? '' : `<input type="checkbox" class="select-photo" data-select="${key}" aria-label="Vælg ${escape(t)}" ${state.selected.has(asset.id) ? 'checked' : ''}><button type="button" class="favorite ${asset.favorite ? 'on' : ''}" data-action="favorite" data-id="${key}" aria-label="Favorit, ${escape(t)}" aria-pressed="${!!asset.favorite}">${ico('favorite')}</button>`}
    <div class="card-caption"><span class="card-name"><strong title="${escape(asset.name)}">${escape(t)}</strong><small>${asset.duplicateOf ? 'Identisk fil' : escape(dateDisplay(meta.date))}</small></span><span class="list-location">${escape(meta.location || asset.tags?.[0] || '—')}</span><span class="file-format">${escape(ext(asset.name).toUpperCase().slice(0,6))}</span></div></article>`;
}

function renderCards() {
  const target = $('library-results');
  if (!target) return;
  clearThumbs();
  const assets = libraryAssets();
  const visible = assets.slice(0,state.page * 80);
  const view = project.catalogView === 'list' ? 'list' : 'grid';
  if ($('catalog-count')) $('catalog-count').textContent = assets.length.toLocaleString('da-DK');
  for (const toggle of main.querySelectorAll('[data-action="catalog-view"]')) {
    const active = toggle.dataset.id === view;
    toggle.setAttribute('aria-pressed', String(active));
    toggle.classList.toggle('active', active);
  }
  target.innerHTML = assets.length ? `<div class="${view === 'list' ? 'catalog-list' : 'grid catalog-grid'}">${visible.map(photoCard).join('')}</div>${visible.length < assets.length ? `<div class="row" style="margin-top:13px">${button('more','Vis flere billeder','plus','subtle')}<span class="status">${visible.length} af ${assets.length}</span></div>` : ''}`
    : `<div class="empty">${ico(state.route === 'trash' ? 'trash' : 'photo')}<strong>${state.query ? 'Ingen billeder matcher din søgning' : state.route === 'trash' ? 'Papirkurven er tom' : state.route === 'duplicates' ? 'Ingen identiske filer fundet' : 'Ingen billeder i denne samling'}</strong>${!state.query && state.route === 'library' && !state.album ? button('import','Importér billeder','import','primary') : ''}</div>`;
  loadThumbs(target);
  renderSelection();
  refreshProjectOverview();
}

function renderSelection() {
  const target = $('selection');
  if (!target) return;
  const count = state.selected.size;
  const album = project.albums.find(row => row.id === state.album);
  target.innerHTML = (count ? `<span class="selected-count">${count} valgt</span>${button('add-album','Føj til album','folder','compact')}${album && !album.query ? button('remove-album','Fjern fra album',null,'compact') : ''}${button('batch','Redigér serie','create','compact')}${button('clear-selection','Fravælg',null,'compact')}` : '') + (state.route === 'library' && project.batchHistory?.length ? button('undo-batch','Fortryd seneste serieredigering','back','compact subtle') : '');
}

function progressMarkup() {
  const item = state.importing;
  if (!item) return '';
  return `<div class="progress"><div class="row" style="justify-content:space-between"><span>${item.running ? 'Importerer' : 'Importstatus'} · ${item.done} af ${item.total}${item.failed ? ` · ${item.failed} fejl` : ''}</span>${item.running ? button('pause-import','Sæt på pause',null,'compact') : item.paused ? button('resume-import','Genoptag',null,'compact tinted') : button('dismiss-import','Luk',null,'compact')}</div><progress aria-label="Importstatus" max="${item.total || 1}" value="${item.done}"></progress>${item.errors?.length ? `<div>${escape(item.errors.slice(-3).join(' · '))}</div>` : ''}</div>`;
}

function spotlightMarkup(asset, preview) {
  if (!asset) return `<div class="empty"><strong>Lysbordet er tomt</strong><p>Importér et billede for at sammenligne originalen med en fremkaldelse.</p></div>`;
  const label = preview ? 'Prøvetoning' : 'Redigeret';
  const group = asset.tags?.[0];
  const caption = [group, effectiveMetadata(asset).date && dateDisplay(effectiveMetadata(asset).date)].filter(Boolean).join(' · ');
  return `<header class="spotlight-head"><h2>${ico('compare')} Lysbord</h2>${button('editor','Åbn i Fremkald','arrow','compact subtle',asset.id)}</header>
    <div id="compare-hero" class="compare-hero" style="--split:${state.split}%">
      <canvas class="original" aria-label="Originalbillede"></canvas><canvas class="graded" aria-label="${label}"></canvas>
      <div class="hero-shade"></div><span class="hero-tag before">Original</span><span class="hero-tag after">${label}</span>
      <span class="compare-line"></span><span class="compare-knob" aria-hidden="true">‹ ›</span>
      <div class="hero-caption"><strong class="spotlight-title">${escape(titleOf(asset))}</strong>${caption ? `<span class="spotlight-meta">${escape(caption)}</span>` : ''}</div>
      <input id="compare-slider" type="range" min="0" max="100" value="${state.split}" aria-label="Sammenlign original og ${label.toLowerCase()}">
    </div>`;
}

async function paintSpotlight(hero, asset, after) {
  const original = hero.querySelector('.original');
  const graded = hero.querySelector('.graded');
  try {
    const source = await getFile(asset);
    if (!source) throw new Error();
    if (!hero.isConnected) return;
    const options = { maxSize:1000 };
    await Promise.all([drawPhoto(original,source,defaultEdits,options),drawPhoto(graded,source,after,options)]);
  } catch {
    if (hero.isConnected) hero.innerHTML = `<div class="empty">${ico('photo')}<strong>${escape(titleOf(asset))}</strong><p>Ingen forhåndsvisning til dette filformat.</p></div>`;
  }
}

function refreshProjectOverview() {
  const card = $('spotlight-card');
  if (!card) return;
  const active = activeAssets();
  $('project-photo-count').textContent = active.length.toLocaleString('da-DK');
  $('project-favorite-count').textContent = active.filter(a => a.favorite).length.toLocaleString('da-DK');
  $('project-album-count').textContent = project.albums.length.toLocaleString('da-DK');
  const asset = selectedAsset();
  const key = asset?.id || '';
  if (card.dataset.asset === key) return;
  card.dataset.asset = key;
  const edits = getEdits(asset);
  const preview = Object.keys(defaultEdits).every(key => edits[key] === defaultEdits[key]);
  card.innerHTML = spotlightMarkup(asset,preview);
  if (asset) {
    const after = preview ? { ...edits, temperature:24, contrast:21, saturation:18, shadows:12 } : edits;
    void paintSpotlight($('compare-hero'),asset,after);
  }
}

function overviewMarkup() {
  const stat = (action, key, label, icon, countId) =>
    `<button type="button" class="project-stat" data-action="${action}" data-id="${key}">${ico(icon)}<span>${label}</span><strong id="${countId}"></strong>${ico('arrow')}</button>`;
  return `<section class="feature studio-overview" aria-label="Lysbord og projektoversigt">
    <div class="spotlight-card" id="spotlight-card"></div>
    <aside class="feature-panel project-panel">
      <div class="project-panel-head">${ico('folder')}<h2>Projektoversigt</h2></div><p class="project-name">${escape(project.name)}</p>
      <div class="project-stats">
        ${stat('show-catalog','','Billeder','library','project-photo-count')}
        ${stat('album','favorites','Favoritter','favorite','project-favorite-count')}
        ${stat('browse-albums','','Album','folder','project-album-count')}
      </div>
    </aside></section>`;
}

function renderLibrary() {
  const current = project.albums.find(row => row.id === state.album);
  const home = state.route === 'library' && !state.album;
  const name = home ? 'Fotobibliotek' : state.album === 'favorites' ? 'Favoritter' : current?.name || routes[state.route];
  const note = current?.query ? `Smart album · ${current.query}` : state.route === 'trash' ? 'Gendan eller slet billeder permanent.' : state.route === 'duplicates' ? 'Importerede filer med identisk indhold.' : '';
  const viewButton = (key,label,icon) => `<button type="button" data-action="catalog-view" data-id="${key}" aria-label="${label}" title="${label}">${ico(icon)}</button>`;
  main.innerHTML = `<div class="page library-page"><header class="page-title library-heading"><div>
      <h1>${escape(name)}</h1>${note ? `<p>${escape(note)}</p>` : ''}</div>
      ${home ? button('import-folder','Importér mappe','folder','subtle') : ''}</header>
    <div id="import-progress">${progressMarkup()}</div>${home ? overviewMarkup() : ''}
    <section class="catalog-panel" aria-labelledby="catalog-title">
      <header class="section-head catalog-head"><div class="row"><h2 id="catalog-title">${home ? 'Alle billeder' : 'Billeder'}</h2><span id="catalog-count"></span></div>
        <div class="catalog-actions">${state.route === 'library' ? button('smart-album','Smart album','plus','compact subtle') : ''}</div></header>
      <div class="catalog-toolbar"><label class="search">${ico('search')}<input id="query" value="${escape(state.query)}" placeholder="Søg efter navn, dato eller sted" aria-label="Søg i billeder"></label>
        <select id="sort" aria-label="Sortér billeder"><option value="import">Importrækkefølge</option><option value="date">Optagelsesdato</option><option value="name">Filnavn</option><option value="rating">Bedømmelse</option></select>
        <div class="view-switch" role="group" aria-label="Billedvisning">${viewButton('grid','Gittervisning','grid-view')}${viewButton('list','Listevisning','list-view')}</div></div>
      <div class="row" id="selection"></div><div id="library-results"></div>
    </section></div>`;
  $('sort').value = state.sort;
  renderCards();
}

function displayMetadata(key, value) {
  if (value === undefined || value === null || value === '') return 'Ukendt';
  if (key === 'gps') return value?.lat === undefined ? 'Ukendt' : `${Number(value.lat).toFixed(5)}, ${Number(value.lng).toFixed(5)}`;
  if (key === 'shutter') return value < 1 && Number(value) > 0 ? `1/${Math.round(1 / value)} s` : `${value} s`;
  if (key === 'aperture') return `f/${value}`;
  if (key === 'focalLength') return `${value} mm`;
  return String(value);
}

function panelMarkup(asset) {
  const edits = getEdits(asset);
  const meta = effectiveMetadata(asset);
  meta.dimensions = meta.width && meta.height ? `${meta.width} × ${meta.height}` : undefined;
  let content = '';
  if (state.tab === 'info') {
    const metadataGroup = (title, icon, keys) => `<section class="inspector-section"><h3>${ico(icon)} ${title}</h3><dl class="metadata">
      ${keys.map(key => {
        const value = meta[key];
        const source = Object.hasOwn(asset.overrides || {}, key) ? 'Manuel' : asset.demoUrl ? 'Eksempel' : 'Fil';
        const known = value !== undefined && value !== null && value !== '';
        return `<div class="metadata-row"><dt>${metadataNames[key]}</dt><dd>${escape(displayMetadata(key,value))}${known ? ` <small>${source}</small>` : ''}</dd></div>`;
      }).join('')}</dl></section>`;
    content = metadataGroup('Tid og sted','capture-date',['date','timezone','location','gps']) +
      metadataGroup('Kamera og billede','photo',['camera','lens','aperture','shutter','iso','focalLength','dimensions']) +
      `<div class="stack">${button('metadata','Ret optagelsesinfo',null,'compact')}${button('trash-move','Flyt til papirkurv','trash','compact subtle')}</div>`;
  } else if (state.tab === 'versions') {
    content = `<section class="inspector-section"><h3>${ico('history')} Versionshistorik</h3><div class="stack">${[...asset.versions].reverse().map(v =>
      `<button class="btn compact version-row ${v.id === asset.versionId ? 'tinted' : ''}" type="button" data-action="version-select" data-id="${escape(v.id)}" aria-pressed="${v.id === asset.versionId}"><span>${escape(v.name)}</span><small>${escape(dateDisplay(v.date))}</small></button>`).join('')}</div></section>
      <div class="stack">${button('version-save','Gem som version','plus','compact')}${button('batch','Redigér serie','create','compact')}</div>`;
  } else {
    const groups = [
      ['Lys og tone', 'light', ['exposure','contrast','highlights','shadows']],
      ['Farve', 'sliders', ['temperature','saturation']],
      ['Detaljer', 'develop', ['sharpness','rotation']]
    ];
    const basic = ['exposure','contrast','temperature','saturation'];
    const light = edits.light || { x:.5,y:.5,strength:0,warmth:0,softness:60,radius:.35 };
    const sections = groups.map(([title,icon,keys]) => {
      const rules = controlList.filter(([key]) => keys.includes(key) && (state.studio || basic.includes(key)));
      return rules.length ? `<section class="inspector-section"><h3>${ico(icon)} ${title}</h3>${rules.map(rule => control(rule,edits[rule[0]])).join('')}</section>` : '';
    }).join('');
    content = `${state.studio ? '<section class="inspector-section histogram-section"><h3>Histogram</h3><canvas class="hist" id="hist" width="230" height="66" aria-label="RGB-histogram"></canvas></section>' : ''}
      ${sections}${state.studio || state.route === 'retouch' ? `<details class="inspector-section light-controls" ${state.route === 'retouch' ? 'open' : ''}><summary>${ico('light')} Virtuel lyskilde</summary><p class="status">Klik på billedet for at placere lyset.</p>${control(['light.strength','Styrke'],light.strength)}${control(['light.warmth','Farvetemperatur'],light.warmth)}${control(['light.softness','Blødhed',0],light.softness)}${control(['light.radius','Rækkevidde',5],Math.round(light.radius * 100))}</details>` : ''}
      <div class="row">${button('reset-edit','Nulstil',null,'compact subtle')}${button('version-save','Gem version','plus','compact')}</div><hr><label class="field">Bedømmelse<select id="rating" aria-label="Bedømmelse">${[0,1,2,3,4,5].map(i => `<option value="${i}" ${i === (asset.rating || 0) ? 'selected' : ''}>${i ? `${i} ${i === 1 ? 'stjerne' : 'stjerner'}` : 'Ingen bedømmelse'}</option>`).join('')}</select></label>`;
  }
  return `<div class="panel-tabs" aria-label="Egenskaber">${[['adjust','Justeringer'],['versions','Versioner'],['info','Optagelsesinfo']].map(([key,name]) => `<button type="button" class="${state.tab === key ? 'active' : ''}" data-action="editor-tab" data-id="${key}" aria-pressed="${state.tab === key}">${name}</button>`).join('')}</div>${content}`;
}

function control([key,label,min = -100,max = 100], value = 0) {
  return `<label class="control" for="adjust-${key}"><span>${label}<output for="adjust-${key}" aria-hidden="true">${Number(value || 0)}</output></span><input id="adjust-${key}" data-edit="${key}" aria-label="${label}" type="range" min="${min}" max="${max}" value="${Number(value || 0)}"></label>`;
}

function renderEditor() {
  const asset = selectedAsset();
  if (!asset || asset.trashed) { main.innerHTML = `<div class="page"><div class="empty"><h2>${routes[state.route]}</h2><p>Vælg et aktivt billede i biblioteket.</p>${button('route','Åbn bibliotek','library','primary','library')}</div></div>`; return; }
  state.active = asset.id;
  const assets = activeAssets();
  const index = assets.findIndex(a => a.id === asset.id);
  const start = Math.max(0, index - 35);
  main.innerHTML = `<div class="editor"><div class="editor-bar"><div class="row">${button('route','Bibliotek','back','compact subtle','library')}<strong class="filename" title="${escape(asset.name)}">${escape(titleOf(asset))}</strong></div><div class="row">${button('mode-simple',state.studio ? 'Enkel visning' : 'Studievisning','sliders','compact subtle')}<button type="button" class="btn compact" id="hold-original" aria-label="Hold for at se original">${ico('compare')} Original</button>${state.studio ? `<button type="button" class="btn compact" data-action="clip" aria-pressed="${state.clipping}">Klipning</button><button type="button" class="btn compact" data-action="neutral" aria-pressed="${state.neutral}">Baggrund</button>` : ''}${button('export','Eksportér','export','compact primary')}</div></div>
    <div class="edit-stage${state.neutral ? ' neutral' : ''}" id="edit-stage"><div class="stage-image" id="stage-image"><canvas id="edit-canvas" tabindex="0" aria-label="Forhåndsvisning af ${escape(titleOf(asset))}"></canvas><span class="light-point" id="light-point" hidden></span></div><div class="stage-badge" id="stage-badge" role="status">Åbner billede …</div></div><aside class="inspector" id="inspector" aria-label="Billedegenskaber">${panelMarkup(asset)}</aside>
    <div class="filmstrip" aria-label="Filmstrimmel"><span class="filmstrip-label">Filmstrimmel <strong>${index + 1} / ${assets.length}</strong></span>${assets.slice(start,start + 75).map(row => `<button type="button" class="film${row.id === asset.id ? ' active' : ''}" data-action="editor-asset" data-id="${escape(row.id)}" data-thumb="${escape(row.id)}" aria-label="Åbn ${escape(titleOf(row))}" title="${escape(titleOf(row))}">${ico('photo')}</button>`).join('')}</div></div>`;
  loadThumbs();
  const hold = $('hold-original');
  hold.onpointerdown = event => { hold.setPointerCapture(event.pointerId); original(true); };
  hold.onpointerup = hold.onpointercancel = hold.onlostpointercapture = () => original(false);
  hold.onkeydown = event => { if ([' ','Enter'].includes(event.key)) { event.preventDefault(); original(true); } };
  hold.onkeyup = event => { if ([' ','Enter'].includes(event.key)) { event.preventDefault(); original(false); } };
  hold.onblur = () => original(false);
  const canvas = $('edit-canvas');
  canvas.onpointerdown = event => {
    if (state.route !== 'retouch' && !main.querySelector('.light-controls[open]')) return;
    canvas.setPointerCapture(event.pointerId);
    moveLight(event);
  };
  canvas.onpointermove = event => { if (canvas.hasPointerCapture(event.pointerId)) moveLight(event); };
  canvas.onkeydown = event => {
    if (state.route !== 'retouch' || !['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    const light = getEdits(asset).light || {x:.5,y:.5,strength:25,radius:.35,softness:60};
    const [dx,dy] = ({ArrowLeft:[-.02,0],ArrowRight:[.02,0],ArrowUp:[0,-.02],ArrowDown:[0,.02]})[event.key];
    applyEdits(asset,{light:{...light,x:Math.max(0,Math.min(1,light.x + dx)),y:Math.max(0,Math.min(1,light.y + dy))}});
    scheduleDraw();
  };
  drawEditor();
}

function original(hold) {
  if (state.hold === hold) return;
  state.hold = hold;
  $('hold-original')?.setAttribute('aria-pressed',String(hold));
  scheduleDraw();
}

function moveLight(event) {
  const asset = selectedAsset();
  const bounds = event.currentTarget.getBoundingClientRect();
  if (!bounds.width || !bounds.height) return;
  const light = getEdits(asset).light || {strength:25,warmth:0,softness:60,radius:.35};
  applyEdits(asset,{light:{...light,x:Math.max(0,Math.min(1,(event.clientX-bounds.left)/bounds.width)),y:Math.max(0,Math.min(1,(event.clientY-bounds.top)/bounds.height))}});
  scheduleDraw();
}

function scheduleDraw() {
  cancelAnimationFrame(frame);
  frame = requestAnimationFrame(drawEditor);
}

async function drawEditor() {
  const visible = $('edit-canvas');
  const asset = selectedAsset();
  if (!visible || !asset) return;
  const sequence = ++state.editSequence;
  const badge = $('stage-badge');
  const edits = state.hold ? defaultEdits : getEdits(asset);
  try {
    const source = await getFile(asset);
    if (!source) throw new Error('Originalfilen kunne ikke åbnes.');
    const scratch = document.createElement('canvas');
    await drawPhoto(scratch,source,edits,{maxSize:1300,clipping:!state.hold && state.clipping});
    if (sequence !== state.editSequence || !visible.isConnected) return;
    visible.width = scratch.width;
    visible.height = scratch.height;
    visible.getContext('2d').drawImage(scratch,0,0);
    badge.textContent = state.hold ? 'Original' : version(asset)?.name || 'Original';
    if ($('hist')) drawHistogram($('hist'), scratch);
    const point = $('light-point');
    const light = edits.light;
    point.hidden = !light || (!light.strength && state.route !== 'retouch');
    if (light) { point.style.left = `${light.x * 100}%`; point.style.top = `${light.y * 100}%`; }
  } catch (error) {
    if (sequence === state.editSequence && badge.isConnected) badge.textContent = `Kan ikke vise ${ext(asset.name).toUpperCase() || 'filen'} i denne browser`;
  }
}

function renderViewer() {
  const assets = activeAssets();
  const asset = selectedAsset();
  const escapeButton = button('route','Tilbage til bibliotek','back','subtle','library');
  const modes = [['album','Album','library'],['timeline','Tidslinje','capture-date'],['map','Kort','location']];
  const controls = `<div class="row">${modes.map(([key,label,icon]) => button('viewer-mode',label,icon,state.viewerMode === key ? 'tinted' : 'subtle',key)).join('')}</div>`;
  if (!asset || !assets.length) { main.innerHTML = `<div class="page"><div class="empty"><h2>Ingen billeder at vise</h2>${escapeButton}</div></div>`; return; }
  if (state.viewerMode === 'timeline' || state.viewerMode === 'map') {
    const groups = new Map();
    assets.toSorted((a,b) => String(effectiveMetadata(b).date || '').localeCompare(String(effectiveMetadata(a).date || ''))).forEach(row => {
      const month = effectiveMetadata(row).date?.slice(0,7) || 'Ukendt dato';
      if (!groups.has(month)) groups.set(month,[]);
      groups.get(month).push(row);
    });
    const located = assets.filter(row => effectiveMetadata(row).gps?.lat !== undefined);
    main.innerHTML = `<div class="page"><div class="page-title"><div><h1>Fremviser</h1></div>${controls}</div>${state.viewerMode === 'timeline' ? `<div class="timeline">${[...groups].map(([month,rows]) => `<section><h3>${escape(month)}</h3><div class="grid">${rows.map(photoCard).join('')}</div></section>`).join('')}</div>` : `<div class="map-list">${located.length ? located.map(row => {
      const {lat,lng} = effectiveMetadata(row).gps;
      return `<a href="https://www.openstreetmap.org/?mlat=${encodeURIComponent(lat)}&mlon=${encodeURIComponent(lng)}#map=14/${encodeURIComponent(lat)}/${encodeURIComponent(lng)}" rel="noopener noreferrer" target="_blank"><strong>${escape(titleOf(row))}</strong><span>${escape(displayMetadata('gps',{lat,lng}))} ↗</span></a>`;
    }).join('') : '<p class="empty">Ingen billeder med GPS-oplysninger.</p>'}</div>`}</div>`;
    loadThumbs();
    return;
  }
  const ii = assets.findIndex(a => a.id === asset.id);
  main.innerHTML = `<div class="viewer" id="viewer-panel"><div class="row" style="justify-content:space-between"><div class="row">${escapeButton}<strong>${escape(titleOf(asset))}</strong><span class="status">${ii + 1} / ${assets.length}</span></div>${controls}</div>
    <div class="viewer-images"><div class="viewer-image"><canvas id="viewer-first" aria-label="Valgt billedversion"></canvas></div>${state.comparing ? '<div class="viewer-image"><canvas id="viewer-second" aria-label="Sammenligningsbillede"></canvas></div>' : ''}</div>
    <div class="row"><button class="btn" data-action="viewer-prev" aria-label="Forrige billede" ${ii <= 0 ? 'disabled' : ''}>${ico('back')}</button><button class="btn" data-action="viewer-next" aria-label="Næste billede" ${ii + 1 === assets.length ? 'disabled' : ''}>${ico('arrow')}</button>${button('viewer-compare',state.comparing ? 'Luk sammenligning' : 'Sammenlign','compare','subtle')}${state.comparing ? `<select id="viewer-comparison" aria-label="Sammenlign med"><option value="original">Original</option>${assets.filter(row => row.id !== asset.id).map(row => `<option value="${escape(row.id)}">${escape(titleOf(row))}</option>`).join('')}</select>` : ''}<label class="check">Zoom <input id="viewer-zoom" type="range" min="100" max="300" step="5" value="${state.zoom}"><output id="viewer-zoom-label">${state.zoom}%</output></label>${button('fullscreen','Fuld skærm',null,'subtle')}<span id="viewer-status" class="status" role="status"></span></div></div>`;
  $('viewer-zoom').parentElement.querySelector('input').style.width = '105px';
  updateZoom();
  void drawViewer();
}

function updateZoom() {
  if (!$('viewer-zoom-label')) return;
  $('viewer-zoom-label').textContent = `${state.zoom}%`;
  main.querySelectorAll('.viewer canvas').forEach(canvas => { canvas.style.transform = `scale(${state.zoom / 100})`; });
}

async function drawViewer() {
  const a = selectedAsset();
  const mainCanvas = $('viewer-first');
  if (!a || !mainCanvas) return;
  const sequence = ++state.viewerSequence;
  const value = $('viewer-comparison')?.value;
  const b = assetBy(value) || a;
  try {
    const draw = async (canvas, asset, edits) => {
      if (!canvas) return;
      const scratch = document.createElement('canvas');
      await drawPhoto(scratch,await getFile(asset),edits,{maxSize:1700});
      if (sequence !== state.viewerSequence || !canvas.isConnected) return;
      canvas.width = scratch.width;
      canvas.height = scratch.height;
      canvas.getContext('2d').drawImage(scratch,0,0);
    };
    await Promise.all([draw(mainCanvas,a,getEdits(a)),draw($('viewer-second'),b,value === 'original' ? defaultEdits : getEdits(b))]);
  } catch (error) { if ($('viewer-status')) $('viewer-status').textContent = error.message || 'Billedet kan ikke vises i browseren.'; }
}

function renderSettings() {
  const prefs = project.preferences || {};
  main.innerHTML = `<div class="page"><div class="page-title"><div><h1>Projektindstillinger</h1><p>Styr backup, projektnavn og hukommelse.</p></div></div><div class="settings-grid"><section class="settings-card stack"><h2>Projekt</h2><label class="field">Projektnavn<input id="project-name" type="text" value="${escape(project.name)}" maxlength="80"></label><p class="status">En backup indeholder originaler, optagelsesinfo og redigeringshistorik.</p><div class="row">${button('backup','Hent backup','export','tinted')}${button('project','Åbn andet projekt','folder')}${installPrompt ? button('install','Installér app',null) : ''}</div></section><section class="settings-card stack"><h2>Hukommelse</h2><label class="check"><input type="checkbox" id="memory-enabled" ${prefs.enabled ? 'checked' : ''}> Husk mine præferencer</label><label class="field">Dette projekts præferencer<textarea id="memory-project" rows="3" maxlength="1000" placeholder="F.eks. kølige skygger">${escape(prefs.project)}</textarea></label><label class="field">Generelle præferencer<textarea id="memory-general" rows="3" maxlength="1000" placeholder="F.eks. JPEG til web">${escape(prefs.general)}</textarea></label><p class="status">Hukommelsen vises ved udarbejdelse af et forslag. Du kan fjerne den her.</p></section></div></div>`;
}

function render() {
  state.hold = false;
  renderFrame();
  clearThumbs();
  if (['library','trash','duplicates'].includes(state.route)) { renderLibrary(); return; }
  if (['develop','retouch'].includes(state.route)) { renderEditor(); return; }
  if (state.route === 'viewer') { renderViewer(); return; }
  if (state.route === 'settings') { renderSettings(); return; }
  const creative = document.createElement('div');
  creative.className = 'page';
  main.replaceChildren(creative);
  import('./creative.js').then(({renderCreative}) => {
    if (!creative.isConnected) return;
    return renderCreative(creative,state.route,{project,activeAsset:selectedAsset(),icon:ico,getFile,showEditor,persist,notify,drawPhoto,exportPhoto,defaultEdits,getEdits,saveVersion:versionSave});
  }).catch(error => { if (creative.isConnected) { creative.textContent = 'Arbejdsrummet kunne ikke åbnes.'; reportError(error); } });
}

function showDialog(title, content, onSubmit, ok = 'Gem', options = {}) {
  if (dialog.open) dialog.close();
  dialog.innerHTML = `<div class="dialog-header"><h2 id="dialog-title">${escape(title)}</h2><button type="button" class="icon-btn" data-action="close-dialog" aria-label="Luk">${ico('close')}</button></div><form class="dialog-body">${content}<p class="status error" id="dialog-status" role="status"></p><div class="dialog-actions">${button('close-dialog','Luk',null,'subtle')}${onSubmit ? `<button type="submit" class="btn ${options.danger ? 'danger' : 'primary'}">${escape(ok)}</button>` : ''}</div></form>`;
  const form = dialog.querySelector('form');
  form.onsubmit = async event => {
    event.preventDefault();
    if (!onSubmit || form.dataset.busy) return;
    const submit = form.querySelector('button[type=submit]');
    submit.disabled = true;
    form.dataset.busy = 'true';
    try {
      const close = await onSubmit(new FormData(form));
      if (close !== false && form.isConnected) dialog.close();
    } catch (error) {
      if (form.isConnected) $('dialog-status').textContent = error.message || 'Handlingen kunne ikke gennemføres.';
    } finally {
      submit.disabled = false;
      delete form.dataset.busy;
    }
  };
  dialog.showModal();
}

function confirmWith(title, details, ok, action, danger = false) {
  showDialog(title, `<p>${escape(details)}</p>`, action, ok, {danger});
}

function inputDialog(title, label, value, onSubmit, ok = 'Gem') {
  showDialog(title, `<label class="field">${escape(label)}<input type="text" name="value" value="${escape(value)}" maxlength="100" required autofocus></label>`, (form) => {
    const value = String(form.get('value')).trim();
    if (!value) throw new Error('Angiv et navn eller en værdi.');
    return onSubmit(value);
  },ok);
}

async function importFiles(files) {
  if (state.importing?.running || state.importing?.paused) { notify('Afslut eller genoptag den aktive import først.'); return; }
  const work = [...files].filter(file => file.type.startsWith('image/') || pickable.has(ext(file.name)));
  if (!work.length) { notify('Der er ingen understøttede billedfiler i dit valg.'); return; }
  state.importing = { files:work, total:work.length, done:0, failed:0, skipped:0, errors:[], running:true, paused:false };
  await runImport();
}

function updateProgress(refresh = false) {
  if ($('import-progress')) $('import-progress').innerHTML = progressMarkup();
  if (refresh && $('library-results')) { renderCards(); renderFrame(); }
}

async function runImport() {
  const job = state.importing;
  if (!job) return;
  job.running = true;
  job.paused = false;
  const existingPairs = new Set(project.assets.filter(a => a.hash).map(a => `${a.hash}\0${a.sourcePath || a.name}`));
  const seen = new Map();
  project.assets.filter(a => a.hash).forEach(a => { if (!seen.has(a.hash)) seen.set(a.hash,a.id); });
  const pending = [];
  let refreshedAt = performance.now();

  function recordFailure(name, error) {
    job.failed++;
    job.errors.push(`${name}: ${error.message || 'Kunne ikke gemmes'}`);
  }

  async function saveEntries(entries) {
    await write(async () => {
      const start = project.assets.length;
      const batchHashes = new Map();
      for (const { row } of entries) {
        row.duplicateOf = seen.get(row.hash) || batchHashes.get(row.hash) || null;
        if (!batchHashes.has(row.hash)) batchHashes.set(row.hash,row.id);
        project.assets.push(row);
      }
      try { await storage.saveWithFiles(project,entries); }
      catch (error) { project.assets.splice(start,entries.length); throw error; }
    });
    for (const { row, pair } of entries) {
      if (!seen.has(row.hash)) seen.set(row.hash,row.id);
      existingPairs.add(pair);
    }
  }

  async function flush() {
    if (!pending.length) return;
    const entries = pending.splice(0);
    try { await saveEntries(entries); }
    catch (error) {
      if (entries.length === 1) {
        recordFailure(entries[0].row.name,error);
        return;
      }
      for (const entry of entries) {
        try { await saveEntries([entry]); }
        catch (fileError) { recordFailure(entry.row.name,fileError); }
      }
    }
  }

  updateProgress();
  while (!job.paused && job.done < job.total) {
    const file = job.files[job.done];
    const sourcePath = file.webkitRelativePath || file.name;
    try {
      const hash = await storage.fingerprint(file);
      const pair = `${hash}\0${sourcePath}`;
      if (pending.some(entry => entry.pair === pair)) await flush();
      if (existingPairs.has(pair)) job.skipped++;
      else {
        const metadata = await storage.readMetadata(file);
        const first = {id:id(),name:'Original',date:time(),edits:{...defaultEdits}};
        const row = { id:id(),name:file.name,type:file.type || 'application/octet-stream',size:file.size,sourcePath,hash,metadata,overrides:{},versions:[first],versionId:first.id,createdAt:time(),favorite:false,rating:0,tags:[],trashed:false,duplicateOf:null };
        pending.push({ id:row.id, blob:file, pair, row });
      }
    } catch (error) {
      recordFailure(file.name,error);
    }
    job.done++;
    const refresh = job.done === 1 || performance.now() - refreshedAt >= 200;
    if (refresh || pending.length >= 12) await flush();
    if (refresh) { updateProgress(true); refreshedAt = performance.now(); }
  }
  await flush();
  job.running = false;
  if (job.done >= job.total) {
    job.paused = false;
    job.files = [];
    notify(`${job.done - job.failed - job.skipped} nye billeder importeret${job.skipped ? ` · ${job.skipped} allerede gemt` : ''}${job.failed ? ` · ${job.failed} fejl` : ''}.`);
  }
  updateProgress(true);
}

function metadataDialog(asset) {
  const m = effectiveMetadata(asset);
  showDialog('Ret optagelsesinfo', `<p>Udfyld de felter, du vil ændre. Originalfilen bevares.</p>${[['date','Optagelsestidspunkt (ISO)'],['timezone','Tidszone'],['camera','Kamera'],['lens','Objektiv'],['location','Sted']].map(([key,label]) => `<label class="field">${label}<input name="${key}" type="text" value="${escape(m[key])}" maxlength="120"></label>`).join('')}<div class="row"><label class="field">Breddegrad<input type="number" step="any" min="-90" max="90" name="lat" value="${escape(m.gps?.lat)}"></label><label class="field">Længdegrad<input type="number" step="any" min="-180" max="180" name="lng" value="${escape(m.gps?.lng)}"></label></div><label class="field">Emneord<input name="tags" type="text" value="${escape((asset.tags || []).join(', '))}" maxlength="250"></label>`, async form => {
    const overrides = {...asset.overrides};
    for (const key of ['date','timezone','camera','lens','location']) {
      const value = String(form.get(key)).trim();
      if (key === 'date' && value && value !== String(m[key] || '') && Number.isNaN(Date.parse(value))) throw new Error('Brug f.eks. 2025-06-20T14:30:00.');
      if (value !== String(m[key] || '')) overrides[key] = value;
    }
    const lat = form.get('lat');
    const lng = form.get('lng');
    if (Boolean(lat) !== Boolean(lng)) throw new Error('GPS kræver både breddegrad og længdegrad.');
    if (String(m.gps?.lat ?? '') !== lat || String(m.gps?.lng ?? '') !== lng) overrides.gps = lat && lng ? {lat:Number(lat),lng:Number(lng)} : null;
    asset.overrides = overrides;
    asset.tags = String(form.get('tags')).split(',').map(value => value.trim()).filter(Boolean);
    await persist();
    renderEditor();
  });
}

function exportDialog(asset) {
  const meta = effectiveMetadata(asset);
  const size = meta.width > 0 && meta.height > 0 ? ` · ${escape(meta.width)} × ${escape(meta.height)} px` : '';
  showDialog('Eksportér billede', `<p>${escape(asset.name)} · ${escape(version(asset)?.name)}${size}</p><label class="field">Format<select name="format" id="export-format"><option value="image/jpeg">JPEG</option><option value="image/png">PNG</option><option value="image/webp">WebP</option></select></label><p class="status">Opløsning: originalens pixelmål før rotation og beskæring. Standardfarverum: sRGB.</p><label class="field">Kvalitet<select name="quality"><option value=".94">Høj · 94%</option><option value=".85">Standard · 85%</option><option value=".72">Kompakt · 72%</option></select></label><div id="metadata-options" class="stack"><label class="check"><input type="checkbox" name="metadata"> Behold tilgængelige optagelsesdata i JPEG</label>${meta.gps ? '<label class="check"><input type="checkbox" name="gps"> Medtag GPS-position</label>' : ''}</div>`, async form => {
    const format = form.get('format');
    $('dialog-status').textContent = 'Behandler billedet …';
    const blob = await exportPhoto(await getFile(asset), getEdits(asset), {format,quality:Number(form.get('quality')),metadata:meta,includeMetadata:format === 'image/jpeg' && form.has('metadata'),includeGps:format === 'image/jpeg' && form.has('gps')});
    const suffix = format === 'image/jpeg' ? 'jpg' : format.split('/')[1];
    userDownload(blob, `${asset.name.replace(/\.[^.]*$/,'')}-bisfoto.${suffix}`);
    notify('Billedet er eksporteret.');
  },'Eksportér');
  $('export-format').onchange = event => { $('metadata-options').hidden = event.target.value !== 'image/jpeg'; };
}

function batchDialog() {
  const assets = [...state.selected].map(assetBy).filter(a => a && !a.trashed);
  const targets = assets.length ? assets : [selectedAsset()].filter(a => a && !a.trashed);
  if (!targets.length) { notify('Vælg billeder i biblioteket først.'); return; }
  const recipe = { exposure:0 };
  const prefs = project.preferences;
  showDialog('Redigér serie', `<p>Gennemgå en prøve, og vælg hvilke billeder der skal have ændringen.</p><label class="field">Ændring<select name="adjustment"><option value="exposure">Eksponering</option><option value="contrast">Kontrast</option><option value="temperature">Temperatur</option><option value="saturation">Mætning</option></select></label><label class="field">Styrke<input name="amount" type="range" min="-75" max="75" value="0"></label><div class="batch-preview"><figure><canvas id="batch-before"></canvas><figcaption>Før</figcaption></figure><figure><canvas id="batch-after"></canvas><figcaption>Efter</figcaption></figure></div><div class="scroll-list">${targets.map(a => `<label class="check"><input type="checkbox" name="target" value="${escape(a.id)}" checked> ${escape(titleOf(a))}</label>`).join('')}</div>${prefs?.enabled && (prefs.project || prefs.general) ? `<p class="status">Gemte præferencer: ${escape([prefs.project,prefs.general].filter(Boolean).join(' · '))}</p>` : ''}`, async form => {
    const checked = form.getAll('target');
    if (!checked.length) throw new Error('Vælg mindst ét billede.');
    const amount = Number(form.get('amount'));
    if (!amount) throw new Error('Vælg en styrke for ændringen.');
    const previous = checked.map(assetBy).filter(Boolean).map(asset => {
      const prior = asset.versionId;
      const next = {id:id(),name:'Serieredigering',date:time(),edits:{...getEdits(asset),[form.get('adjustment')]:amount}};
      asset.versions.push(next);
      asset.versionId = next.id;
      return {asset:asset.id,prior,applied:next.id};
    });
    project.batchHistory ||= [];
    project.batchHistory.push({date:time(),previous});
    await persist();
    notify(`Serieredigering anvendt på ${previous.length} billeder.`);
    render();
  },'Godkend ændring');
  const form = dialog.querySelector('form');
  const before = $('batch-before');
  const after = $('batch-after');
  const initial = getEdits(targets[0]);
  let seq = 0;
  const update = async () => {
    const current = ++seq;
    const data = new FormData(form);
    const key = data.get('adjustment');
    recipe[key] = Number(data.get('amount'));
    const scratch = document.createElement('canvas');
    try {
      await drawPhoto(scratch,await getFile(targets[0]),{...initial,[key]:recipe[key]},{maxSize:360});
      if (current !== seq || !after.isConnected) return;
      after.width = scratch.width;
      after.height = scratch.height;
      after.getContext('2d').drawImage(scratch,0,0);
    } catch { /* File decoding can be unavailable for imported RAW files. */ }
  };
  Promise.resolve(getFile(targets[0])).then(source => drawPhoto(before,source,initial,{maxSize:360})).catch(() => {});
  form.addEventListener('input',update);
  void update();
}

function undoBatch() {
  const row = project.batchHistory?.at(-1);
  if (!row) { notify('Der er ingen serieredigering at fortryde.'); return; }
  confirmWith('Fortryd serieredigering','Billeder, der stadig bruger seriens version, vender tilbage til deres forrige version.', 'Fortryd ændring', async () => {
    let count = 0;
    for (const {asset,prior,applied} of row.previous) {
      const a = assetBy(asset);
      if (a && a.versionId === applied) { a.versionId = prior; count++; }
    }
    project.batchHistory.pop();
    await persist();
    render();
    notify(`Serieredigering fortrudt for ${count} billeder.`);
  });
}

function ensureNotImporting() {
  if (state.importing?.running || state.importing?.paused) throw new Error('Afslut eller genoptag importen før du skifter projekt.');
}

function projectDialog() {
  showDialog('Åbn projekt', `<p>Åbn en projektbackup, eller opret et tomt fotoprojekt. Hent en backup, hvis du vil beholde det nuværende projekt.</p><div class="row">${button('backup','Hent aktuel backup','export')}${button('restore-browse','Vælg backup','folder','tinted')}${button('new-project','Nyt projekt','plus')}</div>`);
}

function dependenciesFor(asset) {
  const albums = project.albums.filter(album => !album.query && album.assetIds?.includes(asset.id)).map(album => album.name);
  const list = [...albums];
  if (project.creative?.design?.projects?.[asset.id]) list.push('Design');
  if (project.creative?.book?.spreads?.some(spread => spread.pages?.some(page => page.assetId === asset.id))) list.push('Fotobog');
  return list;
}

function withoutAsset(project, id) {
  const updated = structuredClone(project);
  updated.assets = updated.assets.filter(asset => asset.id !== id);
  for (const album of updated.albums) album.assetIds = (album.assetIds || []).filter(value => value !== id);
  const design = updated.creative?.design;
  if (design?.masterId === id) design.masterId = '';
  if (design?.projects) delete design.projects[id];
  for (const spread of updated.creative?.book?.spreads || []) {
    for (const page of spread.pages || []) if (page.assetId === id) page.assetId = '';
  }
  if (updated.creative?.recipes) updated.creative.recipes = updated.creative.recipes.filter(recipe => recipe.assetId !== id);
  for (const entry of updated.batchHistory || []) entry.previous = entry.previous.filter(item => item.asset !== id);
  return updated;
}

async function runAction(action,key,target) {
  const asset = assetBy(key) || selectedAsset();
  const by = state.active;
  switch (action) {
    case 'route': if (routes[key]) { if (project.assets.find(a => a.id === by)?.trashed) state.active = null; go(key); } break;
    case 'menu':
      state.menu = !state.menu;
      renderFrame();
      document.querySelector(state.menu ? '.nav-close' : '.menu-toggle')?.focus();
      break;
    case 'album':
      if (dialog.open) dialog.close();
      go('library',{album:key});
      break;
    case 'show-catalog':
      $('query')?.focus();
      break;
    case 'browse-albums': {
      const albums = project.albums.map(row => button('album',row.name,row.query ? 'search' : 'folder','subtle',row.id)).join('');
      showDialog('Album', `<div class="stack">${albums || '<p>Du har ingen album endnu.</p>'}${button('create-album','Nyt album','plus')}</div>`);
      break;
    }
    case 'catalog-view':
      if (key !== 'grid' && key !== 'list') break;
      project.catalogView = key;
      queueSave();
      renderCards();
      break;
    case 'import': $('import-files').click(); break;
    case 'import-folder': $('import-folder').click(); break;
    case 'project': projectDialog(); break;
    case 'backup': {
      await persist();
      const current = project;
      const blob = await storage.exportBackup(current);
      userDownload(blob, `${current.name.replace(/[<>:"/\\|?*]/g,'-')}.bisfoto`);
      notify('Projektbackup hentet.');
      break;
    }
    case 'restore-browse': ensureNotImporting(); dialog.close(); $('restore-file').click(); break;
    case 'new-project': ensureNotImporting(); confirmWith('Opret nyt projekt','Det nye projekt erstatter den aktive lokale katalogvisning. Hent en backup først, hvis du vil bevare den.', 'Opret projekt', async () => {
      const empty = makeProject(false);
      const backup = await storage.exportBackup(empty);
      await write(async () => { project = await storage.restoreBackup(backup); });
      state.active = null;
      state.importing = null;
      go('library');
    }); break;
    case 'editor': showEditor(asset); break;
    case 'editor-asset': state.active = key; clearThumbs(); renderEditor(); break;
    case 'more': state.page++; renderCards(); break;
    case 'favorite': if (asset) { asset.favorite = !asset.favorite; await persist(); renderFrame(); renderCards(); } break;
    case 'clear-selection': state.selected.clear(); renderCards(); break;
    case 'create-album': inputDialog('Nyt album','Albumnavn','',async name => {
      const item = {id:id(),name,assetIds:[...state.selected]};
      project.albums.push(item);
      await persist();
      go('library',{album:item.id});
    }); break;
    case 'smart-album': {
      const query = state.query.trim();
      if (!query) { notify('Søg efter billeder for at gemme søgningen som et smart album.'); $('query').focus(); break; }
      inputDialog('Smart album','Albumnavn',query,async name => {
        const item = {id:id(),name,query,assetIds:[]};
        project.albums.push(item);
        await persist();
        go('library',{album:item.id});
      });
      break;
    }
    case 'add-album': {
      const albums = project.albums.filter(row => !row.query);
      if (!albums.length) { runAction('create-album',''); break; }
      showDialog('Føj til album',`<label class="field">Album<select name="album">${albums.map(row => `<option value="${escape(row.id)}">${escape(row.name)}</option>`).join('')}</select></label>`,async data => {
        const album = albums.find(row => row.id === data.get('album'));
        album.assetIds = [...new Set([...album.assetIds,...state.selected])];
        await persist();
        notify(`Billeder føjet til ${album.name}.`);
      });
      break;
    }
    case 'remove-album': {
      const album = project.albums.find(row => row.id === state.album);
      if (!album || album.query) break;
      album.assetIds = album.assetIds.filter(key => !state.selected.has(key));
      state.selected.clear();
      await persist();
      renderCards();
      break;
    }
    case 'pause-import': if (state.importing) { state.importing.paused = true; target.disabled = true; } break;
    case 'resume-import': if (state.importing?.paused && !state.importing.running) await runImport(); break;
    case 'dismiss-import': state.importing = null; updateProgress(); break;
    case 'editor-tab': state.tab = key; $('inspector').innerHTML = panelMarkup(asset); if (key === 'adjust') scheduleDraw(); break;
    case 'mode-simple': state.studio = !state.studio; project.studio = state.studio; queueSave(); renderEditor(); break;
    case 'clip': state.clipping = !state.clipping; target.setAttribute('aria-pressed',String(state.clipping)); scheduleDraw(); break;
    case 'neutral': state.neutral = !state.neutral; target.setAttribute('aria-pressed',String(state.neutral)); $('edit-stage').classList.toggle('neutral',state.neutral); break;
    case 'reset-edit': {
      if (!asset) break;
      const editVersion = applyEdits(asset,structuredClone(defaultEdits));
      editVersion.edits = structuredClone(defaultEdits);
      renderEditor();
      break;
    }
    case 'version-save': if (asset) inputDialog('Gem billedversion','Versionsnavn','',async name => { await versionSave(asset,name); renderEditor(); notify('Billedversion gemt.'); }); break;
    case 'version-select': if (asset && asset.versions.some(v => v.id === key)) { asset.versionId = key; await persist(); renderEditor(); } break;
    case 'batch': batchDialog(); break;
    case 'undo-batch': undoBatch(); break;
    case 'metadata': if (asset) metadataDialog(asset); break;
    case 'export': if (asset) exportDialog(asset); break;
    case 'trash-move': if (asset) {
      const used = dependenciesFor(asset);
      confirmWith('Flyt til papirkurv',`${titleOf(asset)} fjernes fra biblioteket og kan gendannes.${used.length ? ` Bruges i ${used.join(', ')}.` : ''}`,'Flyt billede',async () => { asset.trashed = true; await persist(); state.active = null; go('trash'); },true);
    } break;
    case 'trash-photo': if (asset) showDialog('Billede i papirkurven',`<p>${escape(titleOf(asset))}</p><div class="row">${button('trash-restore','Gendan','back','tinted',key)}${button('trash-delete','Slet permanent','trash','danger',key)}</div>`); break;
    case 'trash-restore': if (asset) { asset.trashed = false; await persist(); dialog.close(); render(); notify('Billedet er gendannet.'); } break;
    case 'trash-delete': if (asset?.trashed) confirmWith('Slet permanent',`Slet ${titleOf(asset)} og dets versioner fra projektet?`, 'Slet permanent',async () => {
      await write(async () => {
        const updated = withoutAsset(project,asset.id);
        await storage.saveWithoutFile(updated,asset.id);
        project = updated;
      });
      render();
      notify('Billedet er slettet fra projektet.');
    },true); break;
    case 'viewer-mode': state.viewerMode = key; renderViewer(); break;
    case 'viewer-compare': state.comparing = !state.comparing; renderViewer(); break;
    case 'viewer-prev': case 'viewer-next': {
      const assets = activeAssets();
      const index = assets.findIndex(a => a.id === asset.id) + (action === 'viewer-next' ? 1 : -1);
      if (assets[index]) { state.active = assets[index].id; renderViewer(); }
      break;
    }
    case 'fullscreen': if (document.fullscreenElement) await document.exitFullscreen(); else await $('viewer-panel').requestFullscreen(); break;
    case 'close-dialog': dialog.close(); break;
    case 'install': if (installPrompt) { await installPrompt.prompt(); installPrompt = null; renderSettings(); } break;
  }
}

document.addEventListener('click', event => {
  const target = event.target.closest('[data-action]');
  if (!target || target.disabled || !project) return;
  void runAction(target.dataset.action,target.dataset.id || '',target).catch(reportError);
});

document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && state.menu && !dialog.open) {
    state.menu = false;
    renderFrame();
    document.querySelector('.menu-toggle')?.focus();
  }
});

document.addEventListener('input', event => {
  const el = event.target;
  if (!project) return;
  if (el.id === 'compare-slider') { state.split = Number(el.value); $('compare-hero').style.setProperty('--split',`${state.split}%`); }
  if (el.id === 'query') { state.query = el.value; state.page = 1; renderCards(); }
  if (el.id === 'viewer-zoom') { state.zoom = Number(el.value); updateZoom(); }
  if (el.id === 'project-name') { if (el.value.trim()) project.name = el.value.trim(); queueSave(); renderFrame(); }
  if (['memory-enabled','memory-project','memory-general'].includes(el.id)) {
    project.preferences ||= {};
    project.preferences[el.id.split('-')[1]] = el.type === 'checkbox' ? el.checked : el.value;
    queueSave();
  }
  if (el.dataset.edit) {
    const asset = selectedAsset();
    if (!asset) return;
    const [key, field] = el.dataset.edit.split('.');
    const value = Number(el.value);
    if (field) {
      const light = getEdits(asset).light || {x:.5,y:.5,strength:0,warmth:0,softness:60,radius:.35};
      applyEdits(asset,{light:{...light,[field]:field === 'radius' ? value / 100 : value}});
    } else applyEdits(asset,{[key]:value});
    el.parentElement.querySelector('output').value = value;
    scheduleDraw();
  }
});

document.addEventListener('change', event => {
  const el = event.target;
  if (!project) return;
  if (el.dataset.select) { if (el.checked) state.selected.add(el.dataset.select); else state.selected.delete(el.dataset.select); renderSelection(); }
  if (el.id === 'sort') { state.sort = el.value; state.page = 1; renderCards(); }
  if (el.id === 'rating') { const asset = selectedAsset(); if (asset) { asset.rating = Number(el.value); queueSave(); } }
  if (el.id === 'viewer-comparison') void drawViewer();
});

for (const name of ['import-files','import-folder']) $(name).onchange = event => {
  const files = Array.from(event.target.files || []);
  event.target.value = '';
  if (files.length) { if (state.route !== 'library' || state.album) go('library'); void importFiles(files).catch(reportError); }
};

$('restore-file').onchange = event => {
  const [file] = event.target.files;
  event.target.value = '';
  if (!file) return;
  confirmWith('Gendan projekt',`Gendan ${file.name}? Det erstatter det aktive lokale projekt.`, 'Gendan backup', async () => {
    ensureNotImporting();
    clearTimeout(saveTimer);
    await write(async () => { project = await storage.restoreBackup(file); });
    project.albums ||= [];
    state.active = null;
    state.importing = null;
    state.studio = project.studio ?? true;
    go('library');
    notify('Projekt gendannet med originaler og redigeringer.');
  });
};

main.addEventListener('dragover', event => { if (state.route === 'library' && event.dataTransfer.types.includes('Files')) event.preventDefault(); });
main.addEventListener('drop', event => {
  if (state.route !== 'library' || !event.dataTransfer?.files.length) return;
  event.preventDefault();
  void importFiles(event.dataTransfer.files).catch(reportError);
});

window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); installPrompt = event; if (state.route === 'settings') renderSettings(); });
window.addEventListener('pagehide', () => { if (saveTimer && project) void persist().catch(() => {}); });

async function start() {
  try {
    storage = await openStore();
    project = await storage.load();
    if (!project) { project = makeProject(); await persist(); }
    state.studio = project.studio ?? true;
    render();
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
  } catch (error) {
    main.innerHTML = `<div class="page"><div class="empty"><h2>Kunne ikke åbne BisFoto Editor</h2><p>${escape(error.message || 'Browserens lokale lager er ikke tilgængeligt.')}</p><button type="button" class="btn" id="startup-retry">Prøv igen</button></div></div>`;
    $('startup-retry').onclick = start;
  }
}

void start();
