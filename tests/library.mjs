import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = await import(process.env.LUMA_PLAYWRIGHT_MODULE || 'playwright');
const home = 'https://luma-library-test.invalid';
const siteDirectory = fileURLToPath(new URL('../dist/', import.meta.url));
const types = { '.html':'text/html', '.css':'text/css', '.js':'text/javascript', '.json':'application/json', '.webmanifest':'application/manifest+json', '.jpg':'image/jpeg', '.png':'image/png', '.svg':'image/svg+xml' };
const total = 1900;
const testPhoto = 'luma-qa-0000';
const browser = await chromium.launch({ channel:process.env.LUMA_BROWSER || 'msedge', headless:true });

try {
  const page = await browser.newPage({ offline:true, serviceWorkers:'block', viewport:{ width:1450, height:900 } });
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route(`${home}/**`, async route => {
    const urlPath = decodeURIComponent(new URL(route.request().url()).pathname);
    const filePath = resolve(siteDirectory, `.${urlPath === '/' ? '/index.html' : urlPath}`);
    if (!filePath.startsWith(`${resolve(siteDirectory)}${sep}`)) return route.abort();
    try {
      const body = await readFile(filePath);
      const contentType = types[extname(filePath)] || 'application/octet-stream';
      return await route.fulfill({ body, contentType });
    } catch {
      return route.fulfill({ status:404, body:'File missing' });
    }
  });

  await page.goto(home);
  await page.getByRole('heading', { name:'Fotobibliotek' }).waitFor();
  const started = Date.now();
  await page.evaluate(async ({ total, testPhoto }) => {
    const canvas = document.createElement('canvas');
    canvas.width = 24;
    canvas.height = 16;
    const context = canvas.getContext('2d');
    context.fillStyle = '#80432c';
    context.fillRect(0, 0, 24, 16);
    const jpeg = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg'));
    const files = new DataTransfer();
    for (let i = 0; i < total; i += 1) {
      const name = `luma-qa-${String(i).padStart(4, '0')}.jpg`;
      const suffix = Uint8Array.of(i >>> 8, i & 0xff);
      files.items.add(new File([jpeg, suffix], name, { type:'image/jpeg' }));
    }

    const observer = new MutationObserver(() => {
      const early = document.querySelector(`[aria-label="Åbn ${testPhoto}"]`);
      const pause = document.querySelector('[data-action="pause-import"]');
      if (!early || !pause) return;
      pause.click();
      observer.disconnect();
    });
    observer.observe(document.body, { childList:true, subtree:true });
    const input = document.querySelector('#import-files');
    input.files = files.files;
    input.dispatchEvent(new Event('change', { bubbles:true }));
  }, { total, testPhoto });

  await page.locator('[data-action="resume-import"]').waitFor();
  const pausedAt = await page.locator('#import-progress progress').evaluate(progress => progress.value);
  assert(pausedAt > 0 && pausedAt < total, `Import should pause before completion, paused at ${pausedAt}.`);
  await page.evaluate(testPhoto => {
    document.querySelector('[data-action="resume-import"]').click();
    document.querySelector(`[aria-label="Åbn ${testPhoto}"]`).click();
  }, testPhoto);
  await page.waitForFunction(() => {
    const canvas = document.querySelector('#edit-canvas');
    return canvas?.width === 24 && canvas.height === 16 && canvas.getContext('2d').getImageData(0, 0, 1, 1).data[3] === 255;
  });
  console.log(`OK · Importen sat på pause ved ${pausedAt}, genoptaget, og første billede åbnet.`);

  await page.locator('.editor-bar [data-id="library"]').click();
  await page.waitForFunction(total => document.querySelector('#import-progress progress')?.value === total, total, { timeout:180000 });
  assert(!(await page.locator('#import-progress').innerText()).includes('fejl'), 'Importen registrerede fejl.');
  assert(await page.getByText(/80 af 190[0-9]/).count(), 'Biblioteket viser ikke det fulde antal testbilleder.');
  console.log(`OK · ${total} testbilleder importeret på ${((Date.now() - started) / 1000).toFixed(1)} sekunder.`);

  const openPhoto = async (name = testPhoto) => {
    await page.locator('#query').fill(name);
    await page.getByRole('button', { name:`Åbn ${name}`, exact:true }).click();
    await page.locator('#edit-canvas').waitFor();
  };
  await openPhoto();
  await page.locator('input[data-edit="exposure"]').evaluate(slider => {
    slider.value = '40';
    slider.dispatchEvent(new Event('input', { bubbles:true }));
  });
  await page.locator('[data-action="editor-tab"][data-id="versions"]').click();
  await page.locator('[data-action="version-save"]').click();
  await page.getByLabel('Versionsnavn').fill('QA redigering');
  await page.getByRole('dialog').getByRole('button', { name:'Gem', exact:true }).click();
  await page.getByRole('button', { name:'QA redigering' }).waitFor();

  await page.locator('[data-action="editor-tab"][data-id="info"]').click();
  await page.locator('[data-action="trash-move"]').click();
  await page.getByRole('dialog').getByRole('button', { name:'Flyt billede' }).click();
  await page.getByRole('heading', { name:'Papirkurv' }).waitFor();
  await page.getByRole('button', { name:`Åbn ${testPhoto}`, exact:true }).click();
  await page.locator('[data-action="trash-restore"]').click();
  await page.getByText('Papirkurven er tom').waitFor();
  console.log('OK · Upload flyttet til papirkurv og gendannet.');

  await page.evaluate(() => {
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function captureTestDownload() {
      if (this.download.endsWith('.bisfoto')) window.lumaQaBackup = fetch(this.href).then(response => response.blob());
      else click.call(this);
    };
  });
  await page.locator('[data-action="project"]').first().click();
  await page.locator('[data-action="backup"]').click();
  await page.waitForFunction(() => Boolean(window.lumaQaBackup));
  const backupBytes = await page.evaluate(async () => (await window.lumaQaBackup).size);
  assert(backupBytes > total * 100, 'Backupfilen er for lille til at indeholde originalerne.');
  await page.locator('[data-action="new-project"]').click();
  await page.getByRole('dialog').getByRole('button', { name:'Opret projekt' }).click();
  await page.getByText('Ingen billeder i denne samling').waitFor();

  await page.evaluate(async () => {
    const files = new DataTransfer();
    files.items.add(new File([await window.lumaQaBackup], 'luma-qa.luma', { type:'application/x-luma-atelier' }));
    const input = document.querySelector('#restore-file');
    input.files = files.files;
    input.dispatchEvent(new Event('change', { bubbles:true }));
  });
  await page.getByRole('dialog').getByRole('button', { name:'Gendan backup' }).click();
  await page.getByText('Projekt gendannet med originaler og redigeringer.').waitFor();
  await page.reload();
  await openPhoto();
  await page.waitForFunction(() => document.querySelector('#edit-canvas')?.width === 24);
  await page.locator('[data-action="editor-tab"][data-id="versions"]').click();
  await page.getByRole('button', { name:'QA redigering' }).waitFor();
  assert.deepEqual(errors, [], 'Brugerforløbet udløste browserfejl.');
  console.log(`OK · Gendannede originalen og den gemte redigering efter genindlæsning fra en backup på ${backupBytes} byte.`);
} finally {
  await browser.close();
}
