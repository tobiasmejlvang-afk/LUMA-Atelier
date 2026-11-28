// The database name and file signature identify existing user projects and backups.
const databaseName = 'luma-atelier';
const projectKey = 'current';
const backupSignature = new TextEncoder().encode('LUMAAT1\n');
const backupHeaderSize = backupSignature.length + 4;
const maxManifestBytes = 64 * 1024 * 1024;
const maxMetadataBytes = 1024 * 1024;
const textDecoder = new TextDecoder();
const demoPath = /^\.\/assets\/demo-[1-9]\d*\.jpg$/;

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionResult(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error || new Error('Lagringen blev afbrudt.'));
  });
}

export async function openStore() {
  const request = indexedDB.open(databaseName, 1);
  request.onupgradeneeded = () => {
    request.result.createObjectStore('projects');
    request.result.createObjectStore('originals');
  };
  request.onblocked = () => window.dispatchEvent(new Event('luma-storage-blocked'));
  const database = await requestResult(request);
  database.onversionchange = () => database.close();

  async function write(storeNames, operations) {
    const transaction = database.transaction(storeNames, 'readwrite');
    const finished = transactionResult(transaction);
    try {
      operations(transaction);
    } catch (error) {
      transaction.abort();
      await finished.catch(() => {});
      throw error;
    }
    await finished;
  }

  return {
    async load() {
      const transaction = database.transaction('projects');
      const project = await requestResult(transaction.objectStore('projects').get(projectKey));
      return project ?? null;
    },

    async save(project) {
      await write('projects', transaction => transaction.objectStore('projects').put(project, projectKey));
    },

    async putFile(id, blob) {
      await write('originals', transaction => transaction.objectStore('originals').put(blob, id));
    },

    async saveWithFile(project, id, blob) {
      await this.saveWithFiles(project, [{ id, blob }]);
    },

    async saveWithFiles(project, entries) {
      await write(['projects', 'originals'], transaction => {
        const originals = transaction.objectStore('originals');
        for (const { id, blob } of entries) originals.put(blob, id);
        transaction.objectStore('projects').put(project, projectKey);
      });
    },

    async getFile(id) {
      const transaction = database.transaction('originals');
      return requestResult(transaction.objectStore('originals').get(id));
    },

    async deleteFile(id) {
      await write('originals', transaction => transaction.objectStore('originals').delete(id));
    },

    async saveWithoutFile(project, id) {
      await write(['projects', 'originals'], transaction => {
        transaction.objectStore('originals').delete(id);
        transaction.objectStore('projects').put(project, projectKey);
      });
    },

    async fingerprint(blob) {
      const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
      return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    },

    readMetadata,

    async exportBackup(project) {
      project = structuredClone(project);
      const assetIds = getAssetIds(project);
      const originals = database.transaction('originals').objectStore('originals');
      const data = await Promise.all([...assetIds].map(id => requestResult(originals.get(id))));
      const blobs = [];
      const files = [];
      for (const [index, asset] of project.assets.entries()) {
        const original = data[index];
        if (!(original instanceof Blob)) {
          if (asset.demoUrl) continue;
          throw new Error(`Originalfilen mangler for ${asset.name || asset.id}.`);
        }
        files.push({ id: asset.id, type: original.type, size: original.size });
        blobs.push(original);
      }
      const manifest = new TextEncoder().encode(JSON.stringify({ project, files }));
      if (manifest.length > maxManifestBytes) throw new Error('Projektets indeks er for stort til backupformatet.');
      const header = new Uint8Array(backupHeaderSize);
      header.set(backupSignature);
      new DataView(header.buffer).setUint32(backupSignature.length, manifest.length);
      return new Blob([header, manifest, ...blobs], { type: 'application/x-bisfoto-editor' });
    },

    async restoreBackup(blob) {
      const { project, originals } = await readBackup(blob);
      await write(['projects', 'originals'], transaction => {
        const files = transaction.objectStore('originals');
        files.clear();
        for (const [id, original] of originals) files.put(original, id);
        transaction.objectStore('projects').put(project, projectKey);
      });
      return project;
    },
  };
}

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const optionalString = value => value == null || typeof value === 'string';
const optionalNumber = value => value == null || Number.isFinite(value);
const stringList = value => Array.isArray(value) && value.every(item => typeof item === 'string');

