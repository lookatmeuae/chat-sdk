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
  function fmt(ts){ if(!ts)return ''; var t=new Date(ts); return ('0'+t.getHours()).slice(-2)+':'+('0'+t.getMinutes()).slice(-2); }
  function dayKey(ts){ var t=new Date(ts); return t.getFullYear()+'-'+t.getMonth()+'-'+t.getDate(); }
  function dayLabel(ts){ var t=new Date(ts), n=new Date(); var k=dayKey(ts); if(k===dayKey(n.getTime()))return 'Today'; n.setDate(n.getDate()-1); if(k===dayKey(n.getTime()))return 'Yesterday'; return t.toLocaleDateString(undefined,{day:'numeric',month:'short',year:'numeric'}); }
  function canSee(side,vid,aud){ if(aud==='all')return true; if(aud==='internal')return side==='internal'; if(aud==='customer')return side==='internal'||side==='customer'; if(aud&&aud.indexOf('vendor_')===0)return side==='internal'||(side==='vendor'&&String(vid)===aud.split('_')[1]); return false; }
  function timeAgo(ts){ if(!ts)return ''; var s=Math.floor((Date.now()-ts)/1000); if(s<60)return 'now'; if(s<3600)return Math.floor(s/60)+'m'; if(s<86400)return Math.floor(s/3600)+'h'; if(s<604800)return Math.floor(s/86400)+'d'; var t=new Date(ts); return ('0'+t.getDate()).slice(-2)+'/'+('0'+(t.getMonth()+1)).slice(-2); }

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
    if(aud==='all')return {priv:false};
    if(aud==='internal')return {priv:true,tip:'Team only'};
    if(aud==='customer')return {priv:true,tip:'Only the team & '+customerName()};
    if(aud&&aud.indexOf('vendor_')===0){ var n=vendorName(aud.split('_')[1]); return {priv:true,inline:'only '+n,tip:'Only the team & '+n}; }
    return {priv:false};
  }

  /* ════════════════════════  INIT / AUTH  ════════════════════════ */
  function init(opts){
    opts = opts || {};
    S.opts = opts;
    S.tokenUrl        = opts.tokenUrl        || 'index.cfm?action=chat.firebaseLogin';
    S.ensureThreadUrl = opts.ensureThreadUrl || 'index.cfm?action=chat.ensureThread';
    S.uploadUrl       = opts.uploadUrl       || 'index.cfm?action=chat.upload';
    S.soundUrl        = opts.soundUrl        || '';
    S.mountBell       = opts.bell ? qs(opts.bell) : null;
    S.channelRefs     = [];
    S.inboxRef        = null;
    S.bellRef         = null;
    S.notifSeen       = {};
    S.notifPrimed     = false;
    S.chanCache       = {};
    S.members         = {};
    S.meta            = {};
    S.receipts        = {};
    S.pending         = [];
    S.inboxCache      = {};
    S.roomId          = null;
    S.built           = false;
    S.shellBuilt      = false;

    if(typeof w.firebase==='undefined'){ console.warn('[Sec64Chat] firebase SDK not loaded'); return; }

    ensureAuth().then(function(){
      if(S.mountBell) initBell();
    }).catch(function(e){
      if(e&&e.notLoggedIn){ if(S.mountBell)S.mountBell.style.display='none'; console.warn('[Sec64Chat] no session — chat hidden'); return; }
      console.error('[Sec64Chat]',e);
    });
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
    var audio = null;
    if(S.soundUrl){
      try{ audio = new Audio(); audio.preload='none'; audio.src=S.soundUrl; audio.addEventListener('error',function(){audio=null;},{once:true}); }catch(e){}
    }
    S.bellRef = S.db.ref('userNotifications/'+S.uid).limitToLast(50);
    S.bellRef.on('value',function(snap){
      var v=snap.val()||{}, unread=0, pings=0;
      for(var k in v){
        var n=v[k];
        if(n.isRead===false) unread++;
        if(S.notifPrimed && !S.notifSeen[k] && n.isRead===false) pings++;
        S.notifSeen[k]=1;
      }
      badge.textContent = unread;
      badge.style.display = unread ? 'inline-block' : 'none';
      if(pings>0 && audio){ try{ audio.currentTime=0; audio.play().catch(function(){}); }catch(e){} }
      S.notifPrimed = true;
    });
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
        '<span class="t">Chats</span>' +
        '<button type="button" class="sec64chat-tb-btn" data-act="min" title="Minimize"><i class="fa fa-window-minimize"></i></button>' +
        '<button type="button" class="sec64chat-tb-btn" data-act="close" title="Close">&times;</button>' +
      '</div>' +
      '<div class="sec64chat-body">' +
        '<aside class="sec64chat-inbox">' +
          '<div class="sec64chat-search"><i class="fa fa-search"></i><input type="text" placeholder="Search chats…"></div>' +
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
    S.mountThread = ov.querySelector('.sec64chat-thread');

    ov.querySelector('[data-act=close]').onclick = function(e){ e.stopPropagation(); close(); };
    ov.querySelector('[data-act=min]').onclick   = function(e){ e.stopPropagation(); ov.classList.toggle('minimized'); };
    S.elSearch.addEventListener('input', renderInbox);
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
  }
  function close(){
    if(!S.overlay) return;
    S.overlay.classList.remove('open','minimized');
    detachRoom();
    if(S.mountThread) S.mountThread.innerHTML = '<div class="sec64chat-empty"><i class="fa fa-comments fa-2x"></i><div>Select a chat to start messaging</div></div>';
    S.roomId = null;
  }

  function openThread(t){
    if(!t || !t.threadType || !t.leadId){ console.warn('[Sec64Chat] openThread needs {threadType, leadId, ...}'); return; }
    if(!S.uid){ console.warn('[Sec64Chat] not authed yet'); return; }
    open();
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
        openRoom(res.roomId || res.ROOMID);
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

  function openRoom(roomId){
    if(!roomId) return;
    detachRoom();
    if(S.mountThread) S.mountThread.innerHTML = '<div class="sec64chat-empty">Loading…</div>';
    S.roomId = roomId;
    S.lastReadSent = 0;

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

    var comp = el('div','sec64chat-composer');
    comp.appendChild(audSelect());
    var wrap = el('div','sec64chat-inputwrap');
    var uploadReady = !!(w.Sec64Upload && w.plupload);
    var att = el('button','sec64chat-ic'); att.type='button'; att.id='sec64chat-attach'; att.innerHTML='<i class="fa fa-paperclip"></i>';
    var inp = el('input','sec64chat-input'); inp.type='text'; inp.placeholder='Type a message…'; S.elInput=inp;
    var voice = el('button','sec64chat-ic'); voice.type='button'; voice.innerHTML='<i class="fa fa-microphone"></i>'; voice.onclick = function(){ toggleVoice(voice); };
    if(!uploadReady){ att.style.display='none'; voice.style.display='none'; }
    wrap.appendChild(att); wrap.appendChild(inp); wrap.appendChild(voice);
    var send = el('button','sec64chat-send'); send.type='button'; send.innerHTML='<i class="fa fa-paper-plane"></i>'; send.onclick = doSend;
    comp.appendChild(wrap); comp.appendChild(send);

    S.mountThread.appendChild(hd);
    S.mountThread.appendChild(list);
    S.mountThread.appendChild(chips);
    S.mountThread.appendChild(comp);

    inp.addEventListener('keydown', function(e){ if(e.key==='Enter') doSend(); });
    S.pending = [];

    if(uploadReady){
      try{
        Sec64Upload.clear();
        Sec64Upload.init({
          browseButton: '#sec64chat-attach',
          dropArea:     S.mountThread,
          url:          S.uploadUrl,
          onUploaded:   function(a){ S.pending.push(a); renderChips(); },
          onError:      function(e){ console.warn('[upload]',e); }
        });
      }catch(e){ console.warn('[Sec64Chat] upload init skipped:',e); att.style.display='none'; voice.style.display='none'; }
    }
  }

  function renderHeader(){
    if(!S.elHd) return;
    var ms = membersSorted();
    var chips = ms.length
      ? ms.map(function(m){ return '<span class="sec64chat-mchip" title="'+esc(roleLabel(m.role))+'">'+avatar(m.name,20)+'<span class="mn">'+esc(m.name||m.uid)+'</span></span>'; }).join('')
      : '<span class="sec64chat-mt">No participants yet</span>';
    S.elHd.innerHTML =
      '<div class="sec64chat-title">'+esc(S.meta.title||S.roomId)+'<span class="cnt">'+ms.length+' participant'+(ms.length===1?'':'s')+'</span></div>' +
      '<div class="sec64chat-members">'+chips+'</div>';
    if(S.elTitle) S.elTitle.textContent = S.meta.title || S.roomId;
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
      var mine = String(m.senderId)===S.uid;
      var grp  = prev && String(prev.senderId)===String(m.senderId) && prev._ch===m._ch && ((m.ts||0)-(prev.ts||0) < 5*60000);
      var pv   = privacyOf(m._ch);
      var row  = el('div','sec64chat-row'+(mine?' mine':'')+(grp?' grp':''));
      var slot = mine ? '' : ('<div class="slot">'+(grp?'':avatar(displayName(m),30))+'</div>');
      var nm   = (!mine && !grp) ? '<div class="sname">'+esc(displayName(m))+'</div>' : '';
      var ft   = '<div class="ft">'+(pv.priv?'<i class="fa fa-lock lock" title="'+esc(pv.tip||'')+'"></i>':'')+(pv.priv&&pv.inline?'<span class="only">'+esc(pv.inline)+'</span>':'')+'<span class="tm">'+fmt(m.ts)+'</span>'+(mine?'<span class="tick" data-ts="'+(m.ts||0)+'" data-aud="'+esc(m._ch)+'"></span>':'')+'</div>';
      var bub  = '<div class="sec64chat-bubble'+(pv.priv?' priv':'')+'">'+(m.text?esc(m.text):'')+renderAtts(m.attachments)+ft+'</div>';
      row.innerHTML = slot + '<div class="col">'+nm+bub+'</div>';
      S.elList.appendChild(row); prev = m;
    });
    S.elList.scrollTop = S.elList.scrollHeight;
    renderTicks(); markRead(msgs);
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
      else h+='<a class="file" href="'+esc(a.url)+'" target="_blank"><i class="fa fa-file"></i> '+esc(a.name||'file')+'</a>';
    });
    return h + '</div>';
  }
  function renderTicks(){
    if(!S.elList) return;
    Array.prototype.forEach.call(S.elList.querySelectorAll('.tick'), function(t){
      var ts = +t.getAttribute('data-ts'), aud = t.getAttribute('data-aud'), elig = eligibleFor(aud);
      var readAll  = elig.length>0 && elig.every(function(u){ return rcpt(u,'lastRead')      >= ts; });
      var delivAll = elig.length>0 && elig.every(function(u){ return rcpt(u,'deliveredUpTo') >= ts; });
      if(readAll)       t.innerHTML='<i class="fa fa-check-double" style="color:#bfe0ff"></i>';
      else if(delivAll) t.innerHTML='<i class="fa fa-check-double"></i>';
      else              t.innerHTML='<i class="fa fa-check"></i>';
    });
  }
  function rcpt(u,f){ var r=S.receipts[u]; return (r&&r[f])?r[f]:0; }
  function eligibleFor(aud){ var o=[]; for(var k in S.members){ if(k===S.uid)continue; var m=S.members[k]; if(canSee(m.side, m.vendorId||'', aud)) o.push(k); } return o; }
  function markRead(msgs){
    if(!msgs||!msgs.length||!S.roomId) return;
    var mx=0; msgs.forEach(function(m){ if((m.ts||0)>mx)mx=m.ts; });
    if(!mx || mx<=S.lastReadSent) return;
    S.lastReadSent = mx;
    S.db.ref('receipts/'+S.roomId+'/'+S.uid).update({lastRead:mx, deliveredUpTo:mx}).catch(function(){});
    S.db.ref('userRooms/'+S.uid+'/'+S.roomId+'/unread').set(0).catch(function(){});
  }
  function renderChips(){
    if(!S.elChips) return;
    var a = (w.Sec64Upload ? Sec64Upload.getPending() : (S.pending||[]));
    S.elChips.innerHTML = a.map(function(x){
      var ic = x.type==='image' ? 'image' : (x.type==='voice' ? 'microphone' : 'file');
      return '<span class="chip"><i class="fa fa-'+ic+'"></i> '+esc(x.name||x.type)+'</span>';
    }).join('');
  }
  function toggleVoice(btn){
    if(!w.Sec64Upload) return;
    if(!S.recording){ Sec64Upload.startVoice().then(function(){S.recording=true;btn.classList.add('rec');}).catch(function(){}); }
    else { Sec64Upload.stopVoice(); S.recording=false; btn.classList.remove('rec'); }
  }

  /* ════════════════════════  SEND (direct Firebase write + client-side fan-out)  ════════════════════════ */
  function doSend(){
    if(!S.roomId) return;
    var text = (S.elInput.value||'').trim();
    var atts = (w.Sec64Upload ? Sec64Upload.getPending() : (S.pending||[]));
    if(!text && !atts.length) return;
    var aud = S.elAud ? S.elAud.value : 'all';

    var msg = {
      senderId:    S.uid,
      senderRole:  S.role,
      senderSide:  S.side,
      senderName:  S.name,
      type:        'chat',
      text:        text,
      audience:    aud,
      attachments: atts,
      ts:          S.TS
    };

    // optimistic UI clear
    S.elInput.value = '';
    if(w.Sec64Upload) Sec64Upload.clear();
    S.pending = []; renderChips();

    // direct write to RTDB
    S.db.ref('chatMessages/'+S.roomId+'/'+aud).push(msg).then(function(){
      var preview = text || (atts.length ? '[attachment]' : '');
      // update room meta preview
      S.db.ref('chatRooms/'+S.roomId+'/meta').update({ lastMessage: preview, lastTs: S.TS, lastAudience: aud }).catch(function(){});
      // client-side fan-out: bump unread + push notif for every eligible member (except sender)
      fanOut(preview, aud);
    }).catch(function(e){ console.error('[Sec64Chat] send failed',e); });
  }

  function fanOut(preview, aud){
    for(var uid in S.members){
      if(uid===S.uid) continue;
      var m = S.members[uid];
      if(!canSee(m.side, m.vendorId||'', aud)) continue;
      // bump unread + lastMessage on their inbox row
      (function(targetUid, side){
        var roomRef = S.db.ref('userRooms/'+targetUid+'/'+S.roomId);
        roomRef.transaction(function(cur){
          cur = cur || { entityType:'', entityId:0, title:S.meta.title||S.roomId, side:side, unread:0 };
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
          isRead:     false,
          ts:         S.TS
        }).catch(function(){});
      })(uid, m.side);
    }
  }

  /* ════════════════════════  INBOX (left pane)  ════════════════════════ */
  function subscribeInbox(){
    if(S.inboxRef){ try{ S.inboxRef.off(); }catch(e){} }
    S.inboxRef = S.db.ref('userRooms/'+S.uid);
    S.inboxRef.on('value', function(snap){
      S.inboxCache = snap.val() || {};
      renderInbox();
    });
  }

  function renderInbox(){
    if(!S.elInboxList) return;
    var q = (S.elSearch && S.elSearch.value || '').trim().toLowerCase();
    var items = [];
    for(var roomId in S.inboxCache){
      var r = S.inboxCache[roomId];
      var title = (r.title || roomId);
      if(q && title.toLowerCase().indexOf(q) === -1) continue;
      items.push({ roomId: roomId, title: title, lastMessage: r.lastMessage||'', lastTs: r.lastTs||0, unread: r.unread||0 });
    }
    items.sort(function(a,b){ return (b.lastTs||0) - (a.lastTs||0); });

    if(!items.length){
      S.elInboxList.innerHTML = '<div class="sec64chat-emptyinbox">'+(q ? 'No matches.' : 'No chats yet.')+'</div>';
      return;
    }
    S.elInboxList.innerHTML = items.map(function(it){
      return '<div class="sec64chat-ic'+(S.roomId===it.roomId?' active':'')+'" data-room="'+esc(it.roomId)+'">'+
        avatar(it.title, 36) +
        '<div class="col">' +
          '<div class="line1"><span class="t">'+esc(it.title)+'</span><span class="ts">'+esc(timeAgo(it.lastTs))+'</span></div>' +
          '<div class="line2"><span class="p">'+esc(it.lastMessage)+'</span>'+(it.unread?'<span class="u">'+it.unread+'</span>':'')+'</div>' +
        '</div>' +
      '</div>';
    }).join('');
    Array.prototype.forEach.call(S.elInboxList.querySelectorAll('.sec64chat-ic'), function(e){
      e.onclick = function(){ openRoom(e.getAttribute('data-room')); };
    });
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
