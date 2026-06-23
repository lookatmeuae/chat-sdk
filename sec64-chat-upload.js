/* 64sec chat — multi-file upload (images / files) + voice notes, via plupload.
 * Requires plupload to be loaded first:
 *   <script src="https://cdn.jsdelivr.net/npm/plupload@3.1.5/js/plupload.full.min.js"></script>
 * Usage:
 *   Sec64Upload.init({
 *     browseButton: '#chat-attach',     // element that opens the file picker
 *     dropArea:     '#chat-composer',   // (optional) drag-drop target
 *     url:          'index.cfm?action=chat.upload',
 *     onUploaded:   function(att){ ... },   // att = {type,url,name,size,mime,duration}
 *     onError:      function(err){ ... }
 *   });
 *   Sec64Upload.startVoice(); / Sec64Upload.stopVoice();   // record + queue a voice note
 *   Sec64Upload.getPending();  Sec64Upload.clear();        // attachments ready to send
 */
(function (w) {
  'use strict';

  var uploader = null;
  var pending = [];        // [{type,url,name,size,mime,duration}]
  var cfg = {};

  // ---- voice recording state ----
  var mediaRecorder = null, voiceChunks = [], voiceStart = 0;

  function init(options) {
    cfg = options || {};
    if (!w.plupload) { console.error('[Sec64Upload] plupload not loaded'); return; }

    uploader = new plupload.Uploader({
      runtimes: 'html5',
      browse_button: el(cfg.browseButton),
      drop_element: cfg.dropArea ? el(cfg.dropArea) : undefined,
      url: cfg.url || 'index.cfm?action=chat.upload',
      multi_selection: true,                 // multiple files at once
      file_data_name: 'file',                // matches cffile fileField="file"
      chunk_size: 0,                         // one POST per file (server expects whole file)
      filters: {
        max_file_size: '25mb',
        mime_types: [
          { title: 'Images', extensions: 'jpg,jpeg,png,gif,webp' },
          { title: 'Documents', extensions: 'pdf,doc,docx,xls,xlsx,ppt,pptx,txt,csv,ai,psd,zip' },
          { title: 'Audio', extensions: 'webm,mp3,m4a,ogg,wav' }
        ]
      }
    });

    uploader.bind('FilesAdded', function (up) { up.start(); });

    uploader.bind('FileUploaded', function (up, file, info) {
      var att;
      try { att = JSON.parse(info.response); } catch (e) { att = { status: false, error: 'bad response' }; }
      if (att && att.status) {
        if (file._voiceDuration) { att.duration = file._voiceDuration; att.type = 'voice'; }
        pending.push(att);
        if (typeof cfg.onUploaded === 'function') cfg.onUploaded(att);
      } else if (typeof cfg.onError === 'function') {
        cfg.onError((att && att.error) || 'upload failed');
      }
    });

    uploader.bind('Error', function (up, err) {
      if (typeof cfg.onError === 'function') cfg.onError(err.message || 'upload error');
    });

    uploader.init();
  }

  function el(sel) {
    if (!sel) return undefined;
    return typeof sel === 'string' ? document.querySelector(sel) : sel;
  }

  // ---- voice note: record with MediaRecorder, then hand the blob to plupload ----
  function startVoice() {
    if (!navigator.mediaDevices || !w.MediaRecorder) {
      if (cfg.onError) cfg.onError('Voice recording not supported in this browser');
      return Promise.reject();
    }
    return navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
      voiceChunks = [];
      voiceStart = Date.now();
      mediaRecorder = new MediaRecorder(stream);
      mediaRecorder.ondataavailable = function (e) { if (e.data.size) voiceChunks.push(e.data); };
      mediaRecorder.onstop = function () {
        stream.getTracks().forEach(function (t) { t.stop(); });
        var duration = Math.round((Date.now() - voiceStart) / 1000);
        var blob = new Blob(voiceChunks, { type: 'audio/webm' });
        var name = 'voice_' + Date.now() + '.webm';
        var file = new File([blob], name, { type: 'audio/webm' });
        // queue into plupload so it follows the exact same upload path
        var added = uploader.addFile(file, name);
        // plupload wraps it — tag duration on the wrapped file so FileUploaded can read it
        var q = uploader.files;
        if (q.length) q[q.length - 1]._voiceDuration = duration;
      };
      mediaRecorder.start();
      return true;
    });
  }

  function stopVoice() {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
  }

  function getPending() { return pending.slice(); }
  function clear() { pending = []; }

  w.Sec64Upload = {
    init: init,
    startVoice: startVoice,
    stopVoice: stopVoice,
    getPending: getPending,
    clear: clear
  };
})(window);
