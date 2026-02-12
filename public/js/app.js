/* ═══════════════════════════════════════════════════════════
   VoxLink v3 — Client Engine
   ═══════════════════════════════════════════════════════════ */
let ws,myId,myName='',currentRoom=null,localStream=null,audioCtx=null,analyser=null;
let isMuted=false,isDeaf=false,pttMode=false,pttActive=false,settingsOpen=false,chatOpen=false;
let roomOwnerId=null,unreadChat=0;
const peers=new Map(),roomUsers=new Map(),recvBR=new Map(),userVol=new Map();
// Per-user audio data for radial waveform
const userAudioData=new Map();

let AS={
  sendBitrate:128,sampleRate:48000,channelCount:2,
  echoCancellation:true,noiseSuppression:true,autoGainControl:true,
  noiseGateThreshold:-50,dtx:false,fec:true,packetLoss:0,jitterBuffer:'adaptive'
};

const $=id=>document.getElementById(id);
const esc=s=>{const d=document.createElement('div');d.textContent=s;return d.innerHTML};

// ═══ TOASTS ═══
function toast(icon,title,msg,dur=3200){
  const c=$('toasts'),t=document.createElement('div');t.className='toast';
  t.innerHTML=`<span class="toast-i">${icon}</span><div class="toast-b"><strong>${esc(title)}</strong>${msg?`<span>${esc(msg)}</span>`:''}</div>`;
  c.appendChild(t);setTimeout(()=>{t.classList.add('out');setTimeout(()=>t.remove(),300)},dur);
}

// ═══ WEBSOCKET ═══
function connectWS(){
  const p=location.protocol==='https:'?'wss:':'ws:';
  ws=new WebSocket(`${p}//${location.host}`);
  ws.onmessage=e=>handleMsg(JSON.parse(e.data));
  ws.onclose=()=>{toast('🔌','Disconnected','Reconnecting…');setTimeout(connectWS,2000)};
}
function send(o){if(ws?.readyState===1)ws.send(JSON.stringify(o))}

function handleMsg(m){
  switch(m.type){
    case 'welcome':myId=m.userId;renderRooms(m.rooms);break;
    case 'room-list':renderRooms(m.rooms);break;
    case 'room-joined':
      currentRoom=m.roomId;roomOwnerId=m.ownerId;roomUsers.clear();
      $('hdrIcon').textContent=m.roomIcon||'🎙';
      $('roomTitle').textContent=m.roomName;
      $('roomMeta').textContent=`${m.users.length+1} users · ${m.capacity} max`;
      $('statsBar').classList.add('on');$('bottomBar').classList.add('on');
      $('emptyState').style.display='none';$('chatBody').innerHTML='';
      (m.chatHistory||[]).forEach(cm=>appendChat(cm));
      m.users.forEach(u=>{roomUsers.set(u.id,{...u,speaking:false});createPC(u.id,true)});
      renderGrid();startLocalAudio();toast('✨','Joined',m.roomName);break;
    case 'room-left':leaveCleanup();if(m.reason)toast('⚠️','Left',m.reason);break;
    case 'user-joined':
      roomUsers.set(m.userId,{id:m.userId,displayName:m.displayName,audioSettings:m.audioSettings,connQuality:m.connQuality||{},speaking:false,isMutedByAdmin:false});
      renderGrid();updMeta();toast('👋',m.displayName,'joined');addSys(`${m.displayName} joined`);break;
    case 'user-left':{
      const n=roomUsers.get(m.userId)?.displayName||'User';
      closePC(m.userId);roomUsers.delete(m.userId);recvBR.delete(m.userId);userVol.delete(m.userId);userAudioData.delete(m.userId);
      renderGrid();updMeta();addSys(`${n} left${m.reason==='kicked'?' (kicked)':''}`);break;
    }
    case 'user-updated':if(roomUsers.has(m.userId)){Object.assign(roomUsers.get(m.userId),{displayName:m.displayName,audioSettings:m.audioSettings});renderGrid()}break;
    case 'user-audio-settings-changed':if(roomUsers.has(m.userId)){roomUsers.get(m.userId).audioSettings=m.audioSettings;renderGrid()}break;
    case 'user-speaking':{
      const u=roomUsers.get(m.userId);if(!u)break;u.speaking=m.speaking;
      const t=$(`tile-${m.userId}`);if(t){t.classList.toggle('speaking',m.speaking);const b=t.querySelector('.tile-fill');if(b)b.style.width=m.speaking?`${Math.min(100,m.level)}%`:'0%'}break;
    }
    case 'user-connection-quality':if(roomUsers.has(m.userId)){roomUsers.get(m.userId).connQuality=m.connQuality;updQ(m.userId,m.connQuality)}break;
    case 'user-admin-muted':
      if(roomUsers.has(m.userId)){roomUsers.get(m.userId).isMutedByAdmin=m.muted;renderGrid()}
      if(m.userId===myId){if(m.muted){isMuted=true;if(localStream)localStream.getAudioTracks().forEach(t=>t.enabled=false);updMicBtn()}toast(m.muted?'🔇':'🎙',m.muted?'Muted by admin':'Unmuted','')}break;
    case 'room-owner-changed':roomOwnerId=m.newOwnerId;renderGrid();if(m.newOwnerId===myId)toast('👑','You\'re the owner','');break;
    case 'chat-message':appendChat(m);if(!chatOpen){unreadChat++;$('chatBadge').textContent=unreadChat;$('chatBadge').classList.add('on')}break;
    case 'offer':handleOffer(m.fromUserId,m.payload);break;
    case 'answer':handleAnswer(m.fromUserId,m.payload);break;
    case 'ice-candidate':handleICE(m.fromUserId,m.payload);break;
    case 'bitrate-request':handleBRReq(m.fromUserId,m.requestedBitrate);break;
    case 'error':toast('⚠️','Error',m.message);break;
  }
}