function validMetadata(metadata) {
  if (metadata == null) return true;
  if (!isRecord(metadata)) return false;
  const textFields = ['date', 'timezone', 'make', 'model', 'camera', 'lens', 'location'];
  const numberFields = ['width', 'height', 'iso', 'aperture', 'shutter', 'focalLength', 'orientation'];
  if (!textFields.every(key => optionalString(metadata[key])) || !numberFields.every(key => optionalNumber(metadata[key]))) return false;
  const gps = metadata.gps;
  return gps == null || (isRecord(gps) && ['lat', 'lng', 'lon', 'altitude'].every(key => optionalNumber(gps[key])));
}

function validVersion(version) {
  if (!isRecord(version) || typeof version.id !== 'string' || !optionalString(version.name) || !optionalString(version.date)) return false;
  const edits = version.edits;
  if (edits == null) return true;
  if (!isRecord(edits)) return false;
  const controls = ['exposure', 'contrast', 'highlights', 'shadows', 'whites', 'blacks', 'temperature', 'tint', 'saturation', 'vibrance', 'clarity', 'sharpness', 'rotation', 'cropAspect'];
  return controls.every(key => optionalNumber(edits[key]));
}

function getAssetIds(project) {
  if (!project || typeof project.name !== 'string' || !Array.isArray(project.assets) || !Array.isArray(project.albums)) {
    throw new Error('Backuppen indeholder et ugyldigt projekt.');
  }
  const ids = new Set();
  for (const asset of project.assets) {
    if (!asset || typeof asset.id !== 'string' || !asset.id || ids.has(asset.id)) {
      throw new Error('Projektet indeholder ukendte eller dublerede billed-id’er.');
    }
    if (typeof asset.name !== 'string' || !optionalString(asset.title) || !optionalString(asset.versionId) ||
        (asset.tags != null && !stringList(asset.tags)) || !validMetadata(asset.metadata) || !validMetadata(asset.overrides) ||
        !Array.isArray(asset.versions) || !asset.versions.length || !asset.versions.every(validVersion) ||
        (asset.demoUrl !== undefined && (typeof asset.demoUrl !== 'string' || !demoPath.test(asset.demoUrl)))) {
      throw new Error('Projektet indeholder et billede med ugyldige data.');
    }
    ids.add(asset.id);
  }
  if (project.albums.some(album => !isRecord(album) || typeof album.id !== 'string' || typeof album.name !== 'string' ||
      !optionalString(album.query) || (album.assetIds != null && !stringList(album.assetIds)) ||
      (!album.query && !stringList(album.assetIds)))) {
    throw new Error('Projektet indeholder et album med ugyldige data.');
  }
  return ids;
}

async function readBackup(blob) {
  if (blob.size < backupHeaderSize) throw new Error('Filen er for kort til at være en projektbackup.');
  const header = new Uint8Array(await blob.slice(0, backupHeaderSize).arrayBuffer());
  if (!backupSignature.every((byte, index) => header[index] === byte)) throw new Error('Ukendt backupformat.');
  const manifestSize = new DataView(header.buffer).getUint32(backupSignature.length);
  let cursor = backupHeaderSize + manifestSize;
  if (!manifestSize || manifestSize > maxManifestBytes || cursor > blob.size) {
    throw new Error('Backuppens indeks mangler eller er beskadiget.');
  }
  let manifest;
  try {
    manifest = JSON.parse(textDecoder.decode(await blob.slice(backupHeaderSize, cursor).arrayBuffer()));
  } catch {
    throw new Error('Backuppens indeks kan ikke læses.');
  }
  const project = manifest?.project;
  const expectedIds = getAssetIds(project);
  if (!Array.isArray(manifest.files)) throw new Error('Backuppen mangler en oversigt over originalfiler.');

  const originals = new Map();
  for (const file of manifest.files) {
    if (!file || !expectedIds.has(file.id) || originals.has(file.id) ||
        typeof file.type !== 'string' || !Number.isSafeInteger(file.size) || file.size < 0) {
      throw new Error('Backuppens oversigt over originalfiler er beskadiget.');
    }
    const end = cursor + file.size;
    if (!Number.isSafeInteger(end) || end > blob.size) throw new Error('Backuppen indeholder en afbrudt originalfil.');
    originals.set(file.id, blob.slice(cursor, end, file.type));
    cursor = end;
  }
  if (cursor !== blob.size || project.assets.some(asset => !originals.has(asset.id) && !asset.demoUrl)) {
    throw new Error('Backuppens originalfiler stemmer ikke med projektet.');
  }
  return { project, originals };
}

const tiffFieldSizes = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };

