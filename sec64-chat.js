/* 64sec chat plugin — vanilla JS, Firebase v8 compat (membership/audience model).
 * Reads chatRooms/chatMessages/userRooms/userNotifications/receipts from RTDB.
 * Writes messages via the CFML server (chat.send) so fan-out + receipts stay server-side.
 *   Sec64Chat.init({ thread:'#x', inbox:'#y', bell:'#z', room:{entityType:'lead',entityId:'158775'} });
 */
;(function (w, d) {
  'use strict';
  var S = {};
  var PALETTE = ['#2563eb','#7c3aed','#0891b2','#059669','#d97706','#db2777','#4f46e5','#0d9488','#b45309','#9333ea'];

  /* ---------- helpers ---------- */
  function qs(s){ return typeof s === 'string' ? d.querySelector(s) : s; }
  function el(t,c,h){ var e=d.createElement(t); if(c)e.className=c; if(h!=null)e.innerHTML=h; return e; }
  function esc(s){ return (s==null?'':String(s)).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];}); }
  function hash(s){ var h=0; s=s||''; for(var i=0;i<s.length;i++){ h=(h<<5)-h+s.charCodeAt(i); h|=0; } return h; }
  function initials(n){ n=(n||'?').trim(); if(!n)return '?'; return n.split(/\s+/).map(function(x){return x[0];}).slice(0,2).join('').toUpperCase(); }
  function avatar(name,size){ size=size||34; var c=PALETTE[Math.abs(hash(name||'?'))%PALETTE.length]; return '<span class="ava" style="width:'+size+'px;height:'+size+'px;font-size:'+Math.round(size*0.4)+'px;background:'+c+'">'+esc(initials(name))+'</span>'; }
  function sideForRole(r){ r=(r||'').toLowerCase(); if(r==='customer')return 'customer'; if(r==='vendor')return 'vendor'; return 'internal'; }
  function roleLabel(r){ var k=(r||'').toLowerCase(); var M={sales:'Sales',agent:'Sales',designer:'Designer',production:'Production Executive',ve:'Production Executive',vrm:'Production Executive',production_executive:'Production Executive',finance:'Finance',accounts:'Accounts',dispatcher:'Dispatcher',delivery:'Dispatcher',qc:'QC',tl:'Team Lead',customer:'Customer',vendor:'Vendor',admin:'Admin',manager:'Manager',salesmanager:'Sales Manager',system:'System'}; return M[k] || (r ? r.charAt(0).toUpperCase()+r.slice(1) : ''); }
  function fmt(ts){ if(!ts)return ''; var t=new Date(ts); return ('0'+t.getHours()).slice(-2)+':'+('0'+t.getMinutes()).slice(-2); }
  function dayKey(ts){ var t=new Date(ts); return t.getFullYear()+'-'+t.getMonth()+'-'+t.getDate(); }
  function dayLabel(ts){ var t=new Date(ts), n=new Date(); var k=dayKey(ts); if(k===dayKey(n.getTime()))return 'Today'; n.setDate(n.getDate()-1); if(k===dayKey(n.getTime()))return 'Yesterday'; return t.toLocaleDateString(undefined,{day:'numeric',month:'short',year:'numeric'}); }
  function canSee(side,vid,aud){ if(aud==='all')return true; if(aud==='internal')return side==='internal'; if(aud==='customer')return side==='internal'||side==='customer'; if(aud&&aud.indexOf('vendor_')===0)return side==='internal'||(side==='vendor'&&String(vid)===aud.split('_')[1]); return false; }

  function membersArr(){ var a=[]; for(var k in S.members){ var m=S.members[k]||{}; a.push({uid:k,side:m.side,role:m.role,vendorId:m.vendorId,name:m.name}); } return a; }
  function rank(m){ var sr=m.side==='internal'?0:(m.side==='customer'?1:2); var rp={sales:1,agent:1,designer:2,production:3,ve:3,finance:4,accounts:4,dispatcher:5,delivery:5,qc:6,tl:7,manager:8,salesmanager:8,admin:9}[(m.role||'').toLowerCase()]||5; return sr*100+rp; }
  function membersSorted(){ return membersArr().sort(function(a,b){ return rank(a)-rank(b); }); }
  function vendorName(vid){ for(var k in S.members){ var m=S.members[k]; if(m.side==='vendor'&&String(m.vendorId)===String(vid))return m.name; } return 'vendor'; }
  function customerName(){ for(var k in S.members){ var m=S.members[k]; if(m.side==='customer')return m.name; } return 'the customer'; }
  function displayName(m){ if(m.senderName)return m.senderName; if(S.members[m.senderId]&&S.members[m.senderId].name)return S.members[m.senderId].name; return roleLabel(m.senderRole)||m.senderId; }
  function privacy(aud){ if(aud==='all')return {priv:false}; if(aud==='internal')return {priv:true,inline:'',tip:'Team only'}; if(aud==='customer')return {priv:true,inline:'',tip:'Only the team & '+customerName()}; if(aud&&aud.indexOf('vendor_')===0){ var n=vendorName(aud.split('_')[1]); return {priv:true,inline:'only '+n,tip:'Only the team & '+n}; } return {priv:false}; }

  /* ---------- init / auth ---------- */
  function init(opts){
    opts=opts||{}; S.opts=opts;
    S.mountThread=qs(opts.thread||'#sec64chat-thread');
    S.mountInbox=opts.inbox?qs(opts.inbox):null;
    S.mountBell=opts.bell?qs(opts.bell):null;
    S.mountUpdates=opts.updates?qs(opts.updates):null;
    S.tokenUrl=opts.tokenUrl||'index.cfm?action=chat.firebaseLogin';
    S.sendUrl=opts.sendUrl||'index.cfm?action=chat.send';
    S.startUrl=opts.startUrl||'index.cfm?action=chat.start';
    S.ensureThreadUrl=opts.ensureThreadUrl||'index.cfm?action=chat.ensureThread';
    S.leadThreadsUrl=opts.leadThreadsUrl||'index.cfm?action=chat.leadThreads';
    S.uploadUrl=opts.uploadUrl||'index.cfm?action=chat.upload';
    S.soundUrl=opts.soundUrl||'';
    S.channelRefs=[]; S.chanCache={}; S.members={}; S.meta={}; S.receipts={}; S.pending=[];
    if(typeof w.firebase==='undefined'){ fail('Firebase SDK not loaded'); return; }
    if(S.mountThread) S.mountThread.innerHTML='<div class="sec64chat-empty">Signing in…</div>';
    ensureAuth().then(function(){
      if(S.mountBell) initBell();
      if(S.mountInbox) initInbox();
      // opts.openOnInit = { threadType, leadId, ... } OR opts.room = roomId — both optional
      if(opts.openOnInit) openThread(opts.openOnInit);
      else if(opts.room) openRoom(opts.room);
      else if(S.mountThread) S.mountThread.innerHTML='<div class="sec64chat-empty">Click <b>Chat</b> on a bid to open the conversation.</div>';
    }).catch(fail);
  }

  /* ---------- thread model (new) ---------- */
  // openThread({threadType:'bid_internal', leadId, taskId?, bidItemId?, vendorId?})
  function openThread(t){
    if(!t || !t.threadType || !t.leadId){ fail(new Error('openThread needs {threadType, leadId, ...}')); return; }
    if(S.mountThread) S.mountThread.innerHTML='<div class="sec64chat-empty">Opening…</div>';
    var qs='&threadType='+encodeURIComponent(t.threadType)
         +'&lead_id='+encodeURIComponent(t.leadId)
         +'&task_id='+encodeURIComponent(t.taskId||0)
         +'&bid_item_id='+encodeURIComponent(t.bidItemId||0)
         +'&vendor_id='+encodeURIComponent(t.vendorId||0);
    fetch(S.ensureThreadUrl+qs,{credentials:'same-origin'}).then(function(r){return r.json();}).then(function(res){
      if(!res||!(res.status||res.STATUS)) throw new Error((res&&(res.error||res.ERROR))||'could not open thread');
      var roomId = res.roomId || res.ROOMID;
      if(!roomId) throw new Error('missing roomId');
      openRoom(roomId);
    }).catch(fail);
  }
  function hideAll(){ [S.mountThread,S.mountInbox,S.mountBell].forEach(function(m){ if(m)m.style.display='none'; }); }
  function fail(e){ if(e&&e.notLoggedIn){ hideAll(); console.warn('[Sec64Chat] no session — chat hidden'); return; } var msg=(e&&e.message)?e.message:String(e); if(S.mountThread){ S.mountThread.style.display=''; S.mountThread.innerHTML='<div class="sec64chat-empty">Chat unavailable: '+esc(msg)+'</div>'; } console.error('[Sec64Chat]',e); }
  function ensureAuth(){
    return fetch(S.tokenUrl,{credentials:'same-origin'}).then(function(r){return r.text();}).then(function(txt){
      var dd=null; try{ dd=JSON.parse(txt); }catch(e){}
      if(!dd||!dd.status||!dd.uid){ var err=new Error((dd&&dd.error)||'login required'); err.notLoggedIn=true; throw err; }
      S.uid=String(dd.uid); S.role=dd.role||''; S.name=dd.name||''; S.side=sideForRole(S.role);
      if(!w.firebase.apps.length) w.firebase.initializeApp(dd.config);
      S.db=w.firebase.database();
      if(w.firebase.auth().currentUser) return true;
      return w.firebase.auth().signInWithEmailAndPassword(dd.email,dd.password);
    });
  }

  /* ---------- room ---------- */
  function openRoom(room){
    detach();
    if(S.mountThread) S.mountThread.innerHTML='<div class="sec64chat-empty">Loading…</div>';
    var rp=(typeof room==='string')?Promise.resolve({status:true,roomId:room})
      :fetch(S.startUrl+'&entityType='+encodeURIComponent(room.entityType)+'&entityId='+encodeURIComponent(room.entityId),{credentials:'same-origin'}).then(function(r){return r.json();});
    rp.then(function(res){
      if(!res||!res.status) throw new Error('could not open room');
      S.roomId=res.roomId; S.lastReadSent=0; S.built=false;
      var ref=S.db.ref('chatRooms/'+S.roomId);                  // live: header + members stay current
      var cb=ref.on('value',function(snap){
        var v=snap.val()||{}; S.meta=v.meta||{}; S.members=v.members||{};
        if(!S.built){ S.built=true; buildThreadShell(); subscribeChannels(); subscribeReceipts(); }
        else { renderHeader(); renderThread(); }
      });
      S.channelRefs.push({ref:ref,cb:cb});
    }).catch(fail);
  }
  function allowedChannels(){
    if(S.side==='customer')return ['all','customer'];
    if(S.side==='vendor')return ['all','vendor_'+myVendorId()];
    var ch=['all','internal','customer'];
    for(var k in S.members){ var m=S.members[k]; if(m.side==='vendor'){ var c='vendor_'+m.vendorId; if(ch.indexOf(c)<0)ch.push(c); } }
    return ch;
  }
  function myVendorId(){ var m=S.members[S.uid]; return (m&&m.vendorId)?m.vendorId:''; }
  function subscribeChannels(){ S.chanCache={}; allowedChannels().forEach(function(ch){ var ref=S.db.ref('chatMessages/'+S.roomId+'/'+ch); var cb=ref.on('value',function(s){ S.chanCache[ch]=s.val()||{}; renderThread(); }); S.channelRefs.push({ref:ref,cb:cb}); }); }
  function subscribeReceipts(){ var ref=S.db.ref('receipts/'+S.roomId); var cb=ref.on('value',function(s){ S.receipts=s.val()||{}; renderTicks(); }); S.channelRefs.push({ref:ref,cb:cb}); }
  function detach(){ (S.channelRefs||[]).forEach(function(x){ try{ x.ref.off('value',x.cb); }catch(e){} }); S.channelRefs=[]; }
  function allMessages(){ var a=[]; for(var ch in S.chanCache){ var n=S.chanCache[ch]; for(var k in n){ var m=n[k]; m._id=k; m._ch=ch; a.push(m); } } a.sort(function(x,y){return (x.ts||0)-(y.ts||0);}); return a; }

  /* ---------- thread UI ---------- */
  function buildThreadShell(){
    if(!S.mountThread)return;
    S.mountThread.style.display=''; S.mountThread.innerHTML='';
    var hd=el('div','sec64chat-hd'); S.elHd=hd; renderHeader();
    var list=el('div','sec64chat-list'); S.elList=list;
    var chips=el('div','sec64chat-chips'); S.elChips=chips;
    var comp=el('div','sec64chat-composer');
    comp.appendChild(audSelect());
    var wrap=el('div','sec64chat-inputwrap');
    var uploadReady = !!(w.Sec64Upload && w.plupload);     // attach + voice need plupload; degrade if missing
    var att=el('button','sec64chat-ic'); att.type='button'; att.id='sec64chat-attach'; att.innerHTML='<i class="fa fa-paperclip"></i>';
    var inp=el('input','sec64chat-input'); inp.type='text'; inp.placeholder='Type a message…'; S.elInput=inp;
    var voice=el('button','sec64chat-ic'); voice.type='button'; voice.innerHTML='<i class="fa fa-microphone"></i>'; voice.onclick=function(){toggleVoice(voice);};
    if (!uploadReady) { att.style.display='none'; voice.style.display='none'; }
    wrap.appendChild(att); wrap.appendChild(inp); wrap.appendChild(voice);
    var send=el('button','sec64chat-send'); send.type='button'; send.innerHTML='<i class="fa fa-paper-plane"></i>'; send.onclick=doSend;
    comp.appendChild(wrap); comp.appendChild(send);
    S.mountThread.appendChild(hd); S.mountThread.appendChild(list); S.mountThread.appendChild(chips); S.mountThread.appendChild(comp);
    inp.addEventListener('keydown',function(e){ if(e.key==='Enter')doSend(); });
    S.pending=[];
    if (uploadReady) {
      try {
        Sec64Upload.clear();
        Sec64Upload.init({browseButton:'#sec64chat-attach',dropArea:S.mountThread,url:S.uploadUrl,onUploaded:function(a){S.pending.push(a);renderChips();},onError:function(e){console.warn('[upload]',e);}});
      } catch(e) { console.warn('[Sec64Chat] upload init skipped:', e); att.style.display='none'; voice.style.display='none'; }
    }
  }
  function renderHeader(){
    if(!S.elHd)return;
    var ms=membersSorted(); if(!ms.length) ms=deriveParticipants();
    var chips = ms.length ? ms.map(function(m){ return '<span class="mchip" title="'+esc(roleLabel(m.role))+'">'+avatar(m.name,20)+'<span style="display:inline-flex;flex-direction:column"><span class="mn">'+esc(m.name||m.uid)+'</span><span class="mr">'+esc(roleLabel(m.role))+'</span></span></span>'; }).join('') : '<span class="mt">No participants yet</span>';
    S.elHd.innerHTML='<div class="sec64chat-title">'+esc(S.meta.title||S.roomId)+'<span class="cnt">'+ms.length+' participant'+(ms.length===1?'':'s')+'</span></div><div class="sec64chat-members">'+chips+'</div>';
  }
  function audSelect(){
    var sel=el('select','sec64chat-aud'); S.elAud=sel; var opts=[];
    if(S.side==='internal'){
      opts.push(['all','Everyone']); opts.push(['internal','Team only']);
      membersSorted().forEach(function(m){ if(m.side==='customer')opts.push(['customer',m.name]); else if(m.side==='vendor')opts.push(['vendor_'+m.vendorId,m.name]); });
    } else if(S.side==='customer'){ opts.push(['customer','Send']); } else { opts.push(['vendor_'+myVendorId(),'Send']); }
    opts.forEach(function(o){ var op=el('option'); op.value=o[0]; op.textContent=o[1]; sel.appendChild(op); });
    var wrap=el('div','sec64chat-to','<span>To</span>'); wrap.appendChild(sel); return wrap;
  }

  function renderThread(){
    if(!S.elList)return;
    var msgs=allMessages(); S.elList.innerHTML='';
    var prevDay='', prev=null;
    msgs.forEach(function(m){
      var dk=dayKey(m.ts||0);
      if(dk!==prevDay){ S.elList.appendChild(el('div','sec64chat-day',esc(dayLabel(m.ts||0)))); prevDay=dk; prev=null; }
      if(m.type==='system'){ S.elList.appendChild(el('div','sec64chat-system',esc(m.text))); prev=null; return; }
      if(m.type==='notification'){ S.elList.appendChild(el('div','sec64chat-row', '<div class="bubble note"><span class="ni"><i class="fa fa-bell"></i></span><div>'+esc(m.text)+'</div></div>')); prev=null; return; }
      var mine=String(m.senderId)===S.uid;
      var grp = prev && String(prev.senderId)===String(m.senderId) && prev._ch===m._ch && (m.ts-prev.ts<5*60000);
      var pv=privacy(m._ch);
      var row=el('div','sec64chat-row'+(mine?' mine':'')+(grp?' grp':''));
      var slot = mine ? '' : ('<div class="slot">'+(grp?'':avatar(displayName(m),30))+'</div>');
      var name = (!mine && !grp) ? '<div class="sname">'+esc(displayName(m))+'</div>' : '';
      var ft='<div class="ft">'+(pv.priv?'<i class="fa fa-lock lock" title="'+esc(pv.tip)+'"></i>':'')+(pv.priv&&pv.inline?'<span class="only">'+esc(pv.inline)+'</span>':'')+'<span class="tm">'+fmt(m.ts)+'</span>'+(mine?'<span class="tick" data-ts="'+(m.ts||0)+'" data-aud="'+esc(m._ch)+'"></span>':'')+'</div>';
      var bubble='<div class="bubble'+(pv.priv?' priv':'')+'">'+(m.text?esc(m.text):'')+renderAtts(m.attachments)+ft+'</div>';
      row.innerHTML=slot+'<div class="col">'+name+bubble+'</div>';
      S.elList.appendChild(row); prev=m;
    });
    S.elList.scrollTop=S.elList.scrollHeight;
    renderTicks(); markRead(msgs); renderHeader(); renderUpdates();
  }
  function renderAtts(atts){
    if(!atts)return ''; var list=Array.isArray(atts)?atts:Object.keys(atts).map(function(k){return atts[k];}); if(!list.length)return '';
    var h='<div class="atts">';
    list.forEach(function(a){ if(!a||!a.url)return; if(a.type==='image')h+='<a href="'+esc(a.url)+'" target="_blank"><img src="'+esc(a.url)+'"></a>'; else if(a.type==='voice')h+='<audio controls src="'+esc(a.url)+'"></audio>'; else h+='<a class="file" href="'+esc(a.url)+'" target="_blank"><i class="fa fa-file"></i> '+esc(a.name||'file')+'</a>'; });
    return h+'</div>';
  }
  function renderTicks(){
    if(!S.elList)return;
    Array.prototype.forEach.call(S.elList.querySelectorAll('.tick'),function(t){
      var ts=+t.getAttribute('data-ts'), aud=t.getAttribute('data-aud'), elig=eligible(aud);
      var readAll=elig.length>0&&elig.every(function(u){return rcpt(u,'lastRead')>=ts;});
      var delivAll=elig.length>0&&elig.every(function(u){return rcpt(u,'deliveredUpTo')>=ts;});
      if(readAll)t.innerHTML='<i class="fa fa-check-double" style="color:#bfe0ff"></i>';
      else if(delivAll)t.innerHTML='<i class="fa fa-check-double"></i>';
      else t.innerHTML='<i class="fa fa-check"></i>';
    });
  }
  function rcpt(u,f){ var r=S.receipts[u]; return (r&&r[f])?r[f]:0; }
  function eligible(aud){ var o=[]; for(var k in S.members){ if(k===S.uid)continue; var m=S.members[k]; if(canSee(m.side,m.vendorId,aud))o.push(k); } return o; }
  function markRead(msgs){ if(!msgs||!msgs.length||!S.roomId)return; var mx=0; msgs.forEach(function(m){ if(m.ts>mx)mx=m.ts; }); if(!mx||mx<=S.lastReadSent)return; S.lastReadSent=mx; S.db.ref('receipts/'+S.roomId+'/'+S.uid).update({lastRead:mx,deliveredUpTo:mx}).catch(function(){}); }
  function renderChips(){ if(!S.elChips)return; var a=(w.Sec64Upload?Sec64Upload.getPending():(S.pending||[])); S.elChips.innerHTML=a.map(function(x){ var ic=x.type==='image'?'image':(x.type==='voice'?'microphone':'file'); return '<span class="chip"><i class="fa fa-'+ic+'"></i> '+esc(x.name||x.type)+'</span>'; }).join(''); }
  function toggleVoice(btn){ if(!w.Sec64Upload)return; if(!S.recording){ Sec64Upload.startVoice().then(function(){S.recording=true;btn.classList.add('rec');}).catch(function(){}); } else { Sec64Upload.stopVoice(); S.recording=false; btn.classList.remove('rec'); } }
  function doSend(){
    if(!S.roomId)return; var text=(S.elInput.value||'').trim(); var atts=(w.Sec64Upload?Sec64Upload.getPending():(S.pending||[])); if(!text&&!atts.length)return;
    var aud=S.elAud?S.elAud.value:'all'; var fd=new FormData();
    fd.append('roomId',S.roomId); fd.append('audience',aud); fd.append('text',text); fd.append('type','chat'); fd.append('attachments',JSON.stringify(atts));
    S.elInput.value=''; if(w.Sec64Upload)Sec64Upload.clear(); S.pending=[]; renderChips();
    fetch(S.sendUrl,{method:'POST',credentials:'same-origin',body:fd}).then(function(r){return r.json();}).then(function(res){ if(!res||!res.status)console.warn('[send] failed',res); }).catch(function(e){console.error('[send]',e);});
  }

  /* ---------- right panel: important updates ---------- */
  function deriveParticipants(){
    var seen={}, out=[];
    allMessages().forEach(function(m){ if(m.type==='system')return; var id=String(m.senderId); if(id==='system'||id==='0'||seen[id])return; seen[id]=1; out.push({uid:id,name:m.senderName||roleLabel(m.senderRole),role:m.senderRole,side:m.senderSide,vendorId:''}); });
    return out.sort(function(a,b){ return rank(a)-rank(b); });
  }
  function noteIcon(n){ var e=(n.event||'').toLowerCase(); if(e.indexOf('quote')>=0)return 'quote-right'; if(e.indexOf('invoice')>=0)return 'file-text'; if(e.indexOf('payment')>=0)return 'credit-card'; if(e.indexOf('design')>=0)return 'paint-brush'; if(e.indexOf('delivery')>=0)return 'truck'; if(e.indexOf('artwork')>=0)return 'image'; return 'bell'; }
  function renderUpdates(){
    if(!S.mountUpdates)return;
    var msgs=allMessages();
    var notes=msgs.filter(function(m){ return m.type==='notification'; });
    var atts=[];
    msgs.forEach(function(m){ var l=m.attachments; if(!l)return; (Array.isArray(l)?l:Object.keys(l).map(function(k){return l[k];})).forEach(function(a){ if(a&&a.url){ var x={type:a.type,url:a.url,name:a.name,_by:displayName(m),_ts:m.ts}; atts.push(x); } }); });
    var h='<div class="up-hd">Important updates</div><div class="up-h">Quotes &amp; notifications</div>';
    h+= notes.length ? notes.slice().reverse().map(function(n){ var dl=(n.payload&&n.payload.deepLink)||''; return '<div class="up-card"><span class="up-ic"><i class="fa fa-'+noteIcon(n)+'"></i></span><div class="up-b"><div class="up-t">'+esc(n.text)+'</div><div class="up-m">'+fmt(n.ts)+(dl?' · <a href="'+esc(dl)+'" target="_blank">View</a>':'')+'</div></div></div>'; }).join('') : '<div class="up-empty">No updates yet</div>';
    h+='<div class="up-h">Shared files</div>';
    if(atts.length){
      var imgs=atts.filter(function(a){return a.type==='image';});
      var others=atts.filter(function(a){return a.type!=='image';});
      if(imgs.length) h+='<div class="up-grid">'+imgs.slice().reverse().map(function(a){return '<a href="'+esc(a.url)+'" target="_blank"><img src="'+esc(a.url)+'" title="'+esc(a._by||'')+'"></a>';}).join('')+'</div>';
      others.slice().reverse().forEach(function(a){ h+='<a class="up-file" href="'+esc(a.url)+'" target="_blank"><i class="fa fa-'+(a.type==='voice'?'microphone':'file')+'"></i> '+esc(a.name||a.type)+'<span class="up-by">'+esc(a._by||'')+'</span></a>'; });
    } else h+='<div class="up-empty">No files shared</div>';
    S.mountUpdates.innerHTML=h;
  }

  /* ---------- bell ---------- */
  function initBell(){
    S.mountBell.style.display=''; S.mountBell.innerHTML='<button class="sec64chat-bellbtn"><i class="fa fa-bell"></i><span class="badge" style="display:none">0</span></button><div class="sec64chat-belldrop" style="display:none"></div>';
    var btn=S.mountBell.querySelector('.sec64chat-bellbtn'), drop=S.mountBell.querySelector('.sec64chat-belldrop'), badge=S.mountBell.querySelector('.badge');
    btn.onclick=function(){ drop.style.display=(drop.style.display==='none')?'block':'none'; };
    var seen={}, primed=false;
    var audio = null;
    if (S.soundUrl) {
      try {
        audio = new Audio();
        audio.preload = 'none';              // don't fetch until play() — avoids 404 console noise if file is missing
        audio.src = S.soundUrl;
        audio.addEventListener('error', function(){ audio = null; }, { once: true });
      } catch(e) { audio = null; }
    }
    S.db.ref('userNotifications/'+S.uid).limitToLast(30).on('value',function(snap){
      var v=snap.val()||{}, items=[], newPings=0;
      for(var k in v){
        var n=v[k]; n._id=k; items.push(n);
        if(primed && !seen[k] && n.isRead===false) newPings++;
        seen[k]=1;
      }
      items.sort(function(a,b){return (b.ts||0)-(a.ts||0);});
      var unread=items.filter(function(n){return n.isRead===false;}).length;
      badge.textContent=unread; badge.style.display=unread?'inline-block':'none';
      drop.innerHTML=items.length?items.map(function(n){return '<div class="ntf'+(n.isRead===false?' nw':'')+'" data-id="'+esc(n._id)+'" data-room="'+esc(n.roomId||'')+'"><b>'+esc(n.senderName||'')+'</b> '+esc(n.title||'')+'</div>';}).join(''):'<div class="ntf">No notifications</div>';
      Array.prototype.forEach.call(drop.querySelectorAll('.ntf[data-room]'),function(e){ e.onclick=function(){ var id=e.getAttribute('data-id'),room=e.getAttribute('data-room'); if(id)S.db.ref('userNotifications/'+S.uid+'/'+id+'/isRead').set(true); if(room)openRoom(room); drop.style.display='none'; }; });
      if(newPings>0 && audio){ try{ audio.currentTime=0; audio.play().catch(function(){}); }catch(e){} }
      primed=true;
    });
  }

  /* ---------- inbox ---------- */
  function initInbox(){
    S.mountInbox.style.display='';
    S.db.ref('userRooms/'+S.uid).on('value',function(snap){
      var v=snap.val()||{}, items=[]; for(var k in v){ var r=v[k]; r._id=k; items.push(r); } items.sort(function(a,b){return (b.lastTs||0)-(a.lastTs||0);});
      S.mountInbox.innerHTML='<div class="sec64chat-inbox-h">Chats</div>'+(items.length?items.map(function(r){ return '<div class="ic" data-room="'+esc(r._id)+'">'+avatar(r.title||r._id,38)+'<div class="col"><span class="t">'+esc(r.title||r._id)+'</span><span class="p">'+esc(r.lastMessage||'')+'</span></div>'+(r.unread?'<span class="u">'+r.unread+'</span>':'')+'</div>'; }).join(''):'<div class="ic">No chats yet</div>');
      Array.prototype.forEach.call(S.mountInbox.querySelectorAll('.ic[data-room]'),function(e){ e.onclick=function(){ openRoom(e.getAttribute('data-room')); }; });
    });
  }

  function closeThread(){
    detach();
    S.roomId = null;
    S.built  = false;
    S.chanCache = {};
    if (S.mountThread) S.mountThread.innerHTML = '<div class="sec64chat-empty">Click <b>Chat</b> on a bid to open the conversation.</div>';
  }

  w.Sec64Chat={ init:init, openRoom:function(r){ openRoom(r); }, openThread:function(t){ openThread(t); }, closeThread:closeThread };
})(window, document);