// ═══ AUDIO ═══
async function startLocalAudio(){
  try{
    const c={audio:{sampleRate:AS.sampleRate,channelCount:AS.channelCount,echoCancellation:AS.echoCancellation,noiseSuppression:AS.noiseSuppression,autoGainControl:AS.autoGainControl,sampleSize:24}};
    const dev=$('selInputDev').value;if(dev)c.audio.deviceId={exact:dev};
    localStream=await navigator.mediaDevices.getUserMedia(c);
    audioCtx=new AudioContext({sampleRate:AS.sampleRate});
    const src=audioCtx.createMediaStreamSource(localStream);
    analyser=audioCtx.createAnalyser();analyser.fftSize=512;analyser.smoothingTimeConstant=0.35;
    src.connect(analyser);monitorInput();
    for(const[,p]of peers)localStream.getTracks().forEach(t=>p.pc.addTrack(t,localStream));
    if(isMuted)localStream.getAudioTracks().forEach(t=>t.enabled=false);
  }catch(e){toast('❌','Mic Error',e.message)}
}

function monitorInput(){
  if(!analyser)return;
  const data=new Uint8Array(analyser.frequencyBinCount);
  (function tick(){
    if(!analyser)return;
    analyser.getByteFrequencyData(data);
    let sum=0;for(let i=0;i<data.length;i++)sum+=data[i]*data[i];
    const rms=Math.sqrt(sum/data.length),lvl=Math.min(100,(rms/128)*100);
    const im=$('inMeter');if(im)im.style.width=`${lvl}%`;
    const st=$(`tile-${myId}`);
    if(st){
      const mb=st.querySelector('.tile-fill');if(mb)mb.style.width=`${lvl}%`;
      const db=20*Math.log10(rms/255+.0001);
      let speaking=pttMode?(pttActive&&!isMuted&&db>AS.noiseGateThreshold):(!isMuted&&db>AS.noiseGateThreshold);
      st.classList.toggle('speaking',speaking);
      // Draw radial waveform
      drawRadial($(`rad-${myId}`),data,speaking);
      send({type:'speaking',speaking,level:Math.round(lvl)});
    }
    // Update peer radial visualizations from their analysers
    for(const[uid,pd]of peers){
      if(pd.analyser){
        const d=new Uint8Array(pd.analyser.frequencyBinCount);
        pd.analyser.getByteFrequencyData(d);
        drawRadial($(`rad-${uid}`),d,roomUsers.get(uid)?.speaking);
      }
    }
    requestAnimationFrame(tick);
  })();
}