function readExif(bytes) {
  let start = 0;
  if (startsWith(bytes, [69, 120, 105, 102, 0, 0])) start = 6;
  if (bytes.length - start < 8) return {};
  const tiff = bytes.subarray(start);
  const little = tiff[0] === 0x49 && tiff[1] === 0x49;
  const big = tiff[0] === 0x4d && tiff[1] === 0x4d;
  if (!little && !big) return {};
  const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  const word = offset => view.getUint16(offset, little);
  const long = offset => view.getUint32(offset, little);
  if (word(2) !== 42) return {};

  function readDirectory(offset) {
    const fields = new Map();
    if (!Number.isInteger(offset) || offset < 8 || offset + 2 > tiff.length) return fields;
    const entries = word(offset);
    if (entries > 2048 || offset + 2 + entries * 12 > tiff.length) return fields;
    for (let index = 0; index < entries; index += 1) {
      const entry = offset + 2 + index * 12;
      const type = word(entry + 2);
      const count = long(entry + 4);
      const size = tiffFieldSizes[type] * count;
      if (!size || size > 65536) continue;
      const value = size > 4 ? long(entry + 8) : entry + 8;
      if (value + size > tiff.length) continue;
      if (type === 2) {
        fields.set(word(entry), textDecoder.decode(tiff.subarray(value, value + size)).split('\0')[0].trim());
        continue;
      }
      if (count > 4) continue;
      const values = [];
      for (let item = 0; item < count; item += 1) {
        const at = value + item * tiffFieldSizes[type];
        if (type === 1 || type === 7) values.push(view.getUint8(at));
        if (type === 3) values.push(word(at));
        if (type === 4) values.push(long(at));
        if (type === 9) values.push(view.getInt32(at, little));
        if (type === 5 || type === 10) {
          const read = type === 5 ? long : position => view.getInt32(position, little);
          values.push(read(at) / read(at + 4));
        }
      }
      fields.set(word(entry), count === 1 ? values[0] : values);
    }
    return fields;
  }

  const image = readDirectory(long(4));
  const exif = readDirectory(image.get(0x8769));
  const gps = readDirectory(image.get(0x8825));
  const make = textValue(image.get(0x010f));
  const model = textValue(image.get(0x0110));
  const originalDate = exif.get(0x9003) || exif.get(0x9004) || image.get(0x0132);
  const match = typeof originalDate === 'string' && originalDate.match(/^(\d{4}):([01]\d):([0-3]\d) ([0-2]\d):([0-5]\d):([0-5]\d)$/);
  const date = match && Number(match[2]) >= 1 && Number(match[2]) <= 12 && Number(match[3]) >= 1 &&
    Number(match[3]) <= 31 && Number(match[4]) <= 23 ? `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}` : undefined;
  const offsetTag = exif.get(0x9003) ? 0x9011 : exif.get(0x9004) ? 0x9012 : 0x9010;
  const offset = exif.get(offsetTag);
  const timezone = date && typeof offset === 'string' && /^[+-](?:0\d|1[0-4]):[0-5]\d$/.test(offset) ? offset : undefined;
  const latitude = coordinates(gps.get(2), gps.get(1), 'N', 'S', 90);
  const longitude = coordinates(gps.get(4), gps.get(3), 'E', 'W', 180);
  const orientation = image.get(0x0112);
  const data = {
    date: timezone ? `${date}${timezone}` : date,
    timezone,
    gps: Number.isFinite(latitude) && Number.isFinite(longitude) ? { lat: latitude, lng: longitude } : undefined,
    make,
    model,
    camera: model && (!make || model.toLowerCase().includes(make.toLowerCase())) ? model : [make, model].filter(Boolean).join(' '),
    lens: textValue(exif.get(0xa434)) || textValue(exif.get(0xa433)),
    aperture: positive(exif.get(0x829d)),
    shutter: positive(exif.get(0x829a)),
    iso: positive(exif.get(0x8827)) || positive(exif.get(0x8833)),
    focalLength: positive(exif.get(0x920a)),
    width: positive(exif.get(0xa002)) || positive(image.get(0x0100)),
    height: positive(exif.get(0xa003)) || positive(image.get(0x0101)),
    orientation: Number.isInteger(orientation) && orientation >= 1 && orientation <= 8 ? orientation : undefined,
  };
  return Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined && value !== ''));
}

