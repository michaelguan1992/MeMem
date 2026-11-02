import { readJpegTakenAt } from './exif.ts';

/**
 * Browser script for the /capture page, served as /capture.js (no inline script is allowed by the page policy).
 * The JavaScript is a template string, so it contains no backticks, no template substitutions besides the EXIF
 * reader, and no backslashes. Every value from the server or from a photo is written with textContent.
 */
export const captureScript = `(function () {
  'use strict';
${readJpegTakenAt.toString()}

  var DISPLAY_EDGE = 1600;
  var THUMB_EDGE = 400;
  var JPEG_QUALITY = 0.85;
  var MAX_ORIGINAL_BYTES = 25 * 1024 * 1024;
  var MAX_DISPLAY_BYTES = 5 * 1024 * 1024;
  var MAX_THUMB_BYTES = 1024 * 1024;
  var WALL_TIME = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2})?$/;

  var form = document.getElementById('capture-form');
  var csrfMeta = document.querySelector('meta[name="csrf-token"]');
  if (!form || !csrfMeta) return;
  var csrf = csrfMeta.getAttribute('content') || '';
  var textInput = document.getElementById('entry-text');
  var whenInput = document.getElementById('entry-when');
  var photosInput = document.getElementById('entry-photos');
  var photoList = document.getElementById('photo-list');
  var relatedFieldset = document.getElementById('related');
  var relatedList = document.getElementById('related-list');
  var saveButton = document.getElementById('save-button');
  var statusLine = document.getElementById('status');
  var savedPhotos = document.getElementById('saved-photos');

  // memoryId is set once the entry exists, so a retry of failed photos never creates a second entry.
  var state = { busy: false, memoryId: null, exifOffset: null, queue: [], prefillRun: 0 };

  function pad2(value) { return (value < 10 ? '0' : '') + value; }

  function nowWall() {
    var now = new Date();
    return now.getFullYear() + '-' + pad2(now.getMonth() + 1) + '-' + pad2(now.getDate())
      + 'T' + pad2(now.getHours()) + ':' + pad2(now.getMinutes());
  }

  function offsetText(minutes) {
    var size = Math.abs(minutes);
    return (minutes < 0 ? '-' : '+') + pad2(Math.floor(size / 60)) + ':' + pad2(size % 60);
  }

  // Browser offset in minutes east of UTC for a local wall-clock time such as 2025-05-01T14:30.
  function browserOffset(wall) {
    var parts = wall.split(/[-T:]/);
    var local = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]), Number(parts[3]), Number(parts[4]));
    return -local.getTimezoneOffset();
  }

  function hexOf(buffer) {
    var bytes = new Uint8Array(buffer);
    var text = '';
    for (var i = 0; i < bytes.length; i++) text += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
    return text;
  }

  function looksLikeJpeg(bytes) {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }

  function messageOf(error) {
    return error instanceof Error && error.message ? error.message : 'Something went wrong. What you typed is still here; try again.';
  }

  function showStatus(message, isError) {
    statusLine.textContent = message;
    statusLine.className = isError ? 'error' : '';
  }

  // Capture time of one JPEG as an ISO string with offset, or null. The second pass gives readJpegTakenAt the
  // browser's offset for that date, which it uses only when the photo carries no OffsetTimeOriginal.
  function takenAtOf(bytes) {
    var guess = readJpegTakenAt(bytes, -new Date().getTimezoneOffset());
    return guess === null ? null : readJpegTakenAt(bytes, browserOffset(guess.slice(0, 16)));
  }

  // The photo's own offset, or null. readJpegTakenAt returns its fallback only when the photo has no
  // OffsetTimeOriginal, so two different fallbacks give the same string exactly when the offset is the photo's own.
  function ownOffsetOf(bytes) {
    var asZero = readJpegTakenAt(bytes, 0);
    var asSixty = readJpegTakenAt(bytes, 60);
    return asZero !== null && asZero === asSixty ? asZero.slice(19) : null;
  }

  // The time comes from the first JPEG that has an EXIF time; otherwise the field shows the current local time.
  async function prefillTime(files) {
    var run = ++state.prefillRun;
    var wall = null;
    var offset = null;
    for (var i = 0; i < files.length; i++) {
      var head = new Uint8Array(await files[i].slice(0, 3).arrayBuffer());
      if (!looksLikeJpeg(head)) continue;
      var bytes = new Uint8Array(await files[i].arrayBuffer());
      var taken = takenAtOf(bytes);
      if (taken !== null) {
        wall = taken.slice(0, 16);
        offset = ownOffsetOf(bytes);
      }
      break;
    }
    if (run !== state.prefillRun) return; // a newer photo selection has replaced this one
    whenInput.value = wall || nowWall();
    state.exifOffset = offset;
  }

  function clearPhotos() {
    state.queue.forEach(function (item) { URL.revokeObjectURL(item.url); });
    state.queue = [];
    photoList.textContent = '';
  }

  function setItem(item, phase, text) {
    item.row.dataset.state = phase;
    item.status.textContent = text;
  }

  function addPhoto(file) {
    var item = {
      file: file,
      url: URL.createObjectURL(file),
      done: false,
      mediaId: null,
      message: '',
      row: document.createElement('li'),
      status: document.createElement('span')
    };
    var preview = document.createElement('img');
    preview.alt = '';
    preview.src = item.url;
    preview.addEventListener('error', function () { preview.alt = 'No preview'; });
    var text = document.createElement('div');
    var name = document.createElement('span');
    name.className = 'name';
    name.textContent = file.name || 'Photo';
    item.status.className = 'status';
    text.appendChild(name);
    text.appendChild(item.status);
    item.row.className = 'photo';
    item.row.appendChild(preview);
    item.row.appendChild(text);
    photoList.appendChild(item.row);
    setItem(item, 'waiting', 'Waiting');
    state.queue.push(item);
  }

  photosInput.addEventListener('change', function () {
    var files = Array.prototype.slice.call(photosInput.files || []);
    clearPhotos();
    files.forEach(function (file) { addPhoto(file); });
    prefillTime(files).catch(function () {
      whenInput.value = nowWall();
      state.exifOffset = null;
    });
  });

  function applyLocks() {
    var entryLocked = state.busy || state.memoryId !== null;
    textInput.disabled = entryLocked;
    whenInput.disabled = entryLocked;
    relatedFieldset.disabled = entryLocked;
    photosInput.disabled = entryLocked;
    saveButton.disabled = state.busy;
    saveButton.textContent = state.busy ? 'Saving…' : state.memoryId !== null ? 'Retry photos' : 'Save entry';
  }

  function setBusy(flag) {
    state.busy = flag;
    applyLocks();
  }

  // Same-origin JSON or multipart request. Non-GET requests carry the CSRF token from the page.
  async function api(method, path, body) {
    var init = { method: method, credentials: 'same-origin', headers: {} };
    if (method !== 'GET') init.headers['X-CSRF-Token'] = csrf;
    if (body instanceof FormData) {
      init.body = body;
    } else if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    var response;
    try {
      response = await fetch(path, init);
    } catch (error) {
      throw new Error('Could not reach MeMem. Check the connection; what you typed is still here.');
    }
    var data = null;
    try { data = await response.json(); } catch (error) { data = null; }
    if (response.status === 401) throw new Error('Your session has ended. Reload the page and sign in again.');
    if (!response.ok) throw new Error((data && data.message) || 'Request failed (HTTP ' + response.status + ').');
    return data;
  }

  // Follows every page of /api/related; each page is filtered on the server, so pages can hold fewer items.
  async function loadRelated() {
    var items = [];
    var after = null;
    for (var page = 0; page < 1000; page++) {
      var query = after === null ? '' : '?afterId=' + encodeURIComponent(after);
      var data = await api('GET', '/api/related' + query);
      items = items.concat(data.items);
      if (!data.nextAfterId || data.nextAfterId === after) break;
      after = data.nextAfterId;
    }
    return items;
  }

  function renderRelated(items) {
    relatedList.textContent = '';
    var groups = [['person', 'People'], ['place', 'Places']];
    var shown = 0;
    groups.forEach(function (group) {
      var matches = items.filter(function (item) { return item.kind === group[0]; });
      if (matches.length === 0) return;
      shown += matches.length;
      var title = document.createElement('p');
      title.className = 'group-title';
      title.textContent = group[1];
      relatedList.appendChild(title);
      matches.forEach(function (item) {
        var label = document.createElement('label');
        label.className = 'choice';
        var box = document.createElement('input');
        box.type = 'checkbox';
        box.value = item.id;
        var text = document.createElement('span');
        text.textContent = item.text;
        label.appendChild(box);
        label.appendChild(text);
        relatedList.appendChild(label);
      });
    });
    if (shown === 0) relatedList.textContent = 'No people or places saved yet.';
  }

  function checkedIds() {
    return Array.prototype.map.call(relatedList.querySelectorAll('input[type=checkbox]:checked'), function (box) { return box.value; });
  }

  // undefined when the field is empty, null when it is not a local time, otherwise an ISO time with offset.
  // The offset is the photo's own when the first JPEG had one; otherwise the browser's offset for that date.
  function occurredAtValue() {
    var wall = whenInput.value;
    if (!wall) return undefined;
    if (!WALL_TIME.test(wall)) return null;
    var zone = state.exifOffset || offsetText(browserOffset(wall));
    return (wall.length === 16 ? wall + ':00' : wall) + zone;
  }

  function encodeJpeg(bitmap, edge) {
    var scale = Math.min(1, edge / Math.max(bitmap.width, bitmap.height));
    var canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    var context = canvas.getContext('2d');
    if (!context) return Promise.resolve(null);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return new Promise(function (resolve) { canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY); });
  }

  // Display and thumbnail JPEGs with the decoded size, or null when this browser cannot decode the photo.
  async function derivatives(file) {
    if (typeof createImageBitmap !== 'function') return null;
    var bitmap;
    try {
      bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch (error) {
      return null;
    }
    try {
      var display = await encodeJpeg(bitmap, DISPLAY_EDGE);
      var thumb = await encodeJpeg(bitmap, THUMB_EDGE);
      return {
        width: bitmap.width,
        height: bitmap.height,
        display: display && display.size <= MAX_DISPLAY_BYTES ? display : null,
        thumb: thumb && thumb.size <= MAX_THUMB_BYTES ? thumb : null
      };
    } catch (error) {
      return null;
    } finally {
      if (typeof bitmap.close === 'function') bitmap.close();
    }
  }

  async function uploadPhoto(item) {
    var file = item.file;
    if (file.size > MAX_ORIGINAL_BYTES) throw new Error('This photo is larger than 25 MB.');
    setItem(item, 'working', 'Reading photo');
    var buffer = await file.arrayBuffer();
    var bytes = new Uint8Array(buffer);
    var sha256 = hexOf(await crypto.subtle.digest('SHA-256', buffer));
    var taken = takenAtOf(bytes);
    setItem(item, 'working', 'Making preview');
    var derived = await derivatives(file);
    var body = new FormData();
    body.append('original', file, file.name || 'photo.jpg');
    body.append('sha256', sha256);
    if (taken !== null) body.append('takenAt', taken);
    if (derived !== null) {
      body.append('width', String(derived.width));
      body.append('height', String(derived.height));
      if (derived.display !== null) body.append('display', derived.display, 'display.jpg');
      if (derived.thumb !== null) body.append('thumb', derived.thumb, 'thumb.jpg');
    }
    body.append('memoryId', state.memoryId);
    setItem(item, 'working', 'Uploading');
    var result = await api('POST', '/api/media', body);
    var media = result.media;
    if (result.duplicate && media.memoryId === null) {
      setItem(item, 'working', 'Linking to this entry');
      // Both fields are required on every PATCH; the photo's current caption is sent back unchanged.
      var linked = await api('PATCH', '/api/media/' + encodeURIComponent(media.id), {
        expectedVersion: media.version,
        memoryId: state.memoryId,
        caption: media.caption
      });
      media = linked.media;
    }
    item.mediaId = media.id;
    item.done = true;
    if (media.memoryId !== state.memoryId) {
      item.message = 'Already saved to another entry';
    } else if (result.duplicate) {
      item.message = 'Saved (this photo was already in MeMem)';
    } else if (derived === null || derived.display === null) {
      item.message = 'Saved without a preview';
    } else {
      item.message = 'Saved';
    }
    setItem(item, 'saved', item.message);
  }

  function finishSave() {
    var saved = state.queue.filter(function (item) { return item.done; });
    clearPhotos();
    state.memoryId = null;
    state.exifOffset = null;
    textInput.value = '';
    photosInput.value = '';
    whenInput.value = nowWall();
    Array.prototype.forEach.call(relatedList.querySelectorAll('input[type=checkbox]'), function (box) { box.checked = false; });
    savedPhotos.textContent = '';
    saved.forEach(function (item) {
      var figure = document.createElement('figure');
      var thumb = document.createElement('img');
      thumb.width = 96;
      thumb.height = 96;
      thumb.alt = 'Saved photo';
      thumb.src = '/api/media/' + encodeURIComponent(item.mediaId) + '/thumb';
      thumb.addEventListener('error', function () { thumb.alt = 'Saved; no preview'; });
      var caption = document.createElement('figcaption');
      caption.textContent = item.message;
      figure.appendChild(thumb);
      figure.appendChild(caption);
      savedPhotos.appendChild(figure);
    });
    showStatus('Saved.', false);
  }

  async function save() {
    var text = textInput.value.trim();
    if (state.memoryId === null && text === '') {
      showStatus('Write a few words about the moment first.', true);
      textInput.focus();
      return;
    }
    setBusy(true);
    savedPhotos.textContent = '';
    showStatus('Saving…', false);
    try {
      if (state.memoryId === null) {
        var occurredAt = occurredAtValue();
        if (occurredAt === null) throw new Error('Choose a valid date and time.');
        var body = { text: text };
        if (occurredAt !== undefined) body.occurredAt = occurredAt;
        var related = checkedIds();
        if (related.length > 0) body.relatedIds = related;
        var created = await api('POST', '/api/entries', body);
        state.memoryId = created.memory.id;
      }
      for (var i = 0; i < state.queue.length; i++) {
        var item = state.queue[i];
        if (item.done) continue;
        try {
          await uploadPhoto(item);
        } catch (error) {
          setItem(item, 'failed', messageOf(error));
        }
      }
      var pending = state.queue.filter(function (item) { return !item.done; });
      if (pending.length > 0) {
        showStatus('The entry is saved, but ' + pending.length + ' photo(s) did not upload. Press Retry photos to try them again.', true);
      } else {
        finishSave();
      }
    } catch (error) {
      showStatus(messageOf(error), true);
    } finally {
      setBusy(false);
    }
  }

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    if (!state.busy) save();
  });

  whenInput.value = nowWall();
  applyLocks();
  loadRelated()
    .then(renderRelated)
    .catch(function (error) { relatedList.textContent = 'Could not load people and places. ' + messageOf(error); });
})();
`;