// ═══ RADIAL WAVEFORM — updated for cleaner UI ═══
function drawRadial(canvas,data,active){
  if(!canvas)return;
  const ctx=canvas.getContext('2d');
  const w=canvas.width,h=canvas.height;
  const cx=w/2,cy=h/2;
  ctx.clearRect(0,0,w,h);

  // New design: smooth rounded bars around the avatar
  const r=38; // Inner radius
  const len=10; // Max length
  const bars=40;
  const step=Math.PI*2/bars;

  ctx.lineCap='round';
  ctx.lineWidth=2.5;

  for(let i=0;i<bars;i++){
     const bin = Math.floor(i * (data.length / bars) * 0.5);
     const val = (data[bin]||0) / 255;

     if(val < 0.05 && !active) continue;

     const l = active ? Math.max(2, val * len + 2) : 2;

     const ang = i*step - Math.PI/2;
     const x1 = cx + Math.cos(ang) * r;
     const y1 = cy + Math.sin(ang) * r;
     const x2 = cx + Math.cos(ang) * (r + l);
     const y2 = cy + Math.sin(ang) * (r + l);

     ctx.strokeStyle = active ? '#30d158' : 'rgba(255,255,255,0.1)';
     ctx.beginPath();
     ctx.moveTo(x1,y1);
     ctx.lineTo(x2,y2);
     ctx.stroke();
  }
}

// ═══ WEBRTC ═══
const rtcCfg={iceServers:[{urls:'stun:stun.l.google.com:19302'},{urls:'stun:stun1.l.google.com:19302'}]};

function createPC(uid,init){
  if(peers.has(uid))return peers.get(uid);
  const pc=new RTCPeerConnection(rtcCfg),pd={pc,audio:null,gain:null,analyser:null};
  peers.set(uid,pd);
  if(localStream)localStream.getTracks().forEach(t=>pc.addTrack(t,localStream));
  pc.ontrack=e=>{
    const audio=new Audio();audio.srcObject=e.streams[0];audio.autoplay=true;pd.audio=audio;
    const od=$('selOutputDev').value;if(od&&audio.setSinkId)audio.setSinkId(od).catch(()=>{});
    try{
      const ctx=audioCtx||new AudioContext(),src=ctx.createMediaStreamSource(e.streams[0]);
      const an=ctx.createAnalyser(),gn=ctx.createGain();
      an.fftSize=512;an.smoothingTimeConstant=0.35;gn.gain.value=userVol.get(uid)??1;
      src.connect(an);src.connect(gn);gn.connect(ctx.destination);
      pd.analyser=an;pd.gain=gn;audio.muted=true;
    }catch(e){}
  };
  pc.onicecandidate=e=>{if(e.candidate)send({type:'ice-candidate',targetUserId:uid,payload:e.candidate})};
  if(init)makeOffer(uid,pc);return pd;
}

async function makeOffer(uid,pc){try{const o=await pc.createOffer({offerToReceiveAudio:true,offerToReceiveVideo:false});o.sdp=tweakSDP(o.sdp);await pc.setLocalDescription(o);send({type:'offer',targetUserId:uid,payload:o})}catch(e){}}
async function handleOffer(uid,offer){let pd=peers.get(uid)||createPC(uid,false);try{await pd.pc.setRemoteDescription(new RTCSessionDescription(offer));const a=await pd.pc.createAnswer();a.sdp=tweakSDP(a.sdp);await pd.pc.setLocalDescription(a);send({type:'answer',targetUserId:uid,payload:a})}catch(e){}}
async function handleAnswer(uid,ans){const pd=peers.get(uid);if(pd)try{await pd.pc.setRemoteDescription(new RTCSessionDescription(ans))}catch(e){}}
async function handleICE(uid,c){const pd=peers.get(uid);if(pd)try{await pd.pc.addIceCandidate(new RTCIceCandidate(c))}catch(e){}}
function closePC(uid){const pd=peers.get(uid);if(!pd)return;if(pd.audio){pd.audio.pause();pd.audio.srcObject=null}if(pd.gain)pd.gain.disconnect();pd.pc.close();peers.delete(uid)}

