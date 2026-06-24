/* 64sec chat — multi-file upload (images / files) + voice notes, via plupload + direct fetch.
 *
 * Usage:
 *   Sec64Upload.init({
 *     browseButton: '#chat-attach',
 *     dropArea:     '#chat-composer',
 *     url:          'index.cfm?action=chat.upload',
 *     onAdded:      function(item){ ... },                      // file queued (renders chip)
 *     onProgress:   function(item){ ... },                      // progress %
 *     onUploaded:   function(item){ ... },                      // done — item.state='done', item.url set
 *     onError:      function(item, err){ ... },                 // upload failed for one file
 *   });
 *   Sec64Upload.startVoice(); / stopVoice();                    // record a voice note
 *   Sec64Upload.removeFile(id);                                 // remove a queued or done file
 *   Sec64Upload.getPending(); / Sec64Upload.getReady();         // all items / only completed
 *   Sec64Upload.clear();                                        // clear list (call after send)
 *   Sec64Upload.setUrl(url);                                    // update upload URL at runtime (per-thread params)
 *
 * Pending item shape:
 *   { id, name, size, mime, type, state:'queued'|'uploading'|'done'|'error',
 *     progress, thumb?, url?, duration?, error? }
 */
(function (w) {
  'use strict';

  var uploader = null;
  var items    = [];                                            // array of pending items (all states)
  var cfg      = {};
  var nextId   = 1;
  var mediaRecorder = null, voiceChunks = [], voiceStart = 0;

  function init(options) {
    cfg = options || {};
    if (!w.plupload) { console.warn('[Sec64Upload] plupload not loaded yet'); return; }

    uploader = new plupload.Uploader({
      runtimes:      'html5',
      browse_button:  el(cfg.browseButton),
      drop_element:   cfg.dropArea ? el(cfg.dropArea) : undefined,
      url:            cfg.url || 'index.cfm?action=chat.upload',
      multi_selection:true,
      autostart:      false,                                  // we upload via XHR for smooth native progress
      file_data_name: 'file',
      chunk_size:     0,
      filters: {
        max_file_size: '25mb',
        mime_types: [
          { title: 'Images',    extensions: 'jpg,jpeg,png,gif,webp' },
          { title: 'Documents', extensions: 'pdf,doc,docx,xls,xlsx,ppt,pptx,txt,csv,ai,psd,zip' },
          { title: 'Audio',     extensions: 'webm,mp3,m4a,ogg,wav' }
        ]
      }
    });

    // Use plupload purely for the file picker + drag-drop UX.
    // Actual upload goes through XMLHttpRequest so we get real incremental upload.onprogress events.
    uploader.bind('FilesAdded', function (up, files) {
      files.forEach(function (f) {
        var item = makeItem(f);
        items.push(item);
        if (typeof cfg.onAdded === 'function') cfg.onAdded(item);
        uploadItemViaXhr(item);
      });
    });

    uploader.bind('Error', function (up, err) {
      if (typeof cfg.onError === 'function') cfg.onError(null, (err && err.message) || 'upload error');
    });

    uploader.init();
  }

  function uploadItemViaXhr(item){
    var nativeFile = item._native;
    if (!nativeFile) { item.state='error'; item.error='no native file'; if (cfg.onError) cfg.onError(item, item.error); return; }

    item.state    = 'uploading';
    item.progress = 0;
    if (typeof cfg.onProgress === 'function') cfg.onProgress(item);

    var fd  = new FormData();
    fd.append('file', nativeFile, item.name);

    var xhr = new XMLHttpRequest();
    item._xhr = xhr;
    xhr.open('POST', cfg.url, true);
    xhr.withCredentials = true;
    if (xhr.upload) {
      xhr.upload.onprogress = function (e) {
        if (e.lengthComputable) {
          item.progress = Math.round((e.loaded / e.total) * 100);
          if (typeof cfg.onProgress === 'function') cfg.onProgress(item);
        }
      };
    }
    xhr.onload = function () {
      var att; try { att = JSON.parse(xhr.responseText); } catch (e) { att = { status: false, error: 'bad response' }; }
      if (att && (att.status || att.STATUS)) {
        item.state    = 'done';
        item.progress = 100;
        item.url      = att.url  || att.URL;
        item.mime     = att.mime || att.MIME || item.mime;
        item.size     = att.size || att.SIZE || item.size;
        if (typeof cfg.onUploaded === 'function') cfg.onUploaded(item);
      } else {
        item.state = 'error';
        item.error = (att && (att.error || att.ERROR)) || 'upload failed';
        if (typeof cfg.onError === 'function') cfg.onError(item, item.error);
      }
    };
    xhr.onerror = function () {
      if (item.state === 'cancelled') return;
      item.state = 'error';
      item.error = 'upload error';
      if (typeof cfg.onError === 'function') cfg.onError(item, item.error);
    };
    xhr.onabort = function () {
      item.state = 'cancelled';
    };
    xhr.send(fd);
  }

  function el(sel) { return sel ? (typeof sel === 'string' ? document.querySelector(sel) : sel) : undefined; }

  function makeItem(pluploadFile) {
    var nativeFile = (pluploadFile && pluploadFile.getNative) ? pluploadFile.getNative() : null;
    var mime = (nativeFile && nativeFile.type) || '';
    var kind = mime.indexOf('image/') === 0 ? 'image'
             : mime.indexOf('audio/') === 0 ? 'voice'
             : 'file';
    var thumb = '';
    if (kind === 'image' && nativeFile && w.URL && URL.createObjectURL) {
      try { thumb = URL.createObjectURL(nativeFile); } catch (e) {}
    }
    return {
      id:        'p' + (nextId++),
      pluploadId: pluploadFile.id,
      name:      pluploadFile.name,
      size:      pluploadFile.size || (nativeFile ? nativeFile.size : 0),
      mime:      mime,
      type:      kind,
      state:     'queued',
      progress:  0,
      thumb:     thumb,
      url:       '',
      duration:  0,
      error:     '',
      _native:   nativeFile,                                   // for revoke later
      _pl:       pluploadFile
    };
  }

  function findById(id)         { for (var i=0;i<items.length;i++) if (items[i].id === id) return items[i]; return null; }
  function findByPluploadId(pid){ for (var i=0;i<items.length;i++) if (items[i].pluploadId === pid) return items[i]; return null; }

  function removeFile(id) {
    var item = findById(id);
    if (!item) return false;
    // abort in-flight XHR if uploading
    if (item._xhr && (item.state === 'uploading' || item.state === 'queued')) {
      try { item._xhr.abort(); } catch (e) {}
    }
    if (uploader && item._pl) {
      try { uploader.removeFile(item._pl); } catch (e) {}
    }
    if (item.thumb && w.URL && URL.revokeObjectURL) { try { URL.revokeObjectURL(item.thumb); } catch (e) {} }
    var idx = items.indexOf(item);
    if (idx > -1) items.splice(idx, 1);
    return true;
  }

  function clear() {
    items.forEach(function (it) {
      if (it.thumb && w.URL && URL.revokeObjectURL) { try { URL.revokeObjectURL(it.thumb); } catch (e) {} }
    });
    items = [];
  }

  function getPending() { return items.slice(); }
  function getReady()   { return items.filter(function (it) { return it.state === 'done'; }); }
  function setUrl(url)  { cfg.url = url; if (uploader) try { uploader.setOption('url', url); } catch (e) {} }

  /* ---- voice note: record with MediaRecorder, upload via direct fetch ---- */
  function pickMime(){
    if (!w.MediaRecorder) return '';
    var prefs = ['audio/webm;codecs=opus','audio/webm','audio/ogg;codecs=opus','audio/ogg','audio/mp4'];
    for (var i=0;i<prefs.length;i++){ if (MediaRecorder.isTypeSupported(prefs[i])) return prefs[i]; }
    return '';
  }

  function startVoice() {
    if (!navigator.mediaDevices || !w.MediaRecorder) {
      if (cfg.onError) cfg.onError(null, 'Voice recording not supported in this browser');
      return Promise.reject();
    }
    return navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
      voiceChunks = [];
      voiceStart  = Date.now();
      var mime = pickMime() || 'audio/webm';
      try { mediaRecorder = new MediaRecorder(stream, { mimeType: mime }); }
      catch (e) { mediaRecorder = new MediaRecorder(stream); }

      mediaRecorder.ondataavailable = function (e) { if (e.data && e.data.size) voiceChunks.push(e.data); };
      mediaRecorder.onstop = function () {
        stream.getTracks().forEach(function (t) { t.stop(); });
        var duration = Math.round((Date.now() - voiceStart) / 1000);
        if (!voiceChunks.length) { if (cfg.onError) cfg.onError(null, 'Empty recording'); return; }

        var ext  = (mime.indexOf('mp4')>-1) ? 'mp4' : (mime.indexOf('ogg')>-1) ? 'ogg' : 'webm';
        var type = (mime.indexOf('mp4')>-1) ? 'audio/mp4' : (mime.indexOf('ogg')>-1) ? 'audio/ogg' : 'audio/webm';
        var blob = new Blob(voiceChunks, { type: type });
        var name = 'voice_' + Date.now() + '.' + ext;

        // create item BEFORE uploading so SDK can show a chip with indeterminate progress
        var item = {
          id:'p'+(nextId++), pluploadId:'', name:name, size:blob.size, mime:type, type:'voice',
          state:'uploading', progress:0, thumb:'', url:'', duration:duration, error:'',
          _native:null, _pl:null
        };
        items.push(item);
        if (typeof cfg.onAdded === 'function') cfg.onAdded(item);

        // use XHR for upload progress (fetch doesn't expose it natively)
        var xhr = new XMLHttpRequest();
        xhr.open('POST', cfg.url, true);
        xhr.withCredentials = true;
        if (xhr.upload) {
          xhr.upload.onprogress = function (e) {
            if (e.lengthComputable) {
              item.progress = Math.round((e.loaded / e.total) * 100);
              if (typeof cfg.onProgress === 'function') cfg.onProgress(item);
            }
          };
        }
        xhr.onload = function () {
          var att; try { att = JSON.parse(xhr.responseText); } catch (e) { att = { status:false, error:'bad response' }; }
          var ok = att && (att.status || att.STATUS);
          if (ok) {
            item.state    = 'done';
            item.progress = 100;
            item.url      = att.url  || att.URL;
            item.mime     = att.mime || att.MIME || type;
            item.size     = att.size || att.SIZE || blob.size;
            item.type     = 'voice';
            if (typeof cfg.onUploaded === 'function') cfg.onUploaded(item);
          } else {
            item.state = 'error';
            item.error = (att && (att.error || att.ERROR)) || 'voice upload failed';
            if (typeof cfg.onError === 'function') cfg.onError(item, item.error);
          }
        };
        xhr.onerror = function () {
          item.state = 'error';
          item.error = 'voice upload error';
          if (typeof cfg.onError === 'function') cfg.onError(item, item.error);
        };
        var fd = new FormData(); fd.append('file', blob, name);
        xhr.send(fd);
      };
      mediaRecorder.start();
      return true;
    });
  }

  function stopVoice() {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
  }

  w.Sec64Upload = {
    init:       init,
    startVoice: startVoice,
    stopVoice:  stopVoice,
    getPending: getPending,
    getReady:   getReady,
    clear:      clear,
    removeFile: removeFile,
    setUrl:     setUrl
  };
})(window);
