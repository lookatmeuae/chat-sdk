/* 64sec chat SDK — vanilla JS, Firebase v8 compat.
 * - Client-side direct Firebase writes for messages + receipts + fan-out.
 * - CFML API only for: auth (chat.firebaseLogin), create room (chat.ensureThread),
 *   member management (chat.addMember), file uploads (chat.upload).
 * - WhatsApp-style overlay: rooms inbox (left) + active chat (right). Draggable header.
 * - openThread checks Firebase for existing room; if missing, shows "Begin Chat".
 *
 * Public API:
 *   Sec64Chat.init({ bell:'#x', soundUrl:'...' })          // call once at page load
 *   Sec64Chat.open()                                       // open overlay, inbox only
 *   Sec64Chat.openThread({ threadType, leadId, taskId?, bidItemId?, vendorId? })
 *   Sec64Chat.openRoom(roomId)                             // open by roomId directly
 *   Sec64Chat.close()                                      // hide overlay
 *
 * Window globals registered for backwards-compat:
 *   window.openTaskChat / openCustomerChat / openBidInternalChat /
 *   openBidVendorChat / openJobVendorChat / openChatOverlay / closeChatOverlay
 */
;(function (w, d) {
  'use strict';
  var S = {};
  var PALETTE = ['#2563eb','#7c3aed','#0891b2','#059669','#d97706','#db2777','#4f46e5','#0d9488','#b45309','#9333ea'];

  /* ────── helpers ────── */
  function qs(s){ return typeof s === 'string' ? d.querySelector(s) : s; }
  function el(t,c,h){ var e=d.createElement(t); if(c)e.className=c; if(h!=null)e.innerHTML=h; return e; }
  function esc(s){ return (s==null?'':String(s)).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];}); }
  function hash(s){ var h=0; s=s||''; for(var i=0;i<s.length;i++){ h=(h<<5)-h+s.charCodeAt(i); h|=0; } return h; }
  function initials(n){ n=(n||'?').trim(); if(!n)return '?'; return n.split(/\s+/).map(function(x){return x[0];}).slice(0,2).join('').toUpperCase(); }
  function avatar(name,size){ size=size||34; var c=PALETTE[Math.abs(hash(name||'?'))%PALETTE.length]; return '<span class="sec64chat-ava" style="width:'+size+'px;height:'+size+'px;font-size:'+Math.round(size*0.4)+'px;background:'+c+'">'+esc(initials(name))+'</span>'; }
  function sideForRole(r){ r=(r||'').toLowerCase(); if(r==='customer')return 'customer'; if(r==='vendor')return 'vendor'; return 'internal'; }
  function roleLabel(r){ var k=(r||'').toLowerCase(); var M={sales:'Sales',agent:'Sales',designer:'Designer',production:'Production',ve:'Production',vrm:'Production',pm:'PM',finance:'Finance',accounts:'Accounts',dispatcher:'Dispatcher',delivery:'Dispatcher',qc:'QC',tl:'Team Lead',customer:'Customer',vendor:'Vendor',admin:'Admin',manager:'Manager',salesmanager:'Sales Manager',system:'System'}; return M[k] || (r ? r.charAt(0).toUpperCase()+r.slice(1) : ''); }
  function fmt(ts){
    if(!ts) return '';
    var t = new Date(ts);
    var h = t.getHours(), m = t.getMinutes();
    var ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12; if(h === 0) h = 12;
    return h + ':' + ('0'+m).slice(-2) + ' ' + ampm;
  }
  function dayKey(ts){ var t=new Date(ts); return t.getFullYear()+'-'+t.getMonth()+'-'+t.getDate(); }
  function dayLabel(ts){ var t=new Date(ts), n=new Date(); var k=dayKey(ts); if(k===dayKey(n.getTime()))return 'Today'; n.setDate(n.getDate()-1); if(k===dayKey(n.getTime()))return 'Yesterday'; return t.toLocaleDateString(undefined,{day:'numeric',month:'short',year:'numeric'}); }
  function canSee(side,vid,aud){ if(aud==='all')return true; if(aud==='internal')return side==='internal'; if(aud==='customer')return side==='internal'||side==='customer'; if(aud&&aud.indexOf('vendor_')===0)return side==='internal'||(side==='vendor'&&String(vid)===aud.split('_')[1]); return false; }
  function timeAgo(ts){ return agoLong(ts); }
  function agoLong(ts){
    if(!ts) return '';
    var s = Math.floor((Date.now()-ts)/1000);
    if(s < 30)     return 'just now';
    if(s < 60)     return s + ' sec ago';
    var m = Math.floor(s/60);
    if(m < 60)     return m + (m===1 ? ' min ago'  : ' mins ago');
    var h = Math.floor(s/3600);
    if(h < 24)     return h + (h===1 ? ' hour ago' : ' hours ago');
    var dys = Math.floor(s/86400);
    if(dys < 30)   return dys + (dys===1 ? ' day ago' : ' days ago');
    var mo  = Math.floor(s/2592000);
    if(mo < 12)    return mo + (mo===1 ? ' month ago' : ' months ago');
    var yrs = Math.floor(s/31536000);
    return yrs + (yrs===1 ? ' year ago' : ' years ago');
  }

  /* ────── room key builder (mirrors firebaseService.buildThreadRoomId) ────── */
  function buildRoomId(t){
    if(!t||!t.threadType||!t.leadId)return '';
    switch(t.threadType){
      case 'customer':     return 'lead_'+t.leadId+'__customer';
      case 'task':         return 'lead_'+t.leadId+'__task_'+(t.taskId||0);
      case 'bid_internal': return 'lead_'+t.leadId+'__bid_'+(t.bidItemId||0)+'__internal';
      case 'bid_vendor':   return 'lead_'+t.leadId+'__bid_'+(t.bidItemId||0)+'__vendor_'+(t.vendorId||0);
      case 'job_vendor':   return 'lead_'+t.leadId+'__job_'+(t.taskId||0)+'__vendor_'+(t.vendorId||0);
    }
    return '';
  }

  function members(){ var a=[]; for(var k in S.members){ var m=S.members[k]||{}; a.push({uid:k,side:m.side,role:m.role,vendorId:m.vendorId,name:m.name}); } return a; }
  function membersSorted(){ var r={internal:0,customer:1,vendor:2}; return members().sort(function(a,b){return (r[a.side]||9)-(r[b.side]||9);}); }
  function displayName(m){ if(m.senderName)return m.senderName; if(S.members[m.senderId]&&S.members[m.senderId].name)return S.members[m.senderId].name; return roleLabel(m.senderRole)||m.senderId; }
  function vendorName(vid){ for(var k in S.members){ var m=S.members[k]; if(m.side==='vendor'&&String(m.vendorId)===String(vid))return m.name; } return 'vendor'; }
  function customerName(){ for(var k in S.members){ var m=S.members[k]; if(m.side==='customer')return m.name; } return 'the customer'; }
  function myVendorId(){ var m=S.members[S.uid]; return (m&&m.vendorId)?m.vendorId:''; }
  function allowedChannels(){
    if(S.side==='customer')return ['all','customer'];
    if(S.side==='vendor')return ['all','vendor_'+myVendorId()];
    var ch=['all','internal','customer'];
    for(var k in S.members){ var m=S.members[k]; if(m.side==='vendor'){ var c='vendor_'+m.vendorId; if(ch.indexOf(c)<0)ch.push(c); } }
    return ch;
  }
  function privacyOf(aud){
    // No lock when the message audience matches the room's default — it reaches every member of this room,
    // so there's nothing private about it. Lock only fires when someone picked a non-default audience.
    if(aud === defaultAudienceFor()) return {priv:false};
    if(aud==='all')return {priv:false};
    if(aud==='internal')return {priv:true,tip:'Team only'};
    if(aud==='customer')return {priv:true,tip:'Only the team & '+customerName()};
    if(aud&&aud.indexOf('vendor_')===0){ var n=vendorName(aud.split('_')[1]); return {priv:true,inline:'only '+n,tip:'Only the team & '+n}; }
    return {priv:false};
  }

  /* ════════════════════════  INIT / AUTH  ════════════════════════ */
  // Detect the SDK's own base URL from its script tag — so we can reference sibling files
  // (e.g. chat-ping.wav) without making every consumer pass the path explicitly.
  function detectSdkBase(){
    var scripts = d.querySelectorAll('script[src*="sec64-chat.js"]');
    if(!scripts.length) return '';
    var src = scripts[scripts.length - 1].src;
    var i = src.lastIndexOf('/');
    return i > -1 ? src.substring(0, i) : '';
  }

  function init(opts){
    opts = opts || {};
    S.opts = opts;
    S.sdkBase = detectSdkBase();
    S.tokenUrl         = opts.tokenUrl         || 'index.cfm?action=chat.firebaseLogin';
    S.ensureThreadUrl  = opts.ensureThreadUrl  || 'index.cfm?action=chat.ensureThread';
    S.inboxUrl         = opts.inboxUrl         || 'index.cfm?action=chat.inbox';
    S.searchUrl        = opts.searchUrl        || 'index.cfm?action=chat.searchEntities';
    S.uploadUrl        = opts.uploadUrl        || 'index.cfm?action=chat.upload';
    S.saveAttachUrl    = opts.saveAttachUrl    || 'index.cfm?action=chat.saveAttachments';
    S.addMemberUrl     = opts.addMemberUrl     || 'index.cfm?action=chat.addMember';
    S.userSearchUrl    = opts.userSearchUrl    || 'index.cfm?action=chat.searchUsers';
    // Open-entity URL templates — placeholders {leadId} {taskId} {bidItemId} {vendorId} {itemId} {customerId} get replaced.
    // Lead is common across all apps (CRM is the system of record). Tasks/bids/jobs default to sensible app URLs;
    // host pages can override any of these via Sec64Chat.init({ openUrls: { lead:'...', task:'...', bid:'...', job:'...' } }).
    var defaultOpenUrls = {
      lead:    'https://crm.64sec.com/index.cfm?action=leads.leadData&id={leadId}',
      task:    'https://crm.64sec.com/index.cfm?action=leads.leadData&id={leadId}',
      bid:     'https://prodadmin.64sec.com/index.cfm?action=orders.biddingEditForm&task_id={taskId}&item_id={itemId}&bid_item_id={bidItemId}',
      job:     'https://delivery.64sec.com/index.cfm?action=delivery.default&id={taskId}',
      customer:'https://crm.64sec.com/index.cfm?action=customers.detail&id={customerId}'
    };
    S.openUrls = Object.assign({}, defaultOpenUrls, opts.openUrls || {});
    // Default sound to the SDK-bundled chat-ping.wav (ships next to sec64-chat.js).
    // Consumers can override via opts.soundUrl, but auto-falling-back to the SDK file
    // means apps don't need to provision their own asset and we never 404.
    S.soundUrl = opts.soundUrl || (S.sdkBase ? S.sdkBase + '/chat-ping.wav' : '');
    S.mountBell       = opts.bell ? qs(opts.bell) : null;
    S.channelRefs     = [];
    S.inboxRef        = null;
    S.bellRef         = null;
    S.notifSeen       = {};
    S.notifPrimed     = false;
    S.deliveredCache  = {};                                 // roomId -> max lastTs we've reported as delivered (avoids redundant writes)
    try { S.muted = w.localStorage && localStorage.getItem('sec64chat:muted') === '1'; } catch(e){ S.muted = false; }
    S.chanCache       = {};
    S.members         = {};
    S.meta            = {};
    S.receipts        = {};
    S.pending         = [];
    S.inboxRows       = [];                                 // enriched rows from /chat.inbox
    S.inboxLive       = {};                                 // live overlay from userRooms/<uid> (lastMessage/lastTs/unread)
    S.inboxLoading    = false;                              // fetch in flight
    S.inboxLoadedOnce = false;                              // first fetch completed (success or fail)
    S.activeTab       = 'internal';                         // internal | customers | vendors
    S.collapsedGroups = {};                                 // map { 'tab::groupKey': true } — accordion state
    S.roomId          = null;
    S.built           = false;
    S.shellBuilt      = false;

    if(typeof w.firebase==='undefined'){ console.warn('[Sec64Chat] firebase SDK not loaded'); return; }

    // Initialize the notification audio + unlock listeners AT BOOT, not inside the bell.
    // Browsers block Audio.play() until the user gestures. Wiring the listeners as early as
    // possible means almost any later click/keypress will unlock — by the time a message arrives,
    // the audio element is decoded + unlocked.
    if(S.soundUrl) initAudio();

    ensureAuth().then(function(){
      if(S.mountBell) initBell();
      if(opts.fab !== false) initFab();                              // global floating chat icon (auto-mounts unless disabled)
      startButtonScanner();                                          // wire per-button unread badges (auto-discovers via data-chat-* attrs)
    }).catch(function(e){
      if(e&&e.notLoggedIn){ if(S.mountBell)S.mountBell.style.display='none'; console.warn('[Sec64Chat] no session — chat hidden'); return; }
      console.error('[Sec64Chat]',e);
    });
  }

  /* ════════════════════════  AUDIO (notification ping)
     Two layers:
       1. <audio> element with the configured soundUrl (mp3) — preferred
       2. Web Audio synth fallback — used when the file is 404 / decoded fails /
          autoplay blocks the element play(). No file dependency.
  ════════════════════════ */
  function initAudio(){
    // Layer 1: try the configured sound file. If it errors (404 or decode fail) and we haven't
    // tried the SDK-bundled chat-ping.wav yet, retry with that. Synth (Layer 2) is the final fallback.
    if(S.soundUrl){
      var triedFallback = false;
      var attempt = function(src){
        try {
          S.audio = new Audio();
          S.audio.preload = 'auto';
          S.audio.src     = src;
          S.audio.addEventListener('error', function(){
            var sdkFile = S.sdkBase ? S.sdkBase + '/chat-ping.wav' : '';
            if(!triedFallback && sdkFile && src !== sdkFile){
              triedFallback = true;
              console.warn('[Sec64Chat] sound failed ('+src+') — falling back to SDK-bundled', sdkFile);
              attempt(sdkFile);
            } else {
              console.warn('[Sec64Chat] sound unavailable — using synth ping');
              S.audio = null;
            }
          }, { once:true });
          try { S.audio.load(); } catch(e){}
        } catch(e) { S.audio = null; }
      };
      attempt(S.soundUrl);
    }

    // Layer 2: synth always available — no file required
    S.AudioCtxClass = w.AudioContext || w.webkitAudioContext || null;
    S.audioUnlocked = false;

    function unlock(){
      // Piggyback on the audio-unlock gesture: ask for Notification permission too if undecided.
      // Both the AudioContext unlock and Notification.requestPermission() require a user gesture, so
      // doing them in the same handler is the cleanest reliable moment.
      if('Notification' in w && Notification.permission === 'default'){
        try { Notification.requestPermission().catch(function(){}); } catch(e){}
      }
      if(S.audioUnlocked) return;
      // Unlock the <audio> element (muted play→pause→unmute pattern)
      if(S.audio){
        try {
          S.audio.muted = true;
          var p = S.audio.play();
          if (p && p.then) {
            p.then(function(){ S.audio.pause(); S.audio.currentTime = 0; S.audio.muted = false; })
             .catch(function(){ S.audio = null; /* file is unusable — synth will cover */ });
          }
        } catch(e){ S.audio = null; }
      }
      // Unlock / resume the AudioContext used by the synth fallback
      if(S.AudioCtxClass){
        try {
          if(!S.audioCtx) S.audioCtx = new S.AudioCtxClass();
          if(S.audioCtx.state === 'suspended') S.audioCtx.resume();
        } catch(e){}
      }
      S.audioUnlocked = true;
      d.removeEventListener('click',      unlock, true);
      d.removeEventListener('keydown',    unlock, true);
      d.removeEventListener('mousedown',  unlock, true);
      d.removeEventListener('touchstart', unlock, true);
    }
    d.addEventListener('click',      unlock, true);
    d.addEventListener('keydown',    unlock, true);
    d.addEventListener('mousedown',  unlock, true);
    d.addEventListener('touchstart', unlock, true);
  }

  function toggleMute(){
    S.muted = !S.muted;
    try { localStorage.setItem('sec64chat:muted', S.muted ? '1' : '0'); } catch(e){}
    updateMuteUI();
  }
  function updateMuteUI(){
    var iconHtml = '<i class="fa fa-volume-' + (S.muted ? 'mute' : 'up') + '"></i>';
    var tipText  = S.muted ? 'Notification sound is OFF — click to unmute' : 'Mute notification sound';
    // Title-bar mute icon (visible when overlay is open)
    if(S.overlay){
      var btn = S.overlay.querySelector('[data-act=mute]');
      if(btn){ btn.innerHTML = iconHtml; btn.title = tipText; btn.classList.toggle('muted', S.muted); }
    }
    // Global mute toggle next to the FAB (always accessible)
    if(S.fabMute){ S.fabMute.innerHTML = iconHtml; S.fabMute.title = tipText; S.fabMute.classList.toggle('muted', S.muted); }
    // Slash indicator on the FAB itself
    if(S.fabEl) S.fabEl.classList.toggle('muted', S.muted);
  }

  function playPing(){
    if(S.muted){ console.log('[Sec64Chat] ping skipped — muted'); return; }
    // Try the file first
    if(S.audio){
      try {
        S.audio.currentTime = 0;
        var p = S.audio.play();
        if(p && p.catch) p.catch(function(){ playSynthPing(); });   // autoplay blocked → fall back to synth
        return;
      } catch(e){ /* fall through to synth */ }
    }
    playSynthPing();
  }

  // Two-tone "ding-dong" chime synthesised with the Web Audio API.
  // ~300ms total. Pleasant + audible, no file dependency.
  function playSynthPing(){
    if(!S.AudioCtxClass) return;
    try {
      if(!S.audioCtx) S.audioCtx = new S.AudioCtxClass();
      var ctx = S.audioCtx;
      if(ctx.state === 'suspended'){ try { ctx.resume(); } catch(e){} }
      var now = ctx.currentTime;
      function tone(freq, start, dur, gain){
        var osc = ctx.createOscillator();
        var g   = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        g.gain.setValueAtTime(0.0001, start);
        g.gain.exponentialRampToValueAtTime(gain, start + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
        osc.connect(g); g.connect(ctx.destination);
        osc.start(start); osc.stop(start + dur + 0.02);
      }
      tone(880,  now,        0.16, 0.28);   // A5
      tone(1320, now + 0.10, 0.18, 0.22);   // E6  (perfect-fifth above A5)
    } catch(e){
      console.warn('[Sec64Chat] synth ping failed', e);
    }
  }

  /* ════════════════════════  PER-BUTTON UNREAD BADGES (auto-attach)
     Any element on the page that carries:
        data-chat-type   (customer | task | bid_internal | bid_vendor | job_vendor)
        data-chat-lead   (numeric leadId)
        data-chat-task   (optional — taskId)
        data-chat-bid    (optional — bidItemId)
        data-chat-vendor (optional — vendorId)
     ...will get a red unread badge appended inside it, kept live by a Firebase subscription
     on userRooms/<uid>/<roomId>/unread. Works for static + dynamically-rendered buttons
     (a MutationObserver re-scans on DOM changes).
  ════════════════════════ */
  function scanChatButtons(){
    if(!S.db || !S.uid) return;
    var nodes = d.querySelectorAll('[data-chat-type]:not([data-chat-bound])');
    Array.prototype.forEach.call(nodes, function(btn){
      btn.setAttribute('data-chat-bound', '1');
      var t = {
        threadType: btn.getAttribute('data-chat-type') || '',
        leadId:    +btn.getAttribute('data-chat-lead')   || 0,
        taskId:    +btn.getAttribute('data-chat-task')   || 0,
        bidItemId: +btn.getAttribute('data-chat-bid')    || 0,
        vendorId:  +btn.getAttribute('data-chat-vendor') || 0
      };
      var rid = buildRoomId(t);
      if(!rid) return;
      // Make sure the button is a containing block so the absolute badge anchors correctly
      var pos = w.getComputedStyle(btn).position;
      if(pos === 'static') btn.style.position = 'relative';
      btn.classList.add('sec64chat-has-badge');
      var badge = d.createElement('span');
      badge.className = 'sec64chat-btn-unread';
      badge.style.display = 'none';
      btn.appendChild(badge);
      S.db.ref('userRooms/'+S.uid+'/'+rid+'/unread').on('value', function(snap){
        var n = +snap.val() || 0;
        var prev = +badge.getAttribute('data-n') || 0;
        badge.textContent = n > 99 ? '99+' : n;
        badge.setAttribute('data-n', n);
        badge.style.display = n > 0 ? 'inline-flex' : 'none';
        if(n > prev){
          badge.classList.remove('pop');
          void badge.offsetWidth;
          badge.classList.add('pop');
        }
      });
    });
  }
  function startButtonScanner(){
    scanChatButtons();
    // Re-scan whenever DOM changes — covers AJAX-rendered tables, dispatch cards, etc.
    try {
      var obs = new w.MutationObserver(function(){ scanChatButtons(); });
      obs.observe(d.body, { childList:true, subtree:true });
      S.btnObserver = obs;
    } catch(e){ /* fall back to one-time scan only */ }
  }

  /* ════════════════════════  GLOBAL FLOATING CHAT FAB  ════════════════════════ */
  function initFab(){
    if(d.getElementById('sec64chat-fab')) return;                    // already mounted (idempotent)
    var fab = d.createElement('button');
    fab.id = 'sec64chat-fab';
    fab.type = 'button';
    fab.className = 'sec64chat-fab';
    fab.title = 'Open chats';
    fab.innerHTML = '<i class="fa fa-comments"></i><span class="sec64chat-fab-badge" style="display:none">0</span>';
    fab.onclick = function(e){ e.preventDefault(); open(); };
    d.body.appendChild(fab);
    S.fabEl    = fab;
    S.fabBadge = fab.querySelector('.sec64chat-fab-badge');
    S.fabMute  = null;                                               // global mute removed — toggle lives in the overlay title bar only
    updateMuteUI();                                                  // sync the FAB muted-slash indicator with persisted state
  }

  function updateFabBadge(n){
    if(!S.fabBadge) return;
    var prev = parseInt(S.fabBadge.getAttribute('data-n')||'0', 10);
    var labelN = n > 99 ? '99+' : String(n);
    S.fabBadge.textContent = labelN;
    S.fabBadge.setAttribute('data-n', String(n));
    S.fabBadge.style.display = n > 0 ? 'inline-flex' : 'none';
    if(n > prev && S.fabEl){
      // pulse-bounce the whole FAB; restart animation if it was already running
      S.fabEl.classList.remove('pulse');
      void S.fabEl.offsetWidth;                                      // force reflow
      S.fabEl.classList.add('pulse');
    }
  }

  function ensureAuth(){
    return fetch(S.tokenUrl,{credentials:'same-origin'}).then(function(r){return r.text();}).then(function(txt){
      var dd=null; try{ dd=JSON.parse(txt); }catch(e){}
      if(!dd||!dd.status||!dd.uid){ var err=new Error((dd&&dd.error)||'login required'); err.notLoggedIn=true; throw err; }
      S.uid=String(dd.uid); S.role=dd.role||''; S.name=dd.name||''; S.side=sideForRole(S.role);
      if(!w.firebase.apps.length) w.firebase.initializeApp(dd.config);
      S.db=w.firebase.database();
      S.TS = w.firebase.database.ServerValue.TIMESTAMP;
      if(w.firebase.auth().currentUser) return true;
      return w.firebase.auth().signInWithEmailAndPassword(dd.email,dd.password);
    });
  }

  /* ════════════════════════  BELL (top-nav)  ════════════════════════ */
  function initBell(){
    S.mountBell.style.display='';
    S.mountBell.innerHTML = '<button class="sec64chat-bellbtn" type="button" title="Chats"><i class="fa fa-comments"></i><span class="sec64chat-bellbadge" style="display:none">0</span></button>';
    var btn = S.mountBell.querySelector('.sec64chat-bellbtn');
    btn.onclick = function(e){ e.preventDefault(); open(); };

    var badge = S.mountBell.querySelector('.sec64chat-bellbadge');

    // (1) Badge count + FAB total — value listener on the whole list, recomputes every change.
    //     Also auto-reconciles: if a notification points to a room whose userRooms.unread is 0
    //     (orphan — usually from older buggy bumps), mark it read so the bell badge stays truthful.
    S.bellRef = S.db.ref('userNotifications/'+S.uid).limitToLast(50);
    S.bellRef.on('value', function(snap){
      var v = snap.val() || {}, unread = 0, reconcileUpdates = {};
      for(var k in v){
        var n = v[k];
        if(!n || n.isRead !== false) continue;
        // Orphan check — notification's room exists in inbox but has unread=0
        var live = n.roomId && S.inboxLive ? S.inboxLive[n.roomId] : null;
        if(live && (!live.unread || live.unread <= 0)){
          reconcileUpdates[k+'/isRead'] = true;                       // mark this orphan as read
          continue;                                                   // don't count it in the unread total
        }
        unread++;
      }
      badge.textContent = unread;
      badge.style.display = unread ? 'inline-block' : 'none';
      updateFabBadge(unread);
      if(Object.keys(reconcileUpdates).length){
        S.bellRef.update(reconcileUpdates).catch(function(){});
      }
    });

    // (2) Ping sound — child_added listener fires per individual notification.
    // Seed `initialKeys` from a one-shot read so the flood of existing entries doesn't ping;
    // only truly NEW notifications (added AFTER the seed) get the sound.
    var initialKeys = {};
    var primed = false;
    S.bellRef.once('value').then(function(snap){
      var v = snap.val() || {};
      for(var k in v) initialKeys[k] = true;
      primed = true;
    });
    S.bellRef.on('child_added', function(snap){
      if(!primed)               return;                                // initial flood — ignore until seed completes
      if(initialKeys[snap.key]) return;                                // already existed at seed time
      var n = snap.val() || {};
      if(n.isRead === true)     return;                                // already read elsewhere
      playPing();                                                      // shared S.audio (unlocked at init)

      // Skip if user is already looking at this room (overlay open + that room active) — nothing to alert about.
      var overlayOpen = S.overlay && S.overlay.classList.contains('open') && !S.overlay.classList.contains('minimized');
      if(overlayOpen && S.roomId && n.roomId === S.roomId) return;

      // OS-level desktop notification (in-app toast removed per request).
      fireNativeNotif({
        roomId:     n.roomId,
        message:    n.title || '',
        senderName: n.senderName || '',
        threadType: n.threadType || ''
      });
    });
  }

  /* ════════════════════════  DESKTOP / OS-LEVEL NOTIFICATIONS (Web Notifications API)
     Fires only when the browser tab is hidden — the in-app toast covers the visible case.
     Respects S.muted. Clicking the notification focuses the tab + opens the chat.
     No third-party dependency; pure browser API.
  ════════════════════════ */
  function fireNativeNotif(p){
    if(S.muted){                                console.log('[Sec64Chat] notif skipped — muted'); return; }
    if(!('Notification' in w)){                 console.warn('[Sec64Chat] notif unsupported in this browser'); return; }
    if(Notification.permission === 'denied'){   console.warn('[Sec64Chat] notif permission DENIED — re-enable in browser site settings'); return; }
    if(Notification.permission !== 'granted'){
      console.warn('[Sec64Chat] notif permission not granted yet (state='+Notification.permission+') — will request on next user click');
      return;
    }
    var leadId = 0;
    if(p.roomId){ var m = String(p.roomId).match(/^lead_(\d+)/); if(m) leadId = +m[1]; }
    var label = threadTypeLabel(p.threadType);
    var title = '64sec — ' + (leadId ? 'Lead #'+leadId : 'New message') + (label ? ' · '+label : '');
    var body  = (p.senderName ? p.senderName + ': ' : '') + (p.message || 'New message');
    try {
      var n = new Notification(title, {
        body: body,
        tag:  p.roomId || '',                         // collapse multiple from same room
        renotify: true,
        silent: true                                  // we already played our own ping
      });
      n.onclick = function(){
        try { w.focus(); } catch(e){}
        n.close();
        if(p.roomId){ open(); openRoom(p.roomId); }
      };
      setTimeout(function(){ try { n.close(); } catch(e){} }, 6000);
      console.log('[Sec64Chat] desktop notif shown:', title);
    } catch(e){ console.error('[Sec64Chat] notif failed', e); }
  }

  /* ════════════════════════  TOAST (push-style in-page notification)
     Custom 3-section single-row toast: Lead# | TYPE | message. Click to open chat. Auto-dismiss 3s.
  ════════════════════════ */
  function showToast(p){
    var stack = d.getElementById('sec64chat-toasts');
    if(!stack){
      stack = d.createElement('div');
      stack.id = 'sec64chat-toasts';
      stack.className = 'sec64chat-toasts';
      d.body.appendChild(stack);
    }

    var toast = d.createElement('div');
    toast.className = 'sec64chat-toast';
    var threadLabel = threadTypeLabel(p.threadType);
    var leadId = 0;
    if(p.roomId){ var m = String(p.roomId).match(/^lead_(\d+)/); if(m) leadId = +m[1]; }
    toast.innerHTML =
      (leadId ? '<span class="t-lead">Lead#'+leadId+'</span>' : '') +
      (threadLabel ? '<span class="t-thread">'+threadLabel+'</span>' : '') +
      '<span class="t-msg" title="'+esc(p.message||'')+'">'+esc(p.message||'New message')+'</span>' +
      '<div class="t-progress"></div>';

    toast.addEventListener('click', function(){
      if(p.roomId){ open(); openRoom(p.roomId); }
      dismissToast(toast);
    });

    stack.appendChild(toast);
    requestAnimationFrame(function(){ toast.classList.add('show'); });
    var hideTimer = setTimeout(function(){ dismissToast(toast); }, 3000);
    toast.addEventListener('mouseenter', function(){ clearTimeout(hideTimer); toast.classList.add('paused'); });
    toast.addEventListener('mouseleave', function(){
      toast.classList.remove('paused');
      hideTimer = setTimeout(function(){ dismissToast(toast); }, 1500);
    });

    while(stack.children.length > 4) dismissToast(stack.firstElementChild);
  }
  function dismissToast(toast){
    if(!toast || toast._dismissing) return;
    toast._dismissing = true;
    toast.classList.remove('show');
    toast.classList.add('hide');
    setTimeout(function(){ if(toast.parentNode) toast.parentNode.removeChild(toast); }, 280);
  }
  function threadTypeLabel(t){
    if(t === 'customer')     return 'Customer';
    if(t === 'task')         return 'Task';
    if(t === 'bid_internal') return 'Bid';
    if(t === 'bid_vendor')   return 'Bid · Vendor';
    if(t === 'job_vendor')   return 'Job · Vendor';
    return '';
  }

  /* ════════════════════════  OVERLAY (shell + drag)  ════════════════════════ */
  function buildShell(){
    if(S.shellBuilt) return;
    S.shellBuilt = true;

    var ov = el('div','sec64chat-overlay');
    ov.id = 'sec64chat-overlay';
    ov.innerHTML =
      '<div class="sec64chat-titlebar">' +
        '<i class="fa fa-comments tb-i"></i>' +
        '<button type="button" class="sec64chat-tb-btn tb-mute" data-act="mute" title="Mute notification sound"><i class="fa fa-volume-up"></i></button>' +
        '<span class="t">Chats</span>' +
        '<button type="button" class="sec64chat-tb-btn" data-act="min"  title="Minimize"><i class="fa fa-window-minimize"></i></button>' +
        '<button type="button" class="sec64chat-tb-btn" data-act="close" title="Close">&times;</button>' +
      '</div>' +
      '<div class="sec64chat-body">' +
        '<aside class="sec64chat-inbox">' +
          '<div class="sec64chat-search">' +
            '<i class="fa fa-search"></i>' +
            '<input type="text" placeholder="Search lead, task, bid, job, customer, vendor…">' +
            '<div class="sec64chat-search-dd" style="display:none"></div>' +
          '</div>' +
          '<div class="sec64chat-tabs">' +
            '<button type="button" data-tab="internal"  class="active"><i class="fa fa-users"></i> Internal</button>' +
            '<button type="button" data-tab="customers"><i class="fa fa-user-tie"></i> Customers</button>' +
            '<button type="button" data-tab="vendors"><i class="fa fa-industry"></i> Vendors</button>' +
          '</div>' +
          '<div class="sec64chat-roomlist"></div>' +
        '</aside>' +
        '<section class="sec64chat-thread">' +
          '<div class="sec64chat-empty"><i class="fa fa-comments fa-2x"></i><div>Select a chat to start messaging</div></div>' +
        '</section>' +
      '</div>';
    d.body.appendChild(ov);
    S.overlay = ov;
    S.elBar       = ov.querySelector('.sec64chat-titlebar');
    S.elTitle     = ov.querySelector('.sec64chat-titlebar .t');
    S.elInbox     = ov.querySelector('.sec64chat-inbox');
    S.elInboxList = ov.querySelector('.sec64chat-roomlist');
    S.elSearch    = ov.querySelector('.sec64chat-search input');
    S.elSearchDD  = ov.querySelector('.sec64chat-search-dd');
    S.elTabs      = ov.querySelector('.sec64chat-tabs');
    S.mountThread = ov.querySelector('.sec64chat-thread');

    ov.querySelector('[data-act=close]').onclick = function(e){ e.stopPropagation(); close(); };
    ov.querySelector('[data-act=min]').onclick   = function(e){ e.stopPropagation(); ov.classList.toggle('minimized'); };
    ov.querySelector('[data-act=mute]').onclick  = function(e){ e.stopPropagation(); toggleMute(); };
    updateMuteUI();
    initSearchDropdown();
    Array.prototype.forEach.call(S.elTabs.querySelectorAll('button[data-tab]'), function(b){
      b.addEventListener('click', function(){
        S.activeTab = b.getAttribute('data-tab');
        Array.prototype.forEach.call(S.elTabs.querySelectorAll('button'), function(x){ x.classList.toggle('active', x===b); });
        renderInbox();
      });
    });
    makeDraggable(ov, S.elBar);

    subscribeInbox();
  }

  function makeDraggable(panel, handle){
    var sx=0, sy=0, ox=0, oy=0, dragging=false;
    handle.addEventListener('mousedown', function(e){
      if(e.target.closest('button')) return;     // don't drag when clicking buttons
      dragging = true;
      sx=e.clientX; sy=e.clientY;
      var r=panel.getBoundingClientRect();
      ox=r.left; oy=r.top;
      panel.classList.add('dragging');
      e.preventDefault();
    });
    d.addEventListener('mousemove', function(e){
      if(!dragging) return;
      var nx = Math.max(0, Math.min(w.innerWidth  - panel.offsetWidth,  ox + e.clientX - sx));
      var ny = Math.max(0, Math.min(w.innerHeight - panel.offsetHeight, oy + e.clientY - sy));
      panel.style.left   = nx + 'px';
      panel.style.top    = ny + 'px';
      panel.style.right  = 'auto';
      panel.style.bottom = 'auto';
    });
    d.addEventListener('mouseup', function(){ if(dragging){ dragging=false; panel.classList.remove('dragging'); } });
  }

  /* ════════════════════════  OPEN / CLOSE  ════════════════════════ */
  function open(){
    if(!S.uid){ console.warn('[Sec64Chat] not authed yet'); return; }
    buildShell();
    S.overlay.classList.add('open');
    S.overlay.classList.remove('minimized');
    startTimeTicker();
    // If a room was already selected (e.g. from a row click that beat the open()
    // race, or from a previous session before close), make sure it's fully loaded —
    // not just visually highlighted in the inbox.
    if(S.roomId && !S.built) openRoom(S.roomId);
  }
  function close(){
    if(!S.overlay) return;
    S.overlay.classList.remove('open','minimized');
    stopTimeTicker();
    detachRoom();
    if(S.mountThread) S.mountThread.innerHTML = '<div class="sec64chat-empty"><i class="fa fa-comments fa-2x"></i><div>Select a chat to start messaging</div></div>';
    // Keep S.roomId so the next open() auto-restores the last chat.
    // (Clear only on explicit re-selection via a different room.)
  }

  /* update every "X mins ago" / "X hours ago" timestamp every minute while overlay is open */
  function startTimeTicker(){
    if(S.timeTicker) return;
    S.timeTicker = setInterval(function(){
      if(!S.overlay || !S.overlay.classList.contains('open')) return;
      Array.prototype.forEach.call(S.overlay.querySelectorAll('[data-ts]'), function(el){
        var ts = +el.getAttribute('data-ts');
        if(!ts) return;
        el.textContent = agoLong(ts);
      });
    }, 30000);                                              // every 30s — keeps the "just now → 1 min ago" transition snappy
  }
  function stopTimeTicker(){
    if(S.timeTicker){ clearInterval(S.timeTicker); S.timeTicker = null; }
  }

  function openThread(t){
    if(!t || !t.threadType || !t.leadId){ console.warn('[Sec64Chat] openThread needs {threadType, leadId, ...}'); return; }
    if(!S.uid){ console.warn('[Sec64Chat] not authed yet'); return; }
    open();
    setActiveTab(tabForThreadType(t.threadType));      // jump to the right tab before any room check
    var rid = buildRoomId(t);
    if(!rid){ return; }
    // Check Firebase directly — does the room already exist?
    S.db.ref('chatRooms/'+rid+'/meta').once('value').then(function(snap){
      if(snap.exists()){
        openRoom(rid);
      } else {
        showBeginChat(t, rid);
      }
    }).catch(function(e){ console.error('[Sec64Chat] room check failed',e); });
  }

  /* ════════════════════════  BEGIN CHAT (room missing)  ════════════════════════ */
  function showBeginChat(t, rid){
    detachRoom();
    if(!S.mountThread) return;
    var title = 'New conversation';
    if(t.threadType==='customer')     title = 'Customer chat — Lead '+t.leadId;
    if(t.threadType==='task')         title = 'Task #'+t.taskId+' — Lead '+t.leadId;
    if(t.threadType==='bid_internal') title = 'Bid #'+t.bidItemId+' (internal)';
    if(t.threadType==='bid_vendor')   title = 'Bid #'+t.bidItemId+' — vendor';
    if(t.threadType==='job_vendor')   title = 'Job #'+t.taskId+' — vendor';
    if(S.elTitle) S.elTitle.textContent = title;

    S.mountThread.innerHTML =
      '<div class="sec64chat-begin">' +
        '<i class="fa fa-comments-o"></i>' +
        '<h4>'+esc(title)+'</h4>' +
        '<p>This chat hasn\'t been started yet.</p>' +
        '<button type="button" class="sec64chat-btn-begin"><i class="fa fa-plus"></i> Begin Chat</button>' +
      '</div>';
    S.mountThread.querySelector('.sec64chat-btn-begin').onclick = function(){
      var btn = this;
      btn.disabled = true;
      btn.innerHTML = '<i class="fa fa-spinner fa-spin"></i> Creating…';
      var qs='&threadType='+encodeURIComponent(t.threadType)
           +'&lead_id='+encodeURIComponent(t.leadId)
           +'&task_id='+encodeURIComponent(t.taskId||0)
           +'&bid_item_id='+encodeURIComponent(t.bidItemId||0)
           +'&vendor_id='+encodeURIComponent(t.vendorId||0);
      fetch(S.ensureThreadUrl+qs,{credentials:'same-origin'}).then(function(r){return r.json();}).then(function(res){
        if(!res||!(res.status||res.STATUS)){ btn.disabled=false; btn.innerHTML='Retry'; alert('Failed to create chat: '+((res&&(res.error||res.ERROR))||'unknown error')); return; }
        S.justCreatedRoom = res.roomId || res.ROOMID;       // flag for flash highlight on next render
        setActiveTab(tabForThreadType(t.threadType));       // jump to the tab where this new room belongs
        openRoom(S.justCreatedRoom);
        fetchInbox();                                       // re-pull enriched inbox so the new row appears in its tab
      }).catch(function(){ btn.disabled=false; btn.innerHTML='Retry'; });
    };
  }

  /* ════════════════════════  OPEN ROOM (subscribe)  ════════════════════════ */
  function detachRoom(){
    (S.channelRefs||[]).forEach(function(x){ try{ x.ref.off('value',x.cb); }catch(e){} });
    S.channelRefs = [];
    S.chanCache = {};
    S.built = false;
  }

  function parseRoomIdForType(rid){
    if(/^lead_\d+__customer$/.test(rid))                  return 'customer';
    if(/^lead_\d+__task_\d+$/.test(rid))                  return 'task';
    if(/^lead_\d+__bid_\d+__internal$/.test(rid))         return 'bid_internal';
    if(/^lead_\d+__bid_\d+__vendor_\d+$/.test(rid))       return 'bid_vendor';
    if(/^lead_\d+__job_\d+__vendor_\d+$/.test(rid))       return 'job_vendor';
    return '';
  }

  function openRoom(roomId){
    if(!roomId) return;
    // whichever flow brought us here, snap to the tab this room belongs to
    var tt = parseRoomIdForType(roomId);
    if(tt) setActiveTab(tabForThreadType(tt));

    detachRoom();
    if(S.mountThread) S.mountThread.innerHTML = '<div class="sec64chat-empty">Loading…</div>';
    S.roomId = roomId;
    S.lastReadSent = 0;
    S.scopeMode = 'related';                                          // narrow inbox to this lead's rooms
    // Fresh room = fresh engagement requirement. Until user clicks/types in the input,
    // new messages will accumulate the unread badge.
    if(S.engagedRooms) delete S.engagedRooms[roomId];

    var ref = S.db.ref('chatRooms/'+roomId);
    var cb = ref.on('value', function(snap){
      var v = snap.val() || {};
      S.meta    = v.meta    || {};
      S.members = v.members || {};
      if(!S.built){
        S.built = true;
        buildThreadShell();
        subscribeChannels();
        subscribeReceipts();
      } else {
        renderHeader();
        renderThread();
      }
    });
    S.channelRefs.push({ref:ref,cb:cb});
    // mark active in inbox
    renderInbox();
    // Bell notifs for this room are NOT cleared here — they clear when the user engages
    // with the input (markRoomEngaged), matching the inbox-unread reset behaviour.
  }

  function subscribeChannels(){
    allowedChannels().forEach(function(ch){
      var ref = S.db.ref('chatMessages/'+S.roomId+'/'+ch);
      var cb = ref.on('value', function(s){ S.chanCache[ch]=s.val()||{}; renderThread(); });
      S.channelRefs.push({ref:ref,cb:cb});
    });
  }
  function subscribeReceipts(){
    var ref = S.db.ref('receipts/'+S.roomId);
    var cb = ref.on('value', function(s){ S.receipts = s.val()||{}; renderTicks(); });
    S.channelRefs.push({ref:ref,cb:cb});
  }
  function allMessages(){
    var a=[];
    for(var ch in S.chanCache){ var n=S.chanCache[ch]; for(var k in n){ var m=n[k]; m._id=k; m._ch=ch; a.push(m); } }
    a.sort(function(x,y){return (x.ts||0)-(y.ts||0);});
    return a;
  }

  /* ════════════════════════  THREAD UI  ════════════════════════ */
  function buildThreadShell(){
    if(!S.mountThread) return;
    S.mountThread.innerHTML = '';
    var hd = el('div','sec64chat-hd'); S.elHd = hd; renderHeader();
    var list = el('div','sec64chat-list'); S.elList = list;
    var chips = el('div','sec64chat-chips'); S.elChips = chips;

    // hidden audience input — value is auto-set from thread type. (UI dropdown removed per design.)
    S.elAud = el('input'); S.elAud.type='hidden'; S.elAud.value = defaultAudienceFor();

    var comp = el('div','sec64chat-composer');
    var wrap = el('div','sec64chat-inputwrap'); S.elInputwrap = wrap;
    var att = el('button','sec64chat-ic'); att.type='button'; att.id='sec64chat-attach'; att.title='Attach files'; att.innerHTML='<i class="fa fa-paperclip"></i>';
    var inp = el('input','sec64chat-input'); inp.type='text'; inp.placeholder='Type a message…'; S.elInput=inp;
    // Active-engagement reset: clear unread badge only when the user clicks the input or starts typing.
    // Idempotent per room session — won't keep writing zeros on every keystroke.
    inp.addEventListener('focus',   markRoomEngaged);
    inp.addEventListener('keydown', markRoomEngaged);
    inp.addEventListener('mousedown', markRoomEngaged);                // covers "already focused → click again"
    var voice = el('button','sec64chat-ic'); voice.type='button'; voice.title='Record voice message'; voice.innerHTML='<i class="fa fa-microphone"></i>'; voice.onclick = function(){ startVoiceRec(); };
    wrap.appendChild(att); wrap.appendChild(inp); wrap.appendChild(voice);
    var send = el('button','sec64chat-send'); send.type='button'; send.innerHTML='<i class="fa fa-paper-plane"></i>'; send.onclick = doSend; S.elSendBtn = send;
    comp.appendChild(wrap); comp.appendChild(send); comp.appendChild(S.elAud);

    // ---- WhatsApp-style voice recorder + preview (hidden by default) ----
    var BAR_COUNT = 32;
    var barsHtml = ''; for(var i=0;i<BAR_COUNT;i++) barsHtml += '<span class="vb"></span>';
    var voiceRec = el('div','sec64chat-voice-rec');
    voiceRec.innerHTML =
      '<button type="button" class="vr-btn vr-cancel" title="Cancel"><i class="fa fa-trash"></i></button>' +
      '<div class="vr-dot"></div>' +
      '<div class="vr-bars">'+barsHtml+'</div>' +
      '<div class="vr-time">0:00</div>' +
      '<button type="button" class="vr-btn vr-stop" title="Stop"><i class="fa fa-stop"></i></button>';
    voiceRec.style.display = 'none';
    S.elVoiceRec = voiceRec;

    var voicePrev = el('div','sec64chat-voice-prev');
    voicePrev.innerHTML =
      '<button type="button" class="vr-btn vr-discard" title="Discard"><i class="fa fa-trash"></i></button>' +
      '<button type="button" class="vr-btn vr-play"    title="Play"><i class="fa fa-play"></i></button>' +
      '<div class="vr-bars vr-bars-static">'+barsHtml+'</div>' +
      '<div class="vr-time">0:00</div>' +
      '<button type="button" class="vr-btn vr-send"    title="Send"><i class="fa fa-paper-plane"></i></button>';
    voicePrev.style.display = 'none';
    S.elVoicePrev = voicePrev;

    comp.appendChild(voiceRec); comp.appendChild(voicePrev);

    voiceRec.querySelector('.vr-cancel').onclick = function(){ cancelVoice(); };
    voiceRec.querySelector('.vr-stop').onclick   = function(){ stopVoiceRec(); };
    voicePrev.querySelector('.vr-discard').onclick = function(){ discardVoicePreview(); };
    voicePrev.querySelector('.vr-play').onclick    = function(){ togglePlayPreview(); };
    voicePrev.querySelector('.vr-send').onclick    = function(){ sendVoiceMessage(); };

    // drag-and-drop overlay (WhatsApp-style)
    var dropOv = el('div','sec64chat-dropover');
    dropOv.innerHTML = '<div class="dropover-box"><i class="fa fa-cloud-upload-alt"></i><div>Drop files here to attach</div></div>';

    S.mountThread.appendChild(hd);
    S.mountThread.appendChild(list);
    S.mountThread.appendChild(chips);
    S.mountThread.appendChild(comp);
    S.mountThread.appendChild(dropOv);

    inp.addEventListener('keydown', function(e){ if(e.key==='Enter') doSend(); });
    S.pending = [];

    // visual drag-over feedback (plupload handles the actual file processing via drop_element)
    var dragCnt = 0;
    function hasFiles(e){
      if(!e.dataTransfer || !e.dataTransfer.types) return false;
      var t = e.dataTransfer.types;
      for(var i=0;i<t.length;i++){ if(t[i]==='Files') return true; }
      return false;
    }
    S.mountThread.addEventListener('dragenter', function(e){
      if(!hasFiles(e)) return;
      e.preventDefault(); dragCnt++; S.mountThread.classList.add('dragover');
    });
    S.mountThread.addEventListener('dragover',  function(e){ if(hasFiles(e)) e.preventDefault(); });
    S.mountThread.addEventListener('dragleave', function(){ dragCnt--; if(dragCnt<=0){ dragCnt=0; S.mountThread.classList.remove('dragover'); } });
    S.mountThread.addEventListener('drop',      function(){ dragCnt=0; S.mountThread.classList.remove('dragover'); });

    // init plupload — buttons stay visible even if plupload is still loading; init retries
    initUploader(att, voice);
  }

  function initUploader(attBtn, voiceBtn){
    var tries = 0;
    (function tick(){
      if (w.Sec64Upload && w.plupload) {
        try{
          Sec64Upload.clear();
          Sec64Upload.init({
            browseButton: '#sec64chat-attach',
            dropArea:     S.mountThread,
            url:          uploadUrlForRoom(),
            onAdded:      function(){ renderChips(); },
            onProgress:   function(){ renderChips(); },
            onUploaded:   function(){ renderChips(); },
            onError:      function(it, err){ console.warn('[upload]',err); renderChips(); }
          });
        }catch(e){ console.warn('[Sec64Chat] upload init failed',e); }
        return;
      }
      if(++tries > 40) return;   // ~8s ceiling
      setTimeout(tick, 200);
    })();
  }

  // upload URL includes lead/task/item ids so the server can insert tasks_attachments correctly
  function uploadUrlForRoom(){
    var base = S.uploadUrl || 'index.cfm?action=chat.upload';
    return base
      + (base.indexOf('?')>-1 ? '&' : '?')
      + 'lead_id='  + ( S.meta.leadId    || 0 )
      + '&task_id=' + ( S.meta.taskId    || 0 )
      + '&item_id=' + ( S.meta.bidItemId || 0 );
  }

  // Default audience for every send. Each room already has the right membership (vendors are isolated by
  // room, not by audience-channel), so 'all' means "every member of this room sees this message" — no risk
  // of someone added to the group missing messages because of audience-channel filtering.
  function defaultAudienceFor(){ return 'all'; }

  function renderHeader(){
    if(!S.elHd) return;
    var ms = membersSorted();
    var chips = ms.length
      ? ms.map(function(m){ return '<span class="sec64chat-mchip" title="'+esc(roleLabel(m.role))+'">'+avatar(m.name,20)+'<span class="mn">'+esc(m.name||m.uid)+'</span></span>'; }).join('')
      : '<span class="sec64chat-mt">No participants yet</span>';
    var canAddBtn = canManageMembers() ? '<button type="button" class="sec64chat-addmember-btn" title="Add user"><i class="fa fa-user-plus"></i></button>' : '';
    var ctxHtml   = buildContextStrip();
    var custTitle = '';
    var ibx = findInboxRow();
    if(ibx && (ibx.threadType === 'task' || ibx.threadType === 'bid_internal') && ibx.customerName){
      custTitle = '<span class="sec64chat-title-cust" title="Customer"><i class="fa fa-user"></i>'+esc(ibx.customerName)+'</span>';
    }
    // "Open Lead / Open Task / Open Bid / Open Job" deep-links — derived from threadType + ids,
    // open in a new tab via target="_blank". Templates configurable via opts.openUrls.
    var openLinks = buildOpenLinks(ibx);
    S.elHd.innerHTML =
      '<div class="sec64chat-title-row">' +
        '<div class="sec64chat-title">' +
          esc(S.meta.title||S.roomId) +
          custTitle +
          '<span class="cnt">'+ms.length+' participant'+(ms.length===1?'':'s')+'</span>' +
        '</div>' +
        openLinks +
        canAddBtn +
      '</div>' +
      '<div class="sec64chat-members">'+chips+'</div>' +
      (ctxHtml ? '<div class="sec64chat-ctx">'+ctxHtml+'</div>' : '');
    if(S.elTitle) S.elTitle.textContent = S.meta.title || S.roomId;
    var addBtn = S.elHd.querySelector('.sec64chat-addmember-btn');
    if(addBtn) addBtn.onclick = function(e){ e.stopPropagation(); openAddMemberPopover(addBtn); };
    updateMembershipUI();
  }
  function findInboxRow(){
    if(!S.roomId || !S.inboxRows) return null;
    for(var i=0; i<S.inboxRows.length; i++){ if(S.inboxRows[i].roomId === S.roomId) return S.inboxRows[i]; }
    return null;
  }

  function fillUrl(tpl, p){
    return tpl.replace(/\{(\w+)\}/g, function(_, k){ return (p[k] == null ? '' : encodeURIComponent(p[k])); });
  }
  // Build the small "Open Lead / Open Task / Open Bid / Open Job" link cluster shown in the title row.
  // Driven by the open room's threadType + the ids surfaced via the inbox row.
  function buildOpenLinks(r){
    if(!r) return '';
    var t  = r.threadType || '';
    var p  = { leadId:r.leadId, taskId:r.taskId, bidItemId:r.bidItemId, vendorId:r.vendorId, itemId:r.itemId||0, customerId:r.customerId||0 };
    var ou = S.openUrls || {};
    var items = [];
    function link(label, icon, url){
      if(!url) return;
      items.push('<a class="sec64chat-open-link" href="'+esc(url)+'" target="_blank" rel="noopener" title="'+esc(label)+'"><i class="fa '+icon+'"></i><span>'+esc(label)+'</span></a>');
    }
    if(p.leadId) link('Lead', 'fa-tag', ou.lead ? fillUrl(ou.lead, p) : '');
    if(t === 'task' && p.taskId)                                    link('Task', 'fa-tasks',   ou.task ? fillUrl(ou.task, p) : '');
    if((t === 'bid_internal' || t === 'bid_vendor') && p.bidItemId) link('Bid',  'fa-gavel',   ou.bid  ? fillUrl(ou.bid,  p) : '');
    if(t === 'job_vendor' && p.taskId)                              link('Job',  'fa-truck',   ou.job  ? fillUrl(ou.job,  p) : '');
    return items.length ? '<div class="sec64chat-open-links">' + items.join('') + '</div>' : '';
  }

  // Build a "who/what/when" context strip from the inbox row for the current room.
  // Inbox already enriches with createdByName/assignedToName/agentName/customerName/vendorName/timestamps.
  function buildContextStrip(){
    if(!S.roomId || !S.inboxRows) return '';
    var r = null;
    for(var i=0; i<S.inboxRows.length; i++){ if(S.inboxRows[i].roomId === S.roomId){ r = S.inboxRows[i]; break; } }
    if(!r) return '';
    var parts = [];
    function pill(icon, label, value, tone){
      if(!value) return '';
      var cls = tone ? ' tone-'+tone : '';
      return '<span class="ctx-pill'+cls+'"><i class="fa '+icon+'"></i><span class="ctx-l">'+label+'</span> <b>'+esc(value)+'</b></span>';
    }
    if(r.threadType === 'task' || r.threadType === 'bid_internal'){
      // Internal threads — keep it strictly internal context (no customer / vendor pills).
      parts.push(pill('fa-user-edit',  'Created by',  r.createdByName, 'sales'));
      parts.push(pill('fa-user-check', 'Assigned to', r.assignedToName, 'assignee'));
      if(r.taskCreatedAt || r.bidCreatedAt){
        parts.push(pill('fa-clock', (r.threadType==='task'?'Task':'Bid')+' created', ago(r.taskCreatedAt||r.bidCreatedAt), 'time'));
      }
    } else if(r.threadType === 'customer'){
      parts.push(pill('fa-user',       'Customer', r.customerName, 'cust'));
      parts.push(pill('fa-user-check', 'Sales',    r.agentName, 'sales'));
      if(r.leadCreatedAt) parts.push(pill('fa-clock', 'Lead created', ago(r.leadCreatedAt), 'time'));
    } else if(r.threadType === 'bid_vendor' || r.threadType === 'job_vendor'){
      // Vendor threads — the vendor IS the counterparty so show it; skip customer (not relevant to vendor).
      parts.push(pill('fa-industry',   'Vendor',     r.vendorName, 'vendor'));
      parts.push(pill('fa-user-edit',  'Created by', r.createdByName, 'sales'));
      if(r.taskCreatedAt || r.bidCreatedAt){
        parts.push(pill('fa-clock', (r.threadType==='bid_vendor'?'Bid':'Job')+' created', ago(r.taskCreatedAt||r.bidCreatedAt), 'time'));
      }
    }
    return parts.filter(Boolean).join('');
  }

  function canManageMembers(){
    if((S.role||'').toLowerCase() === 'admin') return true;
    return S.members && S.members[S.uid] && S.members[S.uid].side === 'internal';
  }
  function isCurrentUserMember(){ return !!(S.members && S.members[S.uid]); }
  function isCurrentUserAdmin(){  return (S.role||'').toLowerCase() === 'admin'; }

  // banner above the message list when current user isn't in the room — gates the composer
  function updateMembershipUI(){
    if(!S.mountThread) return;
    var banner = S.elJoinBanner;
    if(!banner){
      banner = el('div','sec64chat-join-banner');
      banner.style.display = 'none';
      S.elJoinBanner = banner;
      // insert right after the header
      if(S.elHd && S.elHd.parentNode) S.elHd.parentNode.insertBefore(banner, S.elHd.nextSibling);
    }
    var composer = S.mountThread.querySelector('.sec64chat-composer');
    if(isCurrentUserMember()){
      banner.style.display = 'none';
      if(composer) composer.style.display = '';
    } else if(isCurrentUserAdmin()){
      banner.style.display = '';
      banner.innerHTML = '<i class="fa fa-shield-alt"></i><span>You\'re not a member of this chat — join to send messages.</span><button type="button" class="sec64chat-join-btn"><i class="fa fa-plus"></i> Join chat</button>';
      var jb = banner.querySelector('.sec64chat-join-btn');
      if(jb) jb.onclick = function(){
        jb.disabled = true; jb.innerHTML = '<i class="fa fa-spinner fa-spin"></i> Joining…';
        addMemberToRoom(S.uid, function(ok, err){
          if(!ok){ alert('Failed to join: ' + (err||'unknown')); jb.disabled = false; jb.innerHTML = '<i class="fa fa-plus"></i> Join chat'; }
          // on success, the room snapshot subscription updates S.members and updateMembershipUI runs again
        });
      };
      if(composer) composer.style.display = 'none';
    } else {
      banner.style.display = '';
      banner.innerHTML = '<i class="fa fa-eye"></i><span>View-only — you are not a member of this chat.</span>';
      if(composer) composer.style.display = 'none';
    }
  }

  function addMemberToRoom(userId, cb){
    var fd = new FormData();
    fd.append('roomId',  S.roomId);
    fd.append('user_id', userId);
    fetch(S.addMemberUrl, { method:'POST', credentials:'same-origin', body: fd })
      .then(function(r){ return r.json(); })
      .then(function(res){
        if(res && (res.status||res.STATUS)){ if(cb) cb(true); }
        else { if(cb) cb(false, (res && (res.error||res.ERROR)) || 'add failed'); }
      })
      .catch(function(e){ if(cb) cb(false, e && e.message || 'network error'); });
  }

  /* ───── add-user popover (search + click to add) ───── */
  function openAddMemberPopover(anchorBtn){
    closeAddMemberPopover();
    var pop = el('div','sec64chat-addmember-pop');
    pop.innerHTML =
      '<div class="amp-h">Add a user</div>' +
      '<div class="amp-search"><i class="fa fa-search"></i><input type="text" placeholder="Search by name, email or role…" autofocus></div>' +
      '<div class="amp-results"></div>';
    d.body.appendChild(pop);
    S.elAddPop = pop;
    var rect = anchorBtn.getBoundingClientRect();
    pop.style.left = Math.min(w.innerWidth - 340, rect.left) + 'px';
    pop.style.top  = (rect.bottom + 4) + 'px';

    var inp = pop.querySelector('input');
    var res = pop.querySelector('.amp-results');
    var dt; var lastQ='';
    function run(){
      var q = inp.value.trim();
      lastQ = q;
      var excl = [];
      for(var k in (S.members||{})){ excl.push(k); }
      res.innerHTML = '<div class="amp-loading"><i class="fa fa-spinner fa-spin"></i> Searching…</div>';
      fetch(S.userSearchUrl + '&q=' + encodeURIComponent(q) + '&exclude=' + encodeURIComponent(excl.join(',')), { credentials:'same-origin' })
        .then(function(r){ return r.json(); })
        .then(function(data){
          if(lastQ !== q) return;
          var users = (data && (data.users || data.USERS)) || [];
          if(!users.length){ res.innerHTML = '<div class="amp-empty">No matching users</div>'; return; }
          res.innerHTML = users.map(function(u){
            var id   = u.id || u.ID;
            var name = u.username || u.USERNAME || '';
            var role = u.auth     || u.AUTH     || '';
            return '<div class="amp-row" data-uid="'+esc(id)+'">' +
                avatar(name, 28) +
                '<div class="amp-col"><div class="amp-n">'+esc(name)+'</div><div class="amp-r">'+esc(roleLabel(role))+'</div></div>' +
                '<button type="button" class="amp-add" title="Add"><i class="fa fa-plus"></i></button>' +
              '</div>';
          }).join('');
          Array.prototype.forEach.call(res.querySelectorAll('.amp-row'), function(row){
            row.onclick = function(){
              var uid = row.getAttribute('data-uid');
              var btn = row.querySelector('.amp-add');
              btn.disabled = true; btn.innerHTML = '<i class="fa fa-spinner fa-spin"></i>';
              addMemberToRoom(uid, function(ok, err){
                if(ok){ btn.innerHTML = '<i class="fa fa-check"></i>'; setTimeout(function(){ row.remove(); if(!res.querySelector('.amp-row')) res.innerHTML='<div class="amp-empty">No matching users</div>'; }, 600); }
                else { alert('Failed to add: '+(err||'unknown')); btn.disabled = false; btn.innerHTML = '<i class="fa fa-plus"></i>'; }
              });
            };
          });
        })
        .catch(function(){ if(lastQ===q) res.innerHTML = '<div class="amp-empty">Search failed</div>'; });
    }
    inp.addEventListener('input', function(){ clearTimeout(dt); dt = setTimeout(run, 220); });
    inp.addEventListener('keydown', function(e){ if(e.key === 'Escape') closeAddMemberPopover(); });
    setTimeout(function(){ inp.focus(); run(); }, 0);
    // click outside closes
    setTimeout(function(){
      d.addEventListener('mousedown', closeAddOnOutside, true);
    }, 50);
  }
  function closeAddOnOutside(e){
    if(!S.elAddPop) return;
    if(S.elAddPop.contains(e.target)) return;
    if(e.target.closest && e.target.closest('.sec64chat-addmember-btn')) return;
    closeAddMemberPopover();
  }
  function closeAddMemberPopover(){
    if(S.elAddPop){ try{ S.elAddPop.remove(); }catch(e){} S.elAddPop = null; }
    d.removeEventListener('mousedown', closeAddOnOutside, true);
  }

  function audSelect(){
    var sel = el('select','sec64chat-aud'); S.elAud = sel; var opts = [];
    if(S.side==='internal'){
      opts.push(['all','Everyone']); opts.push(['internal','Team only']);
      membersSorted().forEach(function(m){
        if(m.side==='customer') opts.push(['customer', m.name]);
        else if(m.side==='vendor') opts.push(['vendor_'+m.vendorId, m.name]);
      });
    } else if(S.side==='customer'){ opts.push(['customer','Send']); }
    else { opts.push(['vendor_'+myVendorId(),'Send']); }
    opts.forEach(function(o){ var op=el('option'); op.value=o[0]; op.textContent=o[1]; sel.appendChild(op); });
    var wrap = el('div','sec64chat-to','<span>To</span>'); wrap.appendChild(sel); return wrap;
  }

  function renderThread(){
    if(!S.elList) return;
    var msgs = allMessages(); S.elList.innerHTML = '';
    var prevDay = '', prev = null;
    msgs.forEach(function(m){
      var dk = dayKey(m.ts||0);
      if(dk!==prevDay){ S.elList.appendChild(el('div','sec64chat-day',esc(dayLabel(m.ts||0)))); prevDay=dk; prev=null; }
      if(m.type==='system'){ S.elList.appendChild(el('div','sec64chat-system',esc(m.text))); prev=null; return; }
      if(m.type==='notification'){ S.elList.appendChild(el('div','sec64chat-row','<div class="sec64chat-bubble note"><span class="ni"><i class="fa fa-bell"></i></span><div>'+esc(m.text)+'</div></div>')); prev=null; return; }
      var mine    = String(m.senderId)===S.uid;
      var deleted = !!m.deleted;
      var edited  = !!m.editedAt && !deleted;
      var grp     = prev && String(prev.senderId)===String(m.senderId) && prev._ch===m._ch && ((m.ts||0)-(prev.ts||0) < 5*60000);
      var pv      = privacyOf(m._ch);
      var row     = el('div','sec64chat-row'+(mine?' mine':'')+(grp?' grp':''));
      row.setAttribute('data-mid', m._id);
      row.setAttribute('data-aud', m._ch);
      var slot = mine ? '' : ('<div class="slot">'+(grp?'':avatar(displayName(m),30))+'</div>');
      var nm   = (!mine && !grp) ? '<div class="sname">'+esc(displayName(m))+'</div>' : '';
      var bodyText, bodyAtts, actions = '', editedTag = '';
      var bodyReply = '';
      if(deleted){
        bodyText = '<i class="msg-deleted"><i class="fa fa-ban"></i> this message was deleted</i>';
        bodyAtts = '';
      } else {
        bodyReply = renderReplyTag(m);                                        // quoted context block (lead/item etc.)
        bodyText = m.text ? '<div class="msg-text">'+escMultiline(m.text)+'</div>' : '';
        bodyAtts = renderAtts(m.attachments);
        if(edited) editedTag = '<span class="msg-edited" title="edited">(edited)</span>';
        if(mine){
          actions = '<button type="button" class="msg-menu-btn" data-act="menu" title="More"><i class="fa fa-ellipsis-v"></i></button>';
        }
      }
      var ft   = '<div class="ft">'+(pv.priv && !deleted ?'<i class="fa fa-lock lock" title="'+esc(pv.tip||'')+'"></i>':'')+(pv.priv&&pv.inline && !deleted ?'<span class="only">'+esc(pv.inline)+'</span>':'')+editedTag+'<span class="tm">'+fmt(m.ts)+'</span>'+(mine && !deleted ?'<span class="tick" data-ts="'+(m.ts||0)+'" data-aud="'+esc(m._ch)+'"></span>':'')+'</div>';
      var bub  = '<div class="sec64chat-bubble'+(pv.priv && !deleted ?' priv':'')+(deleted ?' deleted':'')+'">'+bodyReply+bodyText+bodyAtts+ft+actions+'</div>';
      row.innerHTML = slot + '<div class="col">'+nm+bub+'</div>';
      // wire kebab menu (Edit / Delete) on own messages
      if(mine && !deleted){
        var aMenu = row.querySelector('[data-act=menu]');
        if(aMenu) aMenu.onclick = function(e){ e.stopPropagation(); openMsgMenu(aMenu, row, m); };
      }
      S.elList.appendChild(row); prev = m;
    });
    S.elList.scrollTop = S.elList.scrollHeight;
    renderTicks(); markRead(msgs);
  }

  // Preserve newlines from server-side text (`\n`) as <br> while still escaping HTML.
  function escMultiline(s){ return esc(String(s||'')).replace(/\n/g, '<br>'); }

  // Quoted "reply" tag rendered above the message body — drives off m.payload.reply.
  // Supported kind: "lead-item" (lead/item context block).
  function renderReplyTag(m){
    var r = m && m.payload && m.payload.reply;
    if(!r || typeof r !== 'object') return '';
    var kind = r.kind || '';
    if(kind === 'lead-item'){
      var line1 = '<i class="fa fa-cube"></i> ';
      var bits = [];
      if(r.leadId)    bits.push('Lead #'+esc(r.leadId));
      if(r.itemId)    bits.push('Item #'+esc(r.itemId));
      if(r.bidItemId) bits.push('Bid #'+esc(r.bidItemId));
      line1 += bits.join(' · ');
      var line2 = r.description ? esc(r.description) : '';
      var line3 = '';
      if(r.quantity){
        line3 = 'Qty: ' + esc(r.quantity) + (r.unit ? ' ' + esc(r.unit) : '');
      }
      return '<div class="msg-reply">' +
               '<div class="mr-head">' + line1 + '</div>' +
               (line2 ? '<div class="mr-desc">' + line2 + '</div>' : '') +
               (line3 ? '<div class="mr-qty">'  + line3 + '</div>' : '') +
             '</div>';
    }
    return '';
  }

  function renderAtts(atts){
    if(!atts) return '';
    var list = Array.isArray(atts) ? atts : Object.keys(atts).map(function(k){return atts[k];});
    if(!list.length) return '';
    var h = '<div class="atts">';
    list.forEach(function(a){
      if(!a||!a.url) return;
      if(a.type==='image') h+='<a href="'+esc(a.url)+'" target="_blank"><img src="'+esc(a.url)+'"></a>';
      else if(a.type==='voice') h+='<audio controls src="'+esc(a.url)+'"></audio>';
      else {
        var ft = fileTypeFor(a.name||a.url);
        h+='<a class="file ftype-'+ft.kind+'" href="'+esc(a.url)+'" target="_blank" title="'+esc(a.name||'file')+'">' +
             '<i class="fa '+ft.icon+'"></i>' +
             '<span class="fn">'+esc(a.name||'file')+'</span>' +
             (ft.label ? '<span class="fext">'+ft.label+'</span>' : '') +
           '</a>';
      }
    });
    return h + '</div>';
  }

  // Map a file name to {icon, kind, label} — kind drives the colour class, icon is the Font-Awesome glyph.
  function fileTypeFor(nameOrUrl){
    var s   = String(nameOrUrl||'').toLowerCase();
    var ext = (s.split('?')[0].split('.').pop()||'').slice(0,5);
    var map = {
      pdf:   { icon:'fa-file-pdf-o',        kind:'pdf',   label:'PDF' },
      doc:   { icon:'fa-file-word-o',       kind:'doc',   label:'DOC' },
      docx:  { icon:'fa-file-word-o',       kind:'doc',   label:'DOCX' },
      rtf:   { icon:'fa-file-word-o',       kind:'doc',   label:'RTF' },
      xls:   { icon:'fa-file-excel-o',      kind:'xls',   label:'XLS' },
      xlsx:  { icon:'fa-file-excel-o',      kind:'xls',   label:'XLSX' },
      csv:   { icon:'fa-file-excel-o',      kind:'xls',   label:'CSV' },
      ppt:   { icon:'fa-file-powerpoint-o', kind:'ppt',   label:'PPT' },
      pptx:  { icon:'fa-file-powerpoint-o', kind:'ppt',   label:'PPTX' },
      zip:   { icon:'fa-file-archive-o',    kind:'zip',   label:'ZIP' },
      rar:   { icon:'fa-file-archive-o',    kind:'zip',   label:'RAR' },
      '7z':  { icon:'fa-file-archive-o',    kind:'zip',   label:'7Z' },
      txt:   { icon:'fa-file-text-o',       kind:'txt',   label:'TXT' },
      log:   { icon:'fa-file-text-o',       kind:'txt',   label:'LOG' },
      ai:    { icon:'fa-file-image-o',      kind:'art',   label:'AI' },
      psd:   { icon:'fa-file-image-o',      kind:'art',   label:'PSD' },
      eps:   { icon:'fa-file-image-o',      kind:'art',   label:'EPS' },
      cdr:   { icon:'fa-file-image-o',      kind:'art',   label:'CDR' },
      mp4:   { icon:'fa-file-video-o',      kind:'video', label:'MP4' },
      mov:   { icon:'fa-file-video-o',      kind:'video', label:'MOV' },
      mp3:   { icon:'fa-file-audio-o',      kind:'audio', label:'MP3' },
      wav:   { icon:'fa-file-audio-o',      kind:'audio', label:'WAV' }
    };
    return map[ext] || { icon:'fa-file-o', kind:'other', label: ext ? ext.toUpperCase() : '' };
  }
  function renderTicks(){
    if(!S.elList) return;
    // Use unicode check marks instead of FontAwesome icons — render guaranteed in any host
    // page's font stack (some pages don't fully load FA, which made tick boxes show as empty squares).
    var TICK_SENT  = '✓';        // ✓
    var TICK_DOUBLE= '✓✓';  // ✓✓
    Array.prototype.forEach.call(S.elList.querySelectorAll('.tick'), function(t){
      var ts = +t.getAttribute('data-ts'), aud = t.getAttribute('data-aud');
      var elig = eligibleFor(aud);
      if(!elig.length){
        t.innerHTML = '<span class="tk tk-sent" title="Sent">'+TICK_SENT+'</span>';
        return;
      }
      var readBy  = elig.filter(function(u){ return rcpt(u,'lastRead')      >= ts; });
      var delivBy = elig.filter(function(u){ return rcpt(u,'deliveredUpTo') >= ts; });
      var nElig = elig.length, nR = readBy.length, nD = delivBy.length;
      var tip;
      if(nR === nElig){
        tip = 'Read by all ('+nR+'/'+nElig+')';
        t.innerHTML = '<span class="tk tk-read" title="'+tip+'">'+TICK_DOUBLE+'</span>';
      } else if(nD > 0){
        tip = 'Delivered to '+nD+'/'+nElig + (nR>0 ? ' · Read by '+nR : '');
        t.innerHTML = '<span class="tk tk-deliv" title="'+tip+'">'+TICK_DOUBLE+'</span>';
      } else {
        tip = 'Sent';
        t.innerHTML = '<span class="tk tk-sent" title="'+tip+'">'+TICK_SENT+'</span>';
      }
    });
  }
  function rcpt(u,f){ var r=S.receipts[u]; return (r&&r[f])?r[f]:0; }
  function eligibleFor(aud){ var o=[]; for(var k in S.members){ if(k===S.uid)continue; var m=S.members[k]; if(canSee(m.side, m.vendorId||'', aud)) o.push(k); } return o; }
  // Called when messages render — the user is actively viewing the chat.
  // Writes receipts (delivered + read) for tick-state, but does NOT clear unread.
  // Unread is now cleared ONLY when the user actively engages with the input (clickInput / type).
  function markRead(msgs){
    if(!msgs||!msgs.length||!S.roomId) return;
    var mx=0; msgs.forEach(function(m){ if((m.ts||0)>mx)mx=m.ts; });
    if(!mx || mx<=S.lastReadSent) return;
    S.lastReadSent = mx;
    S.db.ref('receipts/'+S.roomId+'/'+S.uid).update({lastRead:mx, deliveredUpTo:mx}).catch(function(){});
    if((S.deliveredCache[S.roomId]||0) < mx) S.deliveredCache[S.roomId] = mx;
  }

  // Active reset — call when the user actually engages with the chat (focuses input or starts typing).
  // Clears the unread badge in the inbox + clears bell notifs for the open room.
  function markRoomEngaged(){
    if(!S.roomId || !S.db || !S.uid) return;
    if(S.engagedRooms && S.engagedRooms[S.roomId]) return;           // already cleared this session
    S.engagedRooms = S.engagedRooms || {};
    S.engagedRooms[S.roomId] = true;
    if(S.inboxLive[S.roomId]) S.inboxLive[S.roomId].unread = 0;
    S.inboxRows.forEach(function(rr){ if(rr.roomId === S.roomId) rr.unread = 0; });
    S.db.ref('userRooms/'+S.uid+'/'+S.roomId+'/unread').set(0).catch(function(){});
    markNotificationsRead(S.roomId);
    renderInbox();
  }
  function renderChips(){
    if(!S.elChips) return;
    var a = (w.Sec64Upload ? Sec64Upload.getPending() : []);
    if(!a.length){ S.elChips.innerHTML = ''; S.elChips.style.display = 'none'; return; }
    S.elChips.style.display = '';
    S.elChips.innerHTML = a.map(function(x){
      var thumb;
      if(x.type === 'image' && x.thumb){
        thumb = '<img class="ch-img" src="'+esc(x.thumb)+'" alt="">';
      } else if(x.url && x.type === 'image'){
        thumb = '<img class="ch-img" src="'+esc(x.url)+'" alt="">';
      } else if(x.type==='voice'){
        thumb = '<span class="ch-ico"><i class="fa fa-microphone"></i></span>';
      } else if(x.type==='image'){
        thumb = '<span class="ch-ico"><i class="fa fa-image"></i></span>';
      } else {
        var ft = fileTypeFor(x.name||'');
        thumb = '<span class="ch-ico ftype-'+ft.kind+'"><i class="fa '+ft.icon+'"></i></span>';
      }
      var sizeKb = x.size ? Math.round(x.size/1024) + ' KB' : '';
      var done   = x.state === 'done';
      var err    = x.state === 'error';
      var pct    = err ? 100 : (x.progress || 0);
      var stateClass = err ? 'ch-err' : (done ? 'ch-done' : 'ch-up');
      return '<div class="sec64chat-chip '+stateClass+'" data-id="'+esc(x.id)+'">' +
          thumb +
          '<div class="ch-mid">' +
            '<div class="ch-name" title="'+esc(x.name||'')+'">'+esc(x.name||x.type)+'</div>' +
            '<div class="ch-meta">' +
              (err  ? '<span class="ch-st ch-st-err">'+esc(x.error||'failed')+'</span>'
                    : (done ? '<span class="ch-st ch-st-ok"><i class="fa fa-check"></i> uploaded</span>'
                            : '<span class="ch-st ch-st-up">'+pct+'%</span>')) +
              (sizeKb ? ' <span class="ch-sz">'+sizeKb+'</span>' : '') +
            '</div>' +
            (!done ? '<div class="ch-bar"><div class="ch-bar-fill" style="width:'+pct+'%"></div></div>' : '') +
          '</div>' +
          '<button type="button" class="ch-x" title="Remove"><i class="fa fa-times"></i></button>' +
        '</div>';
    }).join('');
    // wire remove buttons
    Array.prototype.forEach.call(S.elChips.querySelectorAll('.ch-x'), function(btn){
      btn.onclick = function(){
        var chip = btn.closest('.sec64chat-chip');
        if(!chip) return;
        var id = chip.getAttribute('data-id');
        if(w.Sec64Upload && Sec64Upload.removeFile) Sec64Upload.removeFile(id);
        renderChips();
      };
    });
  }
  /* ════════════════════════  VOICE RECORDER (WhatsApp-style)  ════════════════════════ */
  function pickAudioMime(){
    if(!w.MediaRecorder) return '';
    var prefs = ['audio/webm;codecs=opus','audio/webm','audio/ogg;codecs=opus','audio/ogg','audio/mp4'];
    for(var i=0;i<prefs.length;i++){ if(MediaRecorder.isTypeSupported(prefs[i])) return prefs[i]; }
    return '';
  }
  function extForMime(m){ return m.indexOf('mp4')>-1?'mp4':(m.indexOf('ogg')>-1?'ogg':'webm'); }

  function setVoiceState(s){
    S.voiceState = s;
    // toggle composer pieces
    var idle = (s === 'idle');
    if(S.elInputwrap) S.elInputwrap.style.display = idle ? '' : 'none';
    if(S.elSendBtn)   S.elSendBtn.style.display   = idle ? '' : 'none';
    if(S.elVoiceRec)  S.elVoiceRec.style.display  = (s === 'recording') ? 'flex' : 'none';
    if(S.elVoicePrev) S.elVoicePrev.style.display = (s === 'preview' || s === 'uploading') ? 'flex' : 'none';
    // disable buttons during upload
    if(s === 'uploading' && S.elVoicePrev){
      Array.prototype.forEach.call(S.elVoicePrev.querySelectorAll('.vr-btn'), function(b){ b.disabled = true; });
      var sendBtn = S.elVoicePrev.querySelector('.vr-send');
      if(sendBtn) sendBtn.innerHTML = '<i class="fa fa-spinner fa-spin"></i>';
    }
  }

  function startVoiceRec(){
    if(S.voiceState && S.voiceState !== 'idle') return;
    if(!navigator.mediaDevices || !w.MediaRecorder){ alert('Voice recording not supported in this browser'); return; }
    navigator.mediaDevices.getUserMedia({audio:true}).then(function(stream){
      S.voiceStream  = stream;
      S.voiceChunks  = [];
      S.voiceStart   = Date.now();
      S.voiceMime    = pickAudioMime() || 'audio/webm';
      try { S.voiceRec = new MediaRecorder(stream, { mimeType: S.voiceMime }); }
      catch(e) { S.voiceRec = new MediaRecorder(stream); }
      S.voiceCancel = false;

      S.voiceRec.ondataavailable = function(e){ if(e.data && e.data.size) S.voiceChunks.push(e.data); };
      S.voiceRec.onstop = function(){
        try { stream.getTracks().forEach(function(t){ t.stop(); }); } catch(e){}
        stopBarsAnim(); stopVoiceTimer();
        if(S.voiceCancel || !S.voiceChunks.length){ resetVoice(); return; }
        S.voiceDuration = Math.max(1, Math.round((Date.now() - S.voiceStart)/1000));
        var type = (S.voiceMime.indexOf('mp4')>-1) ? 'audio/mp4' : (S.voiceMime.indexOf('ogg')>-1 ? 'audio/ogg' : 'audio/webm');
        S.voiceBlob = new Blob(S.voiceChunks, { type: type });
        S.voiceAudio = new Audio(URL.createObjectURL(S.voiceBlob));
        S.voiceAudio.addEventListener('ended', function(){ S.voicePlaying = false; updatePreviewPlay(); });
        S.voicePlaying = false;
        setVoiceState('preview');
        renderVoiceTime(S.voiceDuration);
        randomiseStaticBars();
      };

      S.voiceRec.start();
      setVoiceState('recording');
      startBarsAnim(stream);
      startVoiceTimer();
    }).catch(function(){
      alert('Microphone permission denied. Allow microphone access in your browser to record voice messages.');
    });
  }

  function stopVoiceRec(){
    if(S.voiceState !== 'recording') return;
    if(S.voiceRec && S.voiceRec.state !== 'inactive'){ try{ S.voiceRec.stop(); }catch(e){} }
  }
  function cancelVoice(){
    S.voiceCancel = true;
    if(S.voiceRec && S.voiceRec.state !== 'inactive'){ try{ S.voiceRec.stop(); }catch(e){} }
    else resetVoice();
  }
  function discardVoicePreview(){
    if(S.voiceAudio){ try{ S.voiceAudio.pause(); URL.revokeObjectURL(S.voiceAudio.src); }catch(e){} }
    resetVoice();
  }
  function resetVoice(){
    if(S.voiceStream){ try{ S.voiceStream.getTracks().forEach(function(t){ t.stop(); }); }catch(e){} S.voiceStream = null; }
    S.voiceRec=null; S.voiceChunks=[]; S.voiceBlob=null; S.voiceAudio=null; S.voiceDuration=0; S.voicePlaying=false;
    stopBarsAnim(); stopVoiceTimer();
    setVoiceState('idle');
  }
  function togglePlayPreview(){
    if(!S.voiceAudio) return;
    if(S.voiceAudio.paused){ S.voiceAudio.currentTime = 0; S.voiceAudio.play(); S.voicePlaying = true; }
    else                    { S.voiceAudio.pause(); S.voicePlaying = false; }
    updatePreviewPlay();
  }
  function updatePreviewPlay(){
    if(!S.elVoicePrev) return;
    var btn = S.elVoicePrev.querySelector('.vr-play');
    if(btn) btn.innerHTML = S.voicePlaying ? '<i class="fa fa-pause"></i>' : '<i class="fa fa-play"></i>';
  }

  function sendVoiceMessage(){
    if(S.voiceState !== 'preview' || !S.voiceBlob) return;
    setVoiceState('uploading');
    var ext  = extForMime(S.voiceMime);
    var name = 'voice_' + Date.now() + '.' + ext;
    var aud  = S.elAud ? S.elAud.value : 'all';
    var fd   = new FormData(); fd.append('file', S.voiceBlob, name);

    var xhr = new XMLHttpRequest();
    xhr.open('POST', uploadUrlForRoom(), true);
    xhr.withCredentials = true;
    xhr.onload = function(){
      var att; try { att = JSON.parse(xhr.responseText); } catch(e){ att = { status:false }; }
      var ok = att && (att.status || att.STATUS);
      if(!ok){ alert('Voice upload failed: ' + ((att && (att.error||att.ERROR)) || 'unknown')); setVoiceState('preview'); return; }
      var url = att.url || att.URL;
      var dur = S.voiceDuration;
      var msg = {
        senderId: S.uid, senderRole: S.role, senderSide: S.side, senderName: S.name,
        type: 'chat', text: '', audience: aud,
        attachments: [{ type:'voice', url: url, name: name, size: (att.size||att.SIZE||S.voiceBlob.size), mime: (att.mime||att.MIME||S.voiceMime), duration: dur }],
        ts: S.TS
      };
      // direct Firebase push + fan-out, same as text messages
      S.db.ref('chatMessages/'+S.roomId+'/'+aud).push(msg).then(function(){
        var preview = '🎤 voice message ('+fmtDuration(dur)+')';
        S.db.ref('chatRooms/'+S.roomId+'/meta').update({ lastMessage: preview, lastTs: S.TS, lastAudience: aud }).catch(function(){});
        fanOut(preview, aud);
        persistAttachments([url]);                                       // tasks_attachments insert (server uses cfthread)
        discardVoicePreview();
      }).catch(function(e){ console.error('[Sec64Chat] voice send failed',e); setVoiceState('preview'); });
    };
    xhr.onerror = function(){ alert('Voice upload error'); setVoiceState('preview'); };
    xhr.send(fd);
  }

  function fmtDuration(s){ var m=Math.floor(s/60), x=s%60; return m+':'+('0'+x).slice(-2); }
  function renderVoiceTime(s){
    if(!S.elVoiceRec || !S.elVoicePrev) return;
    var t = fmtDuration(s);
    var a = S.elVoiceRec.querySelector('.vr-time'); if(a) a.textContent = t;
    var b = S.elVoicePrev.querySelector('.vr-time'); if(b) b.textContent = t;
  }

  function startVoiceTimer(){
    stopVoiceTimer();
    S.voiceTimer = setInterval(function(){
      var s = Math.floor((Date.now() - S.voiceStart)/1000);
      renderVoiceTime(s);
    }, 250);
  }
  function stopVoiceTimer(){ if(S.voiceTimer){ clearInterval(S.voiceTimer); S.voiceTimer=null; } }

  function startBarsAnim(stream){
    stopBarsAnim();
    var bars = S.elVoiceRec ? S.elVoiceRec.querySelectorAll('.vr-bars .vb') : [];
    if(!bars.length) return;
    try {
      var AC = w.AudioContext || w.webkitAudioContext;
      var ac = new AC();
      S.voiceAudioCtx = ac;
      var src = ac.createMediaStreamSource(stream);
      var an  = ac.createAnalyser(); an.fftSize = 128; an.smoothingTimeConstant = 0.65;
      src.connect(an);
      var data = new Uint8Array(an.frequencyBinCount);
      function step(){
        if(S.voiceState !== 'recording') return;
        an.getByteFrequencyData(data);
        var stride = Math.max(1, Math.floor(data.length / bars.length));
        for(var i=0;i<bars.length;i++){
          var v = data[i*stride] || 0;
          var h = Math.max(8, (v/255)*100);
          bars[i].style.height = h + '%';
        }
        S.voiceAnim = requestAnimationFrame(step);
      }
      step();
    } catch(e){
      // fallback: randomised bars
      function fallback(){
        if(S.voiceState !== 'recording') return;
        for(var i=0;i<bars.length;i++) bars[i].style.height = (10 + Math.random()*70) + '%';
        S.voiceAnim = setTimeout(fallback, 100);
      }
      fallback();
    }
  }
  function stopBarsAnim(){
    if(S.voiceAnim){ try{ cancelAnimationFrame(S.voiceAnim); }catch(e){} try{ clearTimeout(S.voiceAnim); }catch(e){} S.voiceAnim = null; }
    if(S.voiceAudioCtx){ try{ S.voiceAudioCtx.close(); }catch(e){} S.voiceAudioCtx = null; }
  }
  function randomiseStaticBars(){
    if(!S.elVoicePrev) return;
    var bars = S.elVoicePrev.querySelectorAll('.vr-bars .vb');
    for(var i=0;i<bars.length;i++) bars[i].style.height = (12 + Math.random()*70) + '%';
  }

  /* ════════════════════════  SEND (direct Firebase write + client-side fan-out)  ════════════════════════ */
  // Each attachment is sent as its OWN message (its own bubble) — text (if any) goes first as a separate message.
  function doSend(){
    if(!S.roomId) return;
    var text = (S.elInput.value||'').trim();
    var ready = (w.Sec64Upload ? Sec64Upload.getReady() : []);
    var atts  = ready.map(function(it){
      return { type: it.type, url: it.url, name: it.name, size: it.size, mime: it.mime, duration: it.duration || 0 };
    });
    if(!text && !atts.length) return;
    var aud = S.elAud ? S.elAud.value : 'all';

    // optimistic UI clear
    S.elInput.value = '';
    if(w.Sec64Upload) Sec64Upload.clear();
    S.pending = []; renderChips();

    // build queue: text first (if any), then ONE message per attachment
    var queue = [];
    if(text) queue.push({ text: text, attachments: [] });
    atts.forEach(function(a){ queue.push({ text: '', attachments: [a] }); });

    var ref      = S.db.ref('chatMessages/'+S.roomId+'/'+aud);
    var metaRef  = S.db.ref('chatRooms/'+S.roomId+'/meta');
    var allUrls  = [];

    // send sequentially so push-keys preserve order
    sendNext();
    function sendNext(){
      var item = queue.shift();
      if(!item){
        if(allUrls.length) persistAttachments(allUrls);
        return;
      }
      var msg = {
        senderId:    S.uid,
        senderRole:  S.role,
        senderSide:  S.side,
        senderName:  S.name,
        type:        'chat',
        text:        item.text,
        audience:    aud,
        attachments: item.attachments,
        ts:          S.TS
      };
      ref.push(msg).then(function(){
        var preview = item.text || attPreview(item.attachments[0]);
        metaRef.update({ lastMessage: preview, lastTs: S.TS, lastAudience: aud }).catch(function(){});
        fanOut(preview, aud);
        item.attachments.forEach(function(a){ if(a.url) allUrls.push(a.url); });
        sendNext();
      }).catch(function(e){ console.error('[Sec64Chat] send failed',e); sendNext(); });
    }
  }

  function attPreview(a){
    if(!a) return '';
    if(a.type === 'voice') return '🎤 voice message';
    if(a.type === 'image') return '📷 ' + (a.name || 'image');
    var ft = fileTypeFor(a.name || '');
    var ico = ft.kind === 'pdf' ? '📕'
            : ft.kind === 'doc' ? '📘'
            : ft.kind === 'xls' ? '📗'
            : ft.kind === 'ppt' ? '📙'
            : ft.kind === 'zip' ? '🗜️'
            : ft.kind === 'video' ? '🎬'
            : ft.kind === 'audio' ? '🎵'
            : ft.kind === 'art'   ? '🎨'
            : '📎';
    return ico + ' ' + (a.name || 'file');
  }

  function persistAttachments(urls){
    if(!urls || !urls.length) return;
    var fd = new FormData();
    fd.append('lead_id',   S.meta.leadId    || 0);
    fd.append('task_id',   S.meta.taskId    || 0);
    fd.append('item_id',   S.meta.bidItemId || 0);   // bid_item_id stored in item_id column
    fd.append('vendor_id', S.meta.vendorId  || 0);   // stored only if column exists
    fd.append('urls',      JSON.stringify(urls));
    fetch(S.saveAttachUrl, { method:'POST', credentials:'same-origin', body: fd })
      .catch(function(e){ console.warn('[Sec64Chat] save attachments',e); });
  }

  /* ════════════════════════  EDIT / DELETE message (own messages only)  ════════════════════════ */
  function msgRef(m){ return S.db.ref('chatMessages/'+S.roomId+'/'+m._ch+'/'+m._id); }

  function beginEditMessage(rowEl, m){
    var bubble = rowEl.querySelector('.sec64chat-bubble'); if(!bubble) return;
    bubble.innerHTML =
      '<textarea class="msg-edit-ta" rows="1">'+esc(m.text||'')+'</textarea>' +
      '<div class="msg-edit-act">' +
        '<button type="button" class="msg-edit-cancel">Cancel</button>' +
        '<button type="button" class="msg-edit-save"><i class="fa fa-check"></i> Save</button>' +
      '</div>';
    var ta = bubble.querySelector('.msg-edit-ta');
    ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);
    autoGrow(ta);
    ta.addEventListener('input', function(){ autoGrow(ta); });
    ta.addEventListener('keydown', function(e){
      if(e.key === 'Escape') cancel();
      if(e.key === 'Enter' && !e.shiftKey){ e.preventDefault(); save(); }
    });
    function cancel(){ renderThread(); }
    function save(){
      var newText = (ta.value||'').trim();
      if(!newText){ cancel(); return; }
      if(newText === (m.text||'')){ cancel(); return; }
      msgRef(m).update({ text: newText, editedAt: S.TS }).then(function(){
        // also bump room meta preview if this was the most recent message
        S.db.ref('chatRooms/'+S.roomId+'/meta').once('value').then(function(s){
          var meta = s.val()||{};
          if((meta.lastTs||0) <= (m.ts||0) + 60000){    // recent enough — update preview
            S.db.ref('chatRooms/'+S.roomId+'/meta').update({ lastMessage: newText }).catch(function(){});
          }
        });
      }).catch(function(e){ console.error('[Sec64Chat] edit failed',e); cancel(); });
    }
    bubble.querySelector('.msg-edit-cancel').onclick = cancel;
    bubble.querySelector('.msg-edit-save').onclick   = save;
  }
  function autoGrow(ta){ ta.style.height='auto'; ta.style.height = Math.min(ta.scrollHeight, 160) + 'px'; }

  /* ── kebab dropdown for own messages (Edit / Delete) ── */
  function openMsgMenu(btn, rowEl, m){
    closeMsgMenu();
    var menu = el('div','sec64chat-msg-menu');
    menu.innerHTML =
      '<button type="button" class="mm-item" data-do="edit"><i class="fa fa-pencil"></i> Edit</button>' +
      '<button type="button" class="mm-item mm-danger" data-do="delete"><i class="fa fa-trash"></i> Delete</button>';
    d.body.appendChild(menu);
    S.elMsgMenu = menu;

    // position under the kebab
    var r = btn.getBoundingClientRect();
    var top  = r.bottom + 4;
    var left = r.right - 140;  // menu is ~140px wide; right-align under the button
    if(top + 80 > w.innerHeight) top = r.top - 80 - 4;
    if(left < 8) left = 8;
    menu.style.top  = top  + 'px';
    menu.style.left = left + 'px';

    menu.querySelector('[data-do=edit]').onclick   = function(e){ e.stopPropagation(); closeMsgMenu(); beginEditMessage(rowEl, m); };
    menu.querySelector('[data-do=delete]').onclick = function(e){ e.stopPropagation(); closeMsgMenu(); deleteMessage(m); };
    setTimeout(function(){ d.addEventListener('mousedown', closeMsgMenuOnOutside, true); }, 0);
  }
  function closeMsgMenuOnOutside(e){
    if(!S.elMsgMenu) return;
    if(S.elMsgMenu.contains(e.target)) return;
    if(e.target.closest && e.target.closest('.msg-menu-btn')) return;
    closeMsgMenu();
  }
  function closeMsgMenu(){
    if(S.elMsgMenu){ try{ S.elMsgMenu.remove(); }catch(e){} S.elMsgMenu = null; }
    d.removeEventListener('mousedown', closeMsgMenuOnOutside, true);
  }

  function deleteMessage(m){
    if(!confirm('Delete this message? This cannot be undone.')) return;
    msgRef(m).update({ deleted: true, deletedAt: S.TS, text: '', attachments: null }).then(function(){
      // bump preview if this was the last
      S.db.ref('chatRooms/'+S.roomId+'/meta').once('value').then(function(s){
        var meta = s.val()||{};
        if((meta.lastTs||0) <= (m.ts||0) + 60000){
          S.db.ref('chatRooms/'+S.roomId+'/meta').update({ lastMessage: '[message deleted]' }).catch(function(){});
        }
      });
    }).catch(function(e){ console.error('[Sec64Chat] delete failed',e); alert('Delete failed'); });
  }

  // Notify every member of the room except the sender.
  // No audience gating — if a user is in chatRooms/<roomId>/members, they get the unread bump + bell notif.
  // Room membership IS the visibility filter (vendors/customers are isolated by being in their OWN room,
  // not by audience-channel filtering inside a shared room).
  function fanOut(preview, aud){
    // 1) Sender's OWN inbox row — update lastMessage + lastTs so the chat list shows the latest
    //    text and bubbles to the top. NO unread bump (sender already saw the message).
    if(S.db && S.uid && S.roomId){
      var selfRef = S.db.ref('userRooms/'+S.uid+'/'+S.roomId);
      selfRef.transaction(function(cur){
        cur = cur || { entityType:'', entityId:0, title:S.meta.title||S.roomId, side:S.side, unread:0 };
        cur.lastMessage = preview;
        cur.lastTs      = Date.now();
        cur.title       = cur.title || S.meta.title || S.roomId;
        // explicitly do NOT touch cur.unread for the sender
        return cur;
      }).catch(function(){});
    }
    // 2) Every OTHER member — same row update + unread bump + bell notification
    for(var uid in S.members){
      if(uid === S.uid) continue;                                            // skip sender
      (function(targetUid, m){
        var roomRef = S.db.ref('userRooms/'+targetUid+'/'+S.roomId);
        roomRef.transaction(function(cur){
          cur = cur || { entityType:'', entityId:0, title:S.meta.title||S.roomId, side:m.side, unread:0 };
          cur.lastMessage = preview;
          cur.lastTs      = Date.now();
          cur.unread      = (cur.unread||0) + 1;
          cur.title       = cur.title || S.meta.title || S.roomId;
          return cur;
        }).catch(function(){});
        S.db.ref('userNotifications/'+targetUid).push({
          roomId:     S.roomId,
          title:      preview,
          senderName: S.name,
          threadType: S.meta.threadType || '',
          isRead:     false,
          ts:         S.TS
        }).catch(function(){});
      })(uid, S.members[uid]);
    }
  }

  // Clear bell notifications for the currently-open room — keeps the top-nav bell badge accurate.
  // Called from openRoom so unread notifs for a room you just opened don't keep blinking at you.
  function markNotificationsRead(roomId){
    if(!S.db || !S.uid || !roomId) return;
    var ref = S.db.ref('userNotifications/'+S.uid);
    ref.once('value').then(function(snap){
      var v = snap.val() || {};
      var updates = {};
      for(var k in v){
        var n = v[k];
        if(n && n.isRead === false && n.roomId === roomId){ updates[k+'/isRead'] = true; }
      }
      if(Object.keys(updates).length) ref.update(updates).catch(function(){});
    }).catch(function(){});
  }

  /* ════════════════════════  INBOX (left pane, 3 tabs)  ════════════════════════ */
  function tabForThreadType(tt){
    if(tt==='customer')                            return 'customers';
    if(tt==='bid_vendor' || tt==='job_vendor')     return 'vendors';
    return 'internal';                              // task, bid_internal
  }

  // Tally unread per tab from the merged inbox list, then update each tab button's badge.
  function renderTabUnreadBadges(rows){
    if(!S.elTabs) return;
    var totals = { internal:0, customers:0, vendors:0 };
    rows.forEach(function(r){
      if(!r || !r.unread) return;
      var t = tabForThreadType(r.threadType);
      totals[t] = (totals[t] || 0) + r.unread;
    });
    Array.prototype.forEach.call(S.elTabs.querySelectorAll('button[data-tab]'), function(btn){
      var tab = btn.getAttribute('data-tab');
      var n   = totals[tab] || 0;
      var existing = btn.querySelector('.tab-u');
      if(n > 0){
        var label = (n > 99) ? '99+' : String(n);
        if(existing){ existing.textContent = label; }
        else {
          var span = d.createElement('span');
          span.className = 'tab-u';
          span.textContent = label;
          btn.appendChild(span);
        }
      } else if(existing){
        existing.remove();
      }
    });
  }
  function setActiveTab(tab){
    if(!tab || S.activeTab === tab) return;
    S.activeTab = tab;
    if(S.elTabs){
      Array.prototype.forEach.call(S.elTabs.querySelectorAll('button[data-tab]'), function(b){
        b.classList.toggle('active', b.getAttribute('data-tab') === tab);
      });
    }
    renderInbox();
  }

  function subscribeInbox(){
    // 1) fetch enriched rows from server (one shot per open)
    fetchInbox();
    // 2) subscribe to userRooms for live unread / lastMessage / lastTs deltas
    if(S.inboxRef){ try{ S.inboxRef.off(); }catch(e){} }
    S.inboxRef = S.db.ref('userRooms/'+S.uid);
    S.inboxRef.on('value', function(snap){
      S.inboxLive = snap.val() || {};
      // Mark messages as "delivered" — the inbox subscription receives lastTs as soon as
      // the sender pushes, even when the recipient's chat is closed.
      for(var roomId in S.inboxLive){
        var live = S.inboxLive[roomId];
        if(!live || !live.lastTs) continue;
        var prev = S.deliveredCache[roomId] || 0;
        if(live.lastTs > prev){
          S.deliveredCache[roomId] = live.lastTs;
          S.db.ref('receipts/'+roomId+'/'+S.uid+'/deliveredUpTo').set(live.lastTs).catch(function(){});
        }
      }
      // Detect NEW rooms (added by someone else while we're already in the inbox).
      // If any roomId in live isn't in S.inboxRows, re-fetch inbox so the row appears
      // with full enriched metadata (title, customer name, agent name, etc.).
      var existing = {};
      S.inboxRows.forEach(function(r){ existing[r.roomId] = true; });
      var hasNew = false;
      for(var rid in S.inboxLive){ if(!existing[rid]){ hasNew = true; break; } }
      if(hasNew && !S.inboxRefetching){
        S.inboxRefetching = true;
        fetchInbox();
        setTimeout(function(){ S.inboxRefetching = false; }, 1500);  // debounce against rapid bursts
      } else {
        renderInbox();
      }
    });
  }
  // silent=true → no "Refreshing…" banner, no flicker. The new data lands silently once the
  // network call resolves. Use when the user triggers a refresh in the background (e.g. Show all).
  function fetchInbox(silent){
    if(!silent){
      S.inboxLoading = true;
      renderInbox();                                        // surface the loading banner immediately
    }
    fetch(S.inboxUrl, {credentials:'same-origin'})
      .then(function(r){ return r.json(); })
      .then(function(res){
        S.inboxLoading    = false;
        S.inboxLoadedOnce = true;
        if(res && (res.status||res.STATUS)){
          S.inboxRows = (res.rows || res.ROWS || []).map(normaliseInboxRow);
        } else {
          console.warn('[Sec64Chat] inbox fetch failed', res);
        }
        renderInbox();
      }).catch(function(e){
        S.inboxLoading    = false;
        S.inboxLoadedOnce = true;
        console.error('[Sec64Chat] inbox',e);
        renderInbox();
      });
  }
  function normaliseInboxRow(r){
    // Lucee may upper-case struct keys; normalise to camelCase
    function g(k){ if(r[k]!=null) return r[k]; var U=k.toUpperCase(); return r[U]!=null?r[U]:''; }
    return {
      roomId:         g('roomId'),
      threadType:     g('threadType'),
      leadId:         +g('leadId') || 0,
      taskId:         +g('taskId') || 0,
      bidItemId:      +g('bidItemId') || 0,
      vendorId:       +g('vendorId') || 0,
      title:          g('title'),
      lastMessage:    g('lastMessage'),
      lastTs:         +g('lastTs') || 0,
      unread:         +g('unread') || 0,
      leadName:       g('leadName'),
      leadCreatedAt:  +g('leadCreatedAt') || 0,
      agentId:        +g('agentId') || 0,
      agentName:      g('agentName'),
      customerId:     +g('customerId') || 0,
      customerName:   g('customerName'),
      taskName:       g('taskName'),
      taskTypeId:     +g('taskTypeId') || 0,
      taskTypeLabel:  g('taskTypeLabel'),
      taskCreatedAt:  +g('taskCreatedAt') || 0,
      createdBy:      +g('createdBy') || 0,
      createdByName:  g('createdByName'),
      assignedTo:     +g('assignedTo') || 0,
      assignedToName: g('assignedToName'),
      bidCreatedAt:   +g('bidCreatedAt') || 0,
      vendorName:     g('vendorName')
    };
  }
  function shortName(n, max){
    n = (n||'').trim(); max = max||14;
    if(n.length <= max) return n;
    return n.substring(0, max-1) + '…';
  }
  function ago(ts){ return agoLong(ts); }

  function renderInbox(){
    if(!S.elInboxList) return;
    if(!S.inboxRows || !S.inboxRows.length){
      if(S.inboxLoading || !S.inboxLoadedOnce){
        S.elInboxList.innerHTML =
          '<div class="sec64chat-loading">' +
            '<i class="fa fa-spinner fa-spin"></i>' +
            '<div>Loading chats…</div>' +
          '</div>' +
          '<div class="sec64chat-skeleton">' +
            '<div class="sk-row"></div><div class="sk-row"></div><div class="sk-row"></div>' +
          '</div>';
      } else {
        S.elInboxList.innerHTML = '<div class="sec64chat-emptyinbox"><i class="fa fa-inbox"></i><div>No chats yet</div></div>';
      }
      return;
    }

    // overlay live RTDB updates onto the enriched cache
    var merged = S.inboxRows.map(function(r){
      var live = S.inboxLive[r.roomId];
      if(live){
        return Object.assign({}, r, {
          lastMessage: live.lastMessage || r.lastMessage,
          lastTs:      live.lastTs      || r.lastTs,
          unread:      live.unread      != null ? live.unread : r.unread
        });
      }
      return r;
    });

    // per-tab unread totals — shown as badges on the tab buttons (use merged, not scoped)
    renderTabUnreadBadges(merged);

    // filter by active tab
    var tab = S.activeTab || 'internal';
    var rows = merged.filter(function(r){
      if(tab==='internal')  return r.threadType==='task' || r.threadType==='bid_internal';
      if(tab==='customers') return r.threadType==='customer';
      if(tab==='vendors')   return r.threadType==='bid_vendor' || r.threadType==='job_vendor';
      return true;
    });

    // SCOPE: when a chat is open, narrow inbox to rooms RELATED to it (same leadId).
    // S.scopeMode = 'related' (default after openRoom) or 'all' (after user clicks "Show all").
    var scopeLeadId = (S.roomId && S.meta && S.meta.leadId && S.scopeMode !== 'all')
                      ? +S.meta.leadId : 0;
    if(scopeLeadId){
      rows = rows.filter(function(r){ return +r.leadId === scopeLeadId; });
    }

    // group key per tab
    function groupKey(r){
      if(tab==='internal'){
        if(r.threadType==='task')         return r.assignedToName || r.createdByName || 'Unassigned';
        if(r.threadType==='bid_internal') return r.agentName || r.createdByName || 'Team';
      }
      if(tab==='customers') return r.customerName || ('Customer #'+r.customerId);
      if(tab==='vendors')   return r.vendorName   || ('Vendor #'+r.vendorId);
      return '';
    }

    // Sort rows so the inbox is ordered by actual CHAT activity (not just membership timestamp).
    // Rooms with a real lastMessage win first; "Begin chat" rooms drop to the bottom but stay
    // ordered amongst themselves by lastTs desc (= when the user was added).
    rows.sort(function(a,b){
      var aHas = a.lastMessage ? 1 : 0;
      var bHas = b.lastMessage ? 1 : 0;
      if (aHas !== bHas) return bHas - aHas;                  // chatted rooms first
      return (b.lastTs||0) - (a.lastTs||0);                   // then most-recent first
    });

    // group preserving sort order (group order = first appearance of group, which = latest activity)
    var groups = {};
    var groupOrder = [];
    rows.forEach(function(r){
      var k = groupKey(r) || '—';
      if(!groups[k]){ groups[k] = []; groupOrder.push(k); }
      groups[k].push(r);
    });

    // Count unread for OTHER leads (those filtered out by the scope) so we can tell the user
    // "you have N new messages in other chats — click to expand the view".
    var otherUnread = 0;
    if(scopeLeadId){
      merged.forEach(function(r){ if(+r.leadId !== scopeLeadId) otherUnread += (r.unread||0); });
    }
    var scopeBanner = scopeLeadId
      ? '<div class="sec64chat-scopebar">' +
          '<i class="fa fa-filter"></i> <span class="sb-t">Related to <b>Lead #'+scopeLeadId+'</b></span>' +
          (otherUnread ? '<span class="sb-other" title="Unread messages in other chats">'+otherUnread+' new elsewhere</span>' : '') +
          '<button type="button" class="sb-clear">Show all <i class="fa fa-times"></i></button>' +
        '</div>'
      : '';

    if(!groupOrder.length){
      var emptyHtml = scopeLeadId
        ? (S.inboxLoading
            ? '<div class="sec64chat-emptyinbox"><i class="fa fa-spinner fa-spin"></i><div>Loading related chats…</div></div>'
            : '<div class="sec64chat-emptyinbox"><i class="fa fa-inbox"></i><div>No related chats for <b>Lead #'+scopeLeadId+'</b> in this tab</div></div>')
        : '<div class="sec64chat-emptyinbox"><i class="fa fa-inbox"></i><div>No chats in this tab</div></div>';
      S.elInboxList.innerHTML = scopeBanner + emptyHtml;
      var clearBtn0 = S.elInboxList.querySelector('.sb-clear');
      if(clearBtn0) clearBtn0.onclick = function(){ S.scopeMode = 'all'; fetchInbox(true); renderInbox(); };
      return;
    }

    // background refresh banner — shown only when a fetch is in flight AND rows already exist
    var refreshBanner = S.inboxLoading
      ? '<div class="sec64chat-refreshing"><i class="fa fa-sync fa-spin"></i> Refreshing…</div>'
      : '';

    S.elInboxList.innerHTML = scopeBanner + refreshBanner + groupOrder.map(function(g){
      var unreadCnt = groups[g].reduce(function(a,r){ return a + (r.unread||0); }, 0);
      var collapseKey = tab + '::' + g;
      // auto-expand the group containing the active room (so user always sees their current chat)
      var containsActive = groups[g].some(function(r){ return r.roomId === S.roomId; });
      if(containsActive) delete S.collapsedGroups[collapseKey];
      var isCollapsed = !!S.collapsedGroups[collapseKey];
      return '<div class="grp'+(isCollapsed?' collapsed':'')+'" data-grp="'+esc(collapseKey)+'">' +
          '<div class="grp-h">'+
            '<i class="fa fa-chevron-down grp-chev"></i>' +
            avatar(g, 26) +
            '<span class="grp-n">'+ esc(g) +'</span>' +
            '<span class="grp-cnt">'+ groups[g].length +'</span>' +
            (unreadCnt ? '<span class="grp-u">'+unreadCnt+'</span>' : '') +
          '</div>' +
          '<div class="grp-rows">'+ groups[g].map(renderInboxRow).join('') +'</div>' +
        '</div>';
    }).join('');

    // wire "Show all" — clears the lead-scope filter
    var clearBtn = S.elInboxList.querySelector('.sb-clear');
    if(clearBtn) clearBtn.onclick = function(){ S.scopeMode = 'all'; fetchInbox(true); renderInbox(); };

    Array.prototype.forEach.call(S.elInboxList.querySelectorAll('.sec64chat-row-card'), function(el){
      el.onclick = function(e){
        e.stopPropagation();
        // Unread is now cleared by user engagement (focus/type in input), NOT by row click.
        // The count keeps accumulating until the user actively engages.
        openRoom(el.getAttribute('data-room'));
      };
    });
    Array.prototype.forEach.call(S.elInboxList.querySelectorAll('.grp > .grp-h'), function(el){
      el.onclick = function(){
        var grp = el.parentNode;
        var key = grp.getAttribute('data-grp');
        if(S.collapsedGroups[key]) delete S.collapsedGroups[key];
        else                       S.collapsedGroups[key] = true;
        grp.classList.toggle('collapsed');
      };
    });

    // scroll active / just-created row into view
    var act = S.elInboxList.querySelector('.sec64chat-row-card.active') || S.elInboxList.querySelector('.sec64chat-row-card.just-added');
    if(act){
      try{ act.scrollIntoView({ behavior:'smooth', block:'nearest' }); }catch(e){}
    }
    if(S.justCreatedRoom){
      // clear the flash flag after 2.5s so it only fires once
      setTimeout(function(){ if(S.justCreatedRoom){ S.justCreatedRoom = null; renderInbox(); } }, 2500);
    }
  }

  function renderInboxRow(r){
    // Compose title + sub-meta per thread type. Clean WhatsApp/Slack-style 3-line card:
    //   line 1: type-colored avatar · title (truncates) · timestamp
    //   line 2: sub-meta (leadId + the other person)                                 (muted)
    //   line 3: last message preview — italic "Begin chat" placeholder if no messages yet
    var typeKind, typeIcon, title, sub;
    switch (r.threadType){
      case 'task':
        typeKind = 'task'; typeIcon = '<i class="fa fa-tasks"></i>';
        title = 'Task #'+r.taskId + (r.taskName ? ' · '+esc(r.taskName) : '');
        sub   = 'L#'+r.leadId
              + (r.assignedToName ? ' · <b>'+esc(r.assignedToName)+'</b>' : '')
              + (r.taskTypeLabel ? ' <span class="rc-tag">'+esc(r.taskTypeLabel)+'</span>' : '');
        break;
      case 'customer':
        typeKind = 'customer'; typeIcon = '<i class="fa fa-user"></i>';
        title = esc(r.customerName || ('Customer · Lead #'+r.leadId));
        sub   = 'L#'+r.leadId + (r.agentName ? ' · Sales: <b>'+esc(r.agentName)+'</b>' : '');
        break;
      case 'bid_internal':
        typeKind = 'bid'; typeIcon = '<i class="fa fa-gavel"></i>';
        title = 'Bid #'+r.bidItemId + ' <span class="rc-tag">internal</span>';
        sub   = 'L#'+r.leadId + ' · T#'+r.taskId
              + (r.assignedToName ? ' · <b>'+esc(r.assignedToName)+'</b>' : '');
        break;
      case 'bid_vendor':
        typeKind = 'bidv'; typeIcon = '<i class="fa fa-handshake-o"></i>';
        title = 'Bid #'+r.bidItemId + ' → ' + esc(shortName(r.vendorName, 22));
        sub   = 'L#'+r.leadId + ' · T#'+r.taskId;
        break;
      case 'job_vendor':
        typeKind = 'job'; typeIcon = '<i class="fa fa-truck"></i>';
        title = 'Job #'+r.taskId + ' → ' + esc(shortName(r.vendorName, 22));
        sub   = 'L#'+r.leadId;
        break;
      default:
        typeKind = 'task'; typeIcon = '<i class="fa fa-comments"></i>';
        title = esc(r.title || r.roomId); sub = '';
    }

    var active   = S.roomId === r.roomId ? ' active' : '';
    var flash    = (S.justCreatedRoom && S.justCreatedRoom === r.roomId) ? ' just-added' : '';
    var unread   = r.unread > 0;
    var unreadCls = unread ? ' unread' : '';
    var unreadBadge = unread ? '<span class="rc-u" title="'+r.unread+' unread">'+ (r.unread > 99 ? '99+' : r.unread) +'</span>' : '';
    var preview  = r.lastMessage
                   ? '<span class="rc-msg">'+ esc(r.lastMessage) +'</span>'
                   : '<span class="rc-msg empty"><i class="fa fa-comment-dots"></i> Begin chat</span>';

    return '<div class="sec64chat-row-card'+active+flash+unreadCls+'" data-room="'+esc(r.roomId)+'">' +
        '<div class="rc-ava ava-'+typeKind+'">'+typeIcon+'</div>' +
        '<div class="rc-body">' +
          '<div class="rc-head">' +
            '<span class="rc-title">'+title+'</span>' +
            '<span class="rc-ts" data-ts="'+(r.lastTs||0)+'" title="Last message">'+ esc(timeAgo(r.lastTs)) +'</span>' +
          '</div>' +
          (sub ? '<div class="rc-sub">'+sub+'</div>' : '') +
          '<div class="rc-foot">' + preview + unreadBadge + '</div>' +
        '</div>' +
      '</div>';
  }

  /* ════════════════════════  SEARCH DROPDOWN (global)  ════════════════════════ */
  function initSearchDropdown(){
    if(!S.elSearch || !S.elSearchDD) return;
    var dt = null;
    S.elSearch.addEventListener('focus', renderSearchDropdown);
    S.elSearch.addEventListener('input', function(){
      clearTimeout(dt);
      dt = setTimeout(renderSearchDropdown, 220);
    });
    S.elSearch.addEventListener('keydown', function(e){ if(e.key==='Escape') closeSearch(); });
    // click outside closes
    d.addEventListener('mousedown', function(e){
      if(!S.elSearchDD) return;
      if(e.target === S.elSearch || S.elSearchDD.contains(e.target)) return;
      closeSearch();
    });
  }
  function closeSearch(){
    if(S.elSearchDD){ S.elSearchDD.style.display='none'; S.elSearchDD.innerHTML=''; }
  }
  function renderSearchDropdown(){
    if(!S.elSearchDD) return;
    var q = (S.elSearch.value||'').trim();
    if(q.length < 1){ closeSearch(); return; }
    // local matches from S.inboxRows
    var ql = q.toLowerCase();
    var local = (S.inboxRows||[]).filter(function(r){
      var hay = [
        r.title, r.leadName, r.taskName, r.taskTypeLabel,
        r.assignedToName, r.createdByName, r.agentName, r.customerName, r.vendorName,
        'lead#'+r.leadId, 'task#'+r.taskId, 'bid#'+r.bidItemId, 'job#'+r.taskId,
        'vendor#'+r.vendorId, 'customer#'+r.customerId
      ].join(' ').toLowerCase();
      return hay.indexOf(ql) !== -1;
    }).slice(0, 8);

    S.elSearchDD.innerHTML =
      (local.length
        ? '<div class="sec64chat-sec-h">From your chats</div>' +
          local.map(function(r){
            var rt = r.threadType==='customer' ? 'Lead#'+r.leadId
                   : r.threadType==='task'     ? 'Task#'+r.taskId
                   : r.threadType==='bid_internal' ? 'Bid#'+r.bidItemId+' (internal)'
                   : r.threadType==='bid_vendor'   ? 'Bid#'+r.bidItemId+' · '+esc(r.vendorName||'vendor')
                   : r.threadType==='job_vendor'   ? 'Job#'+r.taskId+' · '+esc(r.vendorName||'vendor')
                   : r.roomId;
            var sub = (r.title || r.leadName || '') + (r.createdByName ? ' · '+r.createdByName : '');
            return '<div class="sec64chat-sd-item" data-act="open-room" data-room="'+esc(r.roomId)+'">' +
                avatar(r.title || r.leadName || '?', 26) +
                '<div class="sd-col"><div class="sd-t">'+esc(rt)+'</div><div class="sd-s">'+esc(sub)+'</div></div>' +
                '<i class="fa fa-arrow-right sd-go"></i>' +
              '</div>';
          }).join('')
        : '<div class="sec64chat-sec-h">No matches in your chats</div>') +
      '<div class="sec64chat-sd-cta" data-act="crm-search">' +
        '<i class="fa fa-search-plus"></i>' +
        '<div class="sd-col"><div class="sd-t">Search in assigned lists</div><div class="sd-s">leads · tasks · bids · jobs · customers · vendors you can access</div></div>' +
      '</div>' +
      '<div class="sec64chat-sd-crm-results"></div>';

    S.elSearchDD.style.display = 'block';

    Array.prototype.forEach.call(S.elSearchDD.querySelectorAll('[data-act=open-room]'), function(el){
      el.onclick = function(){ openRoom(el.getAttribute('data-room')); closeSearch(); S.elSearch.value=''; };
    });
    var ctaEl = S.elSearchDD.querySelector('[data-act=crm-search]');
    if(ctaEl) ctaEl.onclick = function(){ runCrmSearch(q); };
  }
  function runCrmSearch(q){
    var box = S.elSearchDD && S.elSearchDD.querySelector('.sec64chat-sd-crm-results');
    if(!box) return;
    box.innerHTML = '<div class="sec64chat-sd-loading"><i class="fa fa-spinner fa-spin"></i> Searching CRM…</div>';
    fetch(S.searchUrl + '&q=' + encodeURIComponent(q), {credentials:'same-origin'})
      .then(function(r){ return r.json(); })
      .then(function(res){
        var items = (res && (res.status||res.STATUS)) ? (res.items || res.ITEMS || []) : [];
        if(!items.length){ box.innerHTML = '<div class="sec64chat-sec-h">Nothing in your assigned lists matches</div>'; return; }
        box.innerHTML = '<div class="sec64chat-sec-h">From your assigned lists</div>' + items.map(function(it){
          var kind  = it.kind  || it.KIND  || '';
          var label = it.label || it.LABEL || '';
          var sub   = it.sub   || it.SUB   || '';
          return '<div class="sec64chat-sd-item" data-kind="'+esc(kind)+'" data-args="'+esc(JSON.stringify(it.args||it.ARGS||{}))+'" data-open="'+esc(it.openWith||it.OPENWITH||'')+'">' +
              '<span class="sd-kind sd-k-'+esc(kind)+'">'+esc(kind)+'</span>' +
              '<div class="sd-col"><div class="sd-t">'+esc(label)+'</div><div class="sd-s">'+esc(sub)+'</div></div>' +
              '<i class="fa fa-arrow-right sd-go"></i>' +
            '</div>';
        }).join('');
        Array.prototype.forEach.call(box.querySelectorAll('.sec64chat-sd-item'), function(el){
          el.onclick = function(){
            var threadType = el.getAttribute('data-open');
            var args = {}; try{ args = JSON.parse(el.getAttribute('data-args')||'{}'); }catch(e){}
            openThread(Object.assign({ threadType: threadType }, args));
            closeSearch(); S.elSearch.value='';
          };
        });
      })
      .catch(function(e){ box.innerHTML = '<div class="sec64chat-sec-h">Search failed</div>'; console.error('[Sec64Chat] crm search',e); });
  }

  /* ════════════════════════  PUBLIC API  ════════════════════════ */
  w.Sec64Chat = {
    init:       init,
    open:       open,
    close:      close,
    openRoom:   openRoom,
    openThread: openThread
  };

  /* ────── backwards-compat window helpers ────── */
  w.openChatOverlay         = function(o){ openThread(o); };
  w.closeChatOverlay        = function(){ close(); };
  w.toggleChatOverlayMinimize = function(){ if(S.overlay) S.overlay.classList.toggle('minimized'); };
  w.openTaskChat            = function(leadId, taskId){             openThread({ threadType:'task',         leadId:leadId, taskId:taskId }); };
  w.openCustomerChat        = function(leadId){                     openThread({ threadType:'customer',     leadId:leadId }); };
  w.openBidInternalChat     = function(leadId, bidItemId){          openThread({ threadType:'bid_internal', leadId:leadId, bidItemId:bidItemId }); };
  w.openBidVendorChat       = function(leadId, bidItemId, vendorId){ openThread({ threadType:'bid_vendor',  leadId:leadId, bidItemId:bidItemId, vendorId:vendorId }); };
  w.openJobVendorChat       = function(leadId, taskId, vendorId){   openThread({ threadType:'job_vendor',   leadId:leadId, taskId:taskId, vendorId:vendorId }); };

})(window, document);