function tweakSDP(sdp){
  const s=AS,bps=s.sendBitrate*1000,st=s.channelCount===2?'1':'0';
  const p=`maxaveragebitrate=${bps};stereo=${st};sprop-stereo=${st};usedtx=${s.dtx?1:0};useinbandfec=${s.fec?1:0};maxplaybackrate=${s.sampleRate}`;
  if(sdp.includes('a=fmtp:111'))sdp=sdp.replace(/a=fmtp:111 .+/,`a=fmtp:111 minptime=10;useinbandfec=1;${p}`);
  else sdp=sdp.replace(/(a=rtpmap:111 opus\/48000\/2\r?\n)/,`$1a=fmtp:111 minptime=10;${p}\r\n`);
  sdp=sdp.replace(/b=AS:\d+/g,`b=AS:${s.sendBitrate}`);
  if(!sdp.includes('b=AS:'))sdp=sdp.replace(/(m=audio .+\r?\n)/,`$1b=AS:${s.sendBitrate}\r\n`);
  return sdp;
}

function handleBRReq(uid,kbps){const pd=peers.get(uid);if(!pd)return;pd.pc.getSenders().forEach(s=>{if(s.track?.kind==='audio'){const p=s.getParameters();if(!p.encodings)p.encodings=[{}];p.encodings[0].maxBitrate=kbps*1000;s.setParameters(p).catch(()=>{})}})}
function reqBR(uid,kbps){recvBR.set(uid,kbps);send({type:'request-bitrate',targetUserId:uid,bitrate:kbps})}

// ═══ STATS ═══
setInterval(async()=>{
  if(!currentRoom||peers.size===0)return;
  let tR=0,tJ=0,tL=0,n=0;
  for(const[,pd]of peers){try{const stats=await pd.pc.getStats();stats.forEach(r=>{if(r.type==='inbound-rtp'&&r.kind==='audio'){const j=r.jitter?(r.jitter*1000).toFixed(1):0,l=r.packetsLost||0,rv=r.packetsReceived||1;tJ+=parseFloat(j);tL+=l/(l+rv)*100;n++}if(r.type==='candidate-pair'&&r.state==='succeeded'&&r.currentRoundTripTime!==undefined)tR+=r.currentRoundTripTime*1000})}catch(e){}}
  if(n>0){
    const aR=(tR/n).toFixed(0),aJ=(tJ/n).toFixed(1),aL=(tL/n).toFixed(1);
    $('stRtt').textContent=`${aR}ms`;$('stJit').textContent=`${aJ}ms`;$('stLoss').textContent=`${aL}%`;
    $('stDot').className='dot'+(+aL>5?' r':+aL>1?' w':''); // Updated to .dot
    const tx=AS.sendBitrate*peers.size;let rx=0;for(const[uid]of peers){const u=roomUsers.get(uid);rx+=(u?.audioSettings?.sendBitrate||128)}
    $('stBwUp').textContent=tx>999?`${(tx/1000).toFixed(1)}M`:`${tx}k`;
    $('stBwDn').textContent=rx>999?`${(rx/1000).toFixed(1)}M`:`${rx}k`;
    send({type:'connection-quality',rtt:+aR,jitter:+aJ,packetLoss:+aL});
  }
  $('stTx').textContent=`${AS.sendBitrate}k`;$('stRate').textContent=`${AS.sampleRate/1000}kHz`;$('stCh').textContent=AS.channelCount===2?'ST':'MO';
},2000);