function positive(value) {
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function textValue(value) {
  return typeof value === 'string' && value ? value : undefined;
}

function coordinates(parts, direction, positiveDirection, negativeDirection, limit) {
  if (!Array.isArray(parts) || parts.length !== 3 || !parts.every(part => Number.isFinite(part) && part >= 0)) return;
  if (direction !== positiveDirection && direction !== negativeDirection) return;
  const decimal = parts[0] + parts[1] / 60 + parts[2] / 3600;
  if (parts[1] >= 60 || parts[2] >= 60 || decimal > limit) return;
  return direction === negativeDirection ? -decimal : decimal;
}

function startsWith(bytes, prefix) {
  return prefix.every((byte, index) => bytes[index] === byte);
}

function jpegMetadata(bytes) {
  const properties = {};
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 2;
  while (offset + 4 <= bytes.length && bytes[offset] === 0xff) {
    const marker = bytes[offset + 1];
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) break;
    const size = view.getUint16(offset + 2);
    const end = offset + 2 + size;
    if (size < 2 || end > bytes.length) break;
    const payload = offset + 4;
    if (marker === 0xe1 && startsWith(bytes.subarray(payload, end), [69, 120, 105, 102, 0, 0])) {
      Object.assign(properties, readExif(bytes.subarray(payload, end)));
    }
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker) && size >= 7) {
      properties.height = view.getUint16(payload + 1);
      properties.width = view.getUint16(payload + 3);
    }
    offset = end;
  }
  return properties;
}

async function chunkedMetadata(blob, bytes, format) {
  const png = format === 'png';
  const properties = {};
  let offset = png ? 8 : 12;
  async function read(start, end) {
    return end <= bytes.length ? bytes.subarray(start, end) : new Uint8Array(await blob.slice(start, end).arrayBuffer());
  }

  for (let count = 0; count < 4096 && offset + 8 <= blob.size; count += 1) {
    const header = await read(offset, offset + 8);
    const headerView = new DataView(header.buffer, header.byteOffset, header.byteLength);
    const kind = textDecoder.decode(png ? header.subarray(4) : header.subarray(0, 4));
    const size = headerView.getUint32(png ? 0 : 4, !png);
    const payload = offset + 8;
    const end = payload + size;
    if (end > blob.size) break;

    if ((png && kind === 'eXIf') || (!png && kind === 'EXIF')) {
      if (size <= maxMetadataBytes) Object.assign(properties, readExif(await read(payload, end)));
      break;
    }
    if (kind === 'IHDR' && png && size >= 8) {
      const data = await read(payload, payload + 8);
      const dimensions = new DataView(data.buffer, data.byteOffset, data.byteLength);
      properties.width = dimensions.getUint32(0);
      properties.height = dimensions.getUint32(4);
    }
    if (kind === 'VP8X' && !png && size >= 10) {
      const data = await read(payload, payload + 10);
      properties.width = 1 + (data[4] | (data[5] << 8) | (data[6] << 16));
      properties.height = 1 + (data[7] | (data[8] << 8) | (data[9] << 16));
    }
    if (kind === 'VP8L' && !png && size >= 5 && !properties.width) {
      const data = await read(payload, payload + 5);
      if (data[0] === 0x2f) {
        const bits = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(1, true);
        properties.width = 1 + (bits & 0x3fff);
        properties.height = 1 + ((bits >>> 14) & 0x3fff);
      }
    }
    if (kind === 'VP8 ' && !png && size >= 10 && !properties.width) {
      const data = await read(payload, payload + 10);
      if (startsWith(data.subarray(3), [0x9d, 0x01, 0x2a])) {
        const dimensions = new DataView(data.buffer, data.byteOffset, data.byteLength);
        properties.width = dimensions.getUint16(6, true) & 0x3fff;
        properties.height = dimensions.getUint16(8, true) & 0x3fff;
      }
    }
    if (kind === 'IEND' && png) break;
    offset = end + (png ? 4 : size % 2);
  }
  return properties;
}

async function readMetadata(blob) {
  const bytes = new Uint8Array(await blob.slice(0, 512 * 1024).arrayBuffer());
  if (startsWith(bytes, [0xff, 0xd8])) return jpegMetadata(bytes);
  if (startsWith(bytes, [137, 80, 78, 71, 13, 10, 26, 10])) return chunkedMetadata(blob, bytes, 'png');
  if (startsWith(bytes, [82, 73, 70, 70]) && startsWith(bytes.subarray(8), [87, 69, 66, 80])) {
    return chunkedMetadata(blob, bytes, 'webp');
  }
  return readExif(bytes);
}