// ═══ RENDERING ═══
function renderRooms(rooms){
  const c=$('roomList');c.innerHTML=''; // Clean list
  rooms.forEach(r=>{
    const el=document.createElement('div');
    el.className=`ri${currentRoom===r.id?' active':''}`;
    el.onclick=()=>tryJoin(r);
    const avs=(r.users||[]).slice(0,3).map(u=>`<div class="ri-av">${(u.displayName||'?')[0].toUpperCase()}</div>`).join('');
    const extra=r.userCount>3?`<div class="ri-av">+${r.userCount-3}</div>`:'';
    const hasSpeaker=(r.users||[]).some(u=>u.speaking);
    el.innerHTML=`<div class="ri-ico">${r.icon||'🎙'}</div><div class="ri-body"><div class="ri-name">${esc(r.name)}</div><div class="ri-sub"><div class="ri-live${r.userCount>0?' on':''}"></div>${r.userCount}/${r.capacity}${r.hasPassword?' <span class="ri-lock">🔒</span>':''}</div></div>${avs||extra?`<div class="ri-avs">${avs}${extra}</div>`:''}`;
    c.appendChild(el);
  });
}

let pendingJoin=null;
function tryJoin(r){if(currentRoom===r.id)return;if(r.hasPassword){pendingJoin=r.id;$('modalPw').classList.add('open');$('pwInput').value='';$('pwInput').focus()}else send({type:'join-room',roomId:r.id})}

function renderGrid(){
  const g=$('voiceGrid');g.innerHTML='';
  g.appendChild(mkTile(myId,myName,AS,true,{}));
  for(const[uid,u]of roomUsers){const t=mkTile(uid,u.displayName,u.audioSettings,false,u.connQuality||{},u.isMutedByAdmin);if(u.speaking)t.classList.add('speaking');g.appendChild(t)}
}

function mkTile(uid,name,s,self,cq,mba=false){
  const t=document.createElement('div');
  t.className=`tile${self?' self':''}${mba?' muted-admin':''}${(self&&isMuted)||mba?' is-muted':''}`;
  t.id=`tile-${uid}`;
  const init=(name||'?')[0].toUpperCase();
  const br=s?.sendBitrate||128;
  const isOwn=uid===roomOwnerId,amOwn=myId===roomOwnerId;
  const pl=cq?.packetLoss||0;
  const bars=[pl<5,pl<3,pl<1];

  t.innerHTML=`
    ${isOwn?'<div class="tile-crown">👑</div>':''}
    <div class="tile-q">${[0,1,2].map(i=>`<div class="tile-qb ${bars[i]?(pl>3?'w':'g'):(pl>5?'r':'')}"></div>`).join('')}</div>
    <div class="av-wrap">
      <canvas class="av-radial" width="100" height="100" id="rad-${uid}"></canvas>
      <div class="av-circle">${init}</div>
      <div class="av-muted"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2c0 .76-.12 1.49-.34 2.18"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg></div>
    </div>
    <div class="tile-name">${esc(name)}${self?' <span class="tile-you">(you)</span>':''}</div>
    <div class="tile-tag">${br}k · ${s?.channelCount===2?'ST':'MO'} · ${(s?.sampleRate||48000)/1000}k</div>
    <div class="tile-bar"><div class="tile-fill"></div></div>
    ${!self?`<div class="tile-ctrls">
      <div class="tc-row"><span class="tc-lbl">Volume</span><span class="tc-val" id="vv-${uid}">${Math.round((userVol.get(uid)??1)*100)}%</span></div>
      <input type="range" min="0" max="200" value="${Math.round((userVol.get(uid)??1)*100)}" oninput="setVol('${uid}',this.value)">
      <div class="tc-row"><span class="tc-lbl">Receive</span><span class="tc-val" id="rv-${uid}">${recvBR.get(uid)||br}k</span></div>
      <input type="range" min="6" max="510" value="${recvBR.get(uid)||br}" step="2" oninput="setRBR('${uid}',this.value)">
    </div>
    <div class="tile-adm ${amOwn&&!self?'show':''}">
      <button class="abtn m" onclick="adminMute('${uid}')">${mba?'Unmute':'Mute'}</button>
      <button class="abtn k" onclick="adminKick('${uid}')">Kick</button>
    </div>`:''}`;
  return t;
}

function setVol(uid,v){const vol=+v/100;userVol.set(uid,vol);const pd=peers.get(uid);if(pd?.gain)pd.gain.gain.value=isDeaf?0:vol;const l=$(`vv-${uid}`);if(l)l.textContent=`${v}%`}
function setRBR(uid,v){reqBR(uid,+v);const l=$(`rv-${uid}`);if(l)l.textContent=`${v}k`}
function adminMute(uid){send({type:'admin-mute',targetUserId:uid})}
function adminKick(uid){if(confirm('Kick this user?'))send({type:'admin-kick',targetUserId:uid})}

function updQ(uid,cq){const el=$(`tile-${uid}`);if(!el)return;const bs=el.querySelectorAll('.tile-qb'),pl=cq?.packetLoss||0;[pl<5,pl<3,pl<1].forEach((on,i)=>{bs[i].className=`tile-qb ${on?(pl>3?'w':'g'):(pl>5?'r':'')}`})}
function updMeta(){$('roomMeta').textContent=`${roomUsers.size+1} users in room`}

// ═══ CHAT ═══
function appendChat(m){
  const b=$('chatBody'),d=document.createElement('div'),self=m.userId===myId;
  d.className=`cm${self?' mine':''}`;
  const t=new Date(m.timestamp).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
  const init=(m.displayName||'?')[0].toUpperCase();
  d.innerHTML=`<div class="cm-av">${init}</div><div class="cm-body"><div class="cm-head"><span class="cm-name${self?' self':''}">${esc(m.displayName)}</span><span class="cm-time">${t}</span></div><div class="cm-text">${esc(m.text)}</div></div>`;
  b.appendChild(d);b.scrollTop=b.scrollHeight;
}
function addSys(t){const b=$('chatBody'),d=document.createElement('div');d.className='cm-sys';d.textContent=t;b.appendChild(d);b.scrollTop=b.scrollHeight}

$('chatInput').onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();const t=$('chatInput').value.trim();if(t&&currentRoom){send({type:'chat-message',text:t});$('chatInput').value=''}}};

// ═══ CONTROLS ═══
function leaveCleanup(){
  for(const[uid]of peers)closePC(uid);
  roomUsers.clear();recvBR.clear();userVol.clear();userAudioData.clear();currentRoom=null;roomOwnerId=null;
  if(localStream){localStream.getTracks().forEach(t=>t.stop());localStream=null}
  $('hdrIcon').textContent='🎙';$('roomTitle').textContent='Select a room';$('roomMeta').textContent='Pick a room to join voice';
  $('statsBar').classList.remove('on');$('bottomBar').classList.remove('on');
  $('voiceGrid').innerHTML='<div class="empty-state" id="emptyState"><h3>No one\'s here</h3><p>Join a room to start talking.</p></div>';
  $('chatBody').innerHTML='';
}

function updMicBtn(){
  $('btnMic').classList.toggle('muted',isMuted);
  const st=$(`tile-${myId}`);if(st)st.classList.toggle('is-muted',isMuted);
}
function toggleMute(){if(pttMode)return;isMuted=!isMuted;if(localStream)localStream.getAudioTracks().forEach(t=>t.enabled=!isMuted);updMicBtn()}
function toggleDeaf(){isDeaf=!isDeaf;$('btnDeaf').classList.toggle('on',isDeaf);for(const[uid,pd]of peers){if(pd.gain)pd.gain.gain.value=isDeaf?0:(userVol.get(uid)??1);if(pd.audio)pd.audio.muted=isDeaf}}

$('btnMic').onclick=toggleMute;
$('btnDeaf').onclick=toggleDeaf;
$('btnDc').onclick=()=>{if(currentRoom){send({type:'leave-room'});leaveCleanup()}};
$('btnPtt').onclick=()=>{pttMode=!pttMode;$('btnPtt').textContent=pttMode?'PTT ●':'PTT';$('btnPtt').classList.toggle('active',pttMode);if(pttMode&&localStream)localStream.getAudioTracks().forEach(t=>t.enabled=false);else if(localStream)localStream.getAudioTracks().forEach(t=>t.enabled=!isMuted)};

$('btnSettings').onclick=()=>{settingsOpen=!settingsOpen;$('settingsPanel').classList.toggle('open',settingsOpen);$('btnSettings').classList.toggle('on',settingsOpen)};
$('btnCloseSets').onclick=()=>{settingsOpen=false;$('settingsPanel').classList.remove('open');$('btnSettings').classList.remove('on')};
$('btnChat').onclick=()=>{chatOpen=!chatOpen;$('chatPanel').classList.toggle('open',chatOpen);$('btnChat').classList.toggle('on',chatOpen);if(chatOpen){$('chatInput').focus();unreadChat=0;$('chatBadge').classList.remove('on');$('chatBadge').textContent='0'}};
$('btnCloseChat').onclick=()=>{chatOpen=false;$('chatPanel').classList.remove('open');$('btnChat').classList.remove('on')};

// ═══ KEYBOARD ═══
document.addEventListener('keydown',e=>{
  if(['INPUT','TEXTAREA','SELECT'].includes(e.target.tagName)){if(e.key==='Escape')e.target.blur();return}
  switch(e.key.toLowerCase()){
    case 'm':if(currentRoom)toggleMute();break;
    case 'd':if(currentRoom)toggleDeaf();break;
    case 's':$('btnSettings').click();break;
    case 'c':$('btnChat').click();break;
    case 'escape':if(currentRoom){send({type:'leave-room'});leaveCleanup()}closeModals();break;
    case ' ':if(pttMode&&currentRoom){e.preventDefault();pttActive=true;$('btnPtt').classList.add('active');if(localStream)localStream.getAudioTracks().forEach(t=>t.enabled=true)}break;
  }
});
document.addEventListener('keyup',e=>{if(e.key===' '&&pttMode&&currentRoom){pttActive=false;$('btnPtt').classList.remove('active');if(localStream)localStream.getAudioTracks().forEach(t=>t.enabled=false)}});

// ═══ SETTINGS ═══
$('sBit').oninput=function(){AS.sendBitrate=+this.value;$('vBit').textContent=`${this.value} kbps`;syncS();applyBR()};
$('selRate').onchange=function(){AS.sampleRate=+this.value;syncS();restartA()};
$('selCh').onchange=function(){AS.channelCount=+this.value;syncS();restartA()};
$('sGate').oninput=function(){AS.noiseGateThreshold=+this.value;$('vGate').textContent=`${this.value} dB`;syncS()};
$('sLoss').oninput=function(){AS.packetLoss=+this.value;$('vLoss').textContent=`${this.value}%`;syncS()};
$('selJit').onchange=function(){AS.jitterBuffer=this.value;syncS()};
// Updated selector for toggles (.toggle instead of .tg)
document.querySelectorAll('.toggle').forEach(t=>{t.onclick=function(){this.classList.toggle('on');const k=this.dataset.k;if(k){AS[k]=this.classList.contains('on');syncS();if(['echoCancellation','noiseSuppression','autoGainControl'].includes(k))restartA()}}});

function syncS(){send({type:'update-audio-settings',settings:AS})}
function applyBR(){for(const[,pd]of peers)pd.pc.getSenders().forEach(s=>{if(s.track?.kind==='audio'){const p=s.getParameters();if(!p.encodings)p.encodings=[{}];p.encodings[0].maxBitrate=AS.sendBitrate*1000;s.setParameters(p).catch(()=>{})}})}
async function restartA(){if(!currentRoom)return;if(localStream)localStream.getTracks().forEach(t=>t.stop());await startLocalAudio();for(const[uid,pd]of peers)makeOffer(uid,pd.pc)}

async function enumDevs(){try{const d=await navigator.mediaDevices.enumerateDevices();const i=$('selInputDev'),o=$('selOutputDev');i.innerHTML='';o.innerHTML='';d.forEach(x=>{const op=document.createElement('option');op.value=x.deviceId;op.textContent=x.label||`${x.kind} ${x.deviceId.slice(0,8)}`;if(x.kind==='audioinput')i.appendChild(op);if(x.kind==='audiooutput')o.appendChild(op)})}catch(e){}}
$('selInputDev').onchange=()=>{if(currentRoom)restartA()};
$('selOutputDev').onchange=()=>{const d=$('selOutputDev').value;for(const[,pd]of peers)if(pd.audio?.setSinkId)pd.audio.setSinkId(d).catch(()=>{})};

function applyPreset(p){
  const pr={voice:{sendBitrate:64,sampleRate:48000,channelCount:1,echoCancellation:true,noiseSuppression:true,autoGainControl:true,dtx:true,fec:true,noiseGateThreshold:-45},music:{sendBitrate:320,sampleRate:48000,channelCount:2,echoCancellation:false,noiseSuppression:false,autoGainControl:false,dtx:false,fec:true,noiseGateThreshold:-80},lowbw:{sendBitrate:16,sampleRate:16000,channelCount:1,echoCancellation:true,noiseSuppression:true,autoGainControl:true,dtx:true,fec:false,noiseGateThreshold:-40},studio:{sendBitrate:510,sampleRate:48000,channelCount:2,echoCancellation:false,noiseSuppression:false,autoGainControl:false,dtx:false,fec:true,noiseGateThreshold:-70},podcast:{sendBitrate:192,sampleRate:48000,channelCount:1,echoCancellation:true,noiseSuppression:true,autoGainControl:false,dtx:false,fec:true,noiseGateThreshold:-55}};
  if(!pr[p])return;Object.assign(AS,pr[p]);updUI();syncS();applyBR();if(currentRoom)restartA();toast('🎛','Preset',p[0].toUpperCase()+p.slice(1));
}
function updUI(){$('sBit').value=AS.sendBitrate;$('vBit').textContent=`${AS.sendBitrate} kbps`;$('selRate').value=AS.sampleRate;$('selCh').value=AS.channelCount;$('sGate').value=AS.noiseGateThreshold;$('vGate').textContent=`${AS.noiseGateThreshold} dB`;$('sLoss').value=AS.packetLoss;$('vLoss').textContent=`${AS.packetLoss}%`;$('selJit').value=AS.jitterBuffer;$('tEcho').classList.toggle('on',AS.echoCancellation);$('tNoise').classList.toggle('on',AS.noiseSuppression);$('tAGC').classList.toggle('on',AS.autoGainControl);$('tDTX').classList.toggle('on',AS.dtx);$('tFEC').classList.toggle('on',AS.fec)}

// ═══ MODALS ═══
$('btnNewRoom').onclick=()=>{$('modalNewRoom').classList.add('open');$('nrName').focus()};
function closeModals(){$('modalNewRoom').classList.remove('open');$('modalPw').classList.remove('open');pendingJoin=null}
function submitNewRoom(){const n=$('nrName').value.trim();if(!n)return;send({type:'create-room',name:n,description:$('nrDesc').value.trim(),icon:$('nrIcon').value,password:$('nrPw').value||null,capacity:+$('nrCap').value||25});$('nrName').value='';$('nrDesc').value='';$('nrPw').value='';closeModals()}
$('nrName').onkeydown=e=>{if(e.key==='Enter')submitNewRoom()};
$('pwSubmit').onclick=()=>{if(pendingJoin){send({type:'join-room',roomId:pendingJoin,password:$('pwInput').value});closeModals()}};
$('pwInput').onkeydown=e=>{if(e.key==='Enter')$('pwSubmit').click()};
// Updated selector for modals (.modal-overlay instead of .mbg)
document.querySelectorAll('.modal-overlay').forEach(bg=>{bg.addEventListener('click',e=>{if(e.target===bg)closeModals()})});

// ═══ BOOT ═══
$('joinBtn').onclick=enterApp;
$('nameInput').onkeydown=e=>{if(e.key==='Enter')enterApp()};
function enterApp(){
  const n=$('nameInput').value.trim();
  if(!n){$('nameInput').style.borderColor='var(--accent-red)';$('nameInput').focus();return}
  myName=n;$('onboarding').style.display='none';$('app').style.display='flex';
  connectWS();enumDevs();
  const iv=setInterval(()=>{if(ws?.readyState===1){send({type:'set-name',displayName:myName});clearInterval(iv)}},100);
}
navigator.mediaDevices?.addEventListener('devicechange',enumDevs);
