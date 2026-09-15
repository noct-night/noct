/* NOCT client. Split out of index.html so UI work and app logic stop colliding in one file. */
/* ---------- sample data (RA New York City, Fri 28 to Sun 30 Aug 2026). FALLBACK ONLY: loadFeed() at the bottom
   replaces DAYS / EV / VENUES / GENRES / AREAS / PRESETS from /api/feed; ?demo=1 keeps these. ---------- */
let DAYS=[['Fri','Aug 28','Tonight'],['Sat','Aug 29','Tomorrow'],['Sun','Aug 30','Sunday']];
let EV=[
{id:1,d:0,head:'Vladimir Ivkovic All Night',lineup:['Vladimir Ivkovic'],venue:'Nowadays',
 door:'22:00',close:'06:00',genre:['Electro','Electronica'],gsrc:'RA tags',age:'21+',interested:544,
 srcs:[['Nowadays RSVP',10,'$10 before 23:00, $15 before midnight. Does not guarantee entry.'],['RA ticket',20,'On sale, $20 and up']],
 ra:'https://ra.co/events/2478685',tex:'x1',full:true,
 note:'Nowadays resident and Offen Music founder, playing the full night. Low tempo, psychedelic, drawing on coldwave and outsider dance music.'},

{id:2,d:0,head:'Warm Up: TDJ, De Schuurman, keiyaA, DJ WORKING CLASS',lineup:['TDJ','De Schuurman','keiyaA','DJ WORKING CLASS'],venue:'MoMA PS1',
 door:'16:00',close:'22:00',genre:['Bubbling','R&B','Baile funk','Trance'],gsrc:'line-up and venue notes',age:'',interested:451,
 srcs:[['Eventbrite advance',25,'Advance admission, includes the galleries'],['Student or member',20,'Advance, valid ID required'],['Eventbrite day-of',35,'On the door']],
 ra:'https://ra.co/events/2491125',eb:'https://www.eventbrite.com/e/warm-up-tdj-de-schuurmankeiyaa-dj-working-class-tickets-1991423044935',tex:'x3',full:true,
 note:'The last Friday of the 28th Warm Up season, outdoors in the PS1 courtyard. Long Island City residents in 11101, 11106 and 11109 get one free ticket per event.'},

{id:3,d:0,head:'Night & Day: Eli Escobar, The Carry Nation, Dee Diggs, Arvin T b2b Sissies of Mercy',
 lineup:['Eli Escobar','The Carry Nation','Dee Diggs','Arvin T b2b Sissies of Mercy'],venue:'Signal',
 door:'22:00',close:'',genre:['House','Disco','Ballroom'],gsrc:'line-up',age:'',interested:456,
 srcs:[['Dice',22.66,'From $22.66'],['RA',null,'On sale']],
 ra:'https://ra.co/events/2479515',dice:'https://dice.fm/venue/signal-8ee9w',tex:'x5',full:true,
 note:'A long one. The Night & Day parties at Signal run from late Friday into Saturday afternoon.'},

{id:4,d:0,head:'SHEILA',lineup:[],venue:'H0L0',
 door:'',close:'',genre:[],gsrc:'',age:'',interested:260,
 srcs:[['RA',null,'See listing']],ra:'https://ra.co/events/2506666',tex:'x2',full:false,note:''},

{id:5,d:0,head:'Magnetic ft Artwork, Alex McCracken, Victor Florescu, UMA DJ, Boat Neck, Lee Cash, whydan',
 lineup:['Artwork','Alex McCracken','Victor Florescu','UMA DJ','Boat Neck','Lee Cash','whydan'],venue:'Good Room',
 door:'',close:'',genre:[],gsrc:'',age:'',interested:208,
 srcs:[['RA',null,'See listing']],ra:'https://ra.co/events/2499263',tex:'x6',full:false,note:''},

{id:6,d:1,head:'Yonti, Beste Hira, Annie Lew / Jason Kendig b2b James Axon, Kilopatrah Jones, Immy',
 lineup:['Yonti','Beste Hira','Annie Lew','Jason Kendig b2b James Axon','Kilopatrah Jones','Immy'],venue:'BASEMENT',
 door:'22:30',close:'07:00',genre:['Techno'],gsrc:'listing text',age:'21+',interested:1800,
 srcs:[['RA',null,'Sold out. Resale queue is active.']],ra:'https://ra.co/events/2482516',tex:'x4',full:true,soldout:true,
 note:'Two rooms. Yonti headlines the main room with Beste Hira and Annie Lew. Jason Kendig goes back to back with James Axon in STUDIO. No phones on the dancefloor.'},

{id:7,d:1,head:"Chaos In The CBD presents 'Dust Till Dawn'",lineup:['Chaos In The CBD','Joe Claussell','Floorplan','Shy One','Suze Ijo','DJ Ray','Extra Andrew'],venue:'Knockdown Center',
 door:'15:00',close:'',genre:['Deep house','House'],gsrc:'RA tags',age:'21+',interested:793,
 srcs:[['Dice',38.17,'From $38.17'],['RA',null,'On sale']],
 ra:'https://ra.co/events/2473602',dice:'https://dice.fm/event/eoxvey-chaos-in-the-cbd-joe-claussell-floorplan-more-day-night-29th-aug-knockdown-center-new-york-ruins-at-knockdown-center-new-york-tickets',tex:'x1',full:true,
 note:'Starts in The Ruins as the sun goes down and moves into the Main Hall until dawn.'},

{id:8,d:1,head:'Nonstop: Leeon, LOKA, MCMLXXXV, Ne/Re/A, Solofan, Voices From The Lake (live)',
 lineup:['Solofan','LOKA (US)','MCMLXXXV','Ne/Re/A','Leeon','Voices From The Lake (live)'],venue:'Nowadays',
 door:'22:00',close:'15:00',genre:['Techno','Electro'],gsrc:'RA tags',age:'',interested:1300,
 set:[['22:00','Solofan'],['01:00','LOKA (US)'],['03:30','MCMLXXXV'],['06:00','Ne/Re/A'],['09:00','Leeon'],['12:00','Voices From The Lake (live)']],
 srcs:[['RA',null,'On sale']],ra:'https://ra.co/events/2478702',tex:'x4',full:true,
 note:'Seventeen hours, Saturday night into Sunday afternoon. High-energy techno, acid and electro.'},

{id:9,d:1,head:'Luar presents: Vessels Chapter 2 - Alexis De La Rosa, Morenxxx, Sevyn Love, Bobby Beethoven, Alfonso Javier',
 lineup:['Alexis De La Rosa','Morenxxx','Sevyn Love','Bobby Beethoven','Alfonso Javier'],venue:'Signal',
 door:'22:00',close:'',genre:['House','DnB','Latin'],gsrc:'line-up',age:'',interested:440,
 srcs:[['Dice',28.33,'$28.33'],['RA',null,'On sale']],
 ra:'https://ra.co/events/2500400',dice:'https://dice.fm/venue/signal-8ee9w',tex:'x6',full:true,note:''},

{id:10,d:1,head:'RALLY 2026: Blood Orange, Smerz, Daniel Avery, james K, Coco & Clair Clair, Optimo',
 lineup:['Blood Orange','Smerz','Daniel Avery','james K','Coco & Clair Clair','Optimo'],venue:'Festival',
 door:'',close:'',genre:[],gsrc:'',age:'',interested:0,
 srcs:[['Dice',null,'See listing']],ra:'',dice:'https://dice.fm/bundles/music-festivals-2025-72bp',tex:'x2',full:false,note:''},

{id:11,d:2,head:'Mister Sunday: Eamon Harkin All Day',lineup:['Eamon Harkin'],venue:'Nowadays',
 door:'15:00',close:'21:00',genre:[],gsrc:'',age:'',interested:411,
 srcs:[['Nowadays RSVP',null,'$10 off the door before 16:00, $5 off before 17:00'],['RA ticket',null,'On sale']],
 ra:'https://ra.co/events/2481435',tex:'x5',full:true,
 note:'Harkin plays start to finish, which happens once a year. Phones away on the dancefloor. Doors close at 20:30.'}
];

/* venues. Addresses and handles confirmed only where marked. */
let VENUES={
'Nowadays':{addr:'56-06 Cooper Ave, Ridgewood, NY 11385',hood:'Ridgewood',boro:'Queens',ig:'nowadaysnyc',site:'https://www.nowadays.nyc',ra:'https://ra.co/clubs/105873',verified:true,tones:['x1','x5','x3','x2']},
'BASEMENT':{addr:'52-19 Flushing Ave, Maspeth, NY 11378',hood:'Maspeth',boro:'Queens',ig:'',site:'https://basementny.net/house-rules',ra:'https://ra.co/clubs/165976',verified:true,tones:['x4','x6','x2','x1']},
'Knockdown Center':{addr:'',hood:'Maspeth',boro:'Queens',ig:'',site:'',ra:'https://ra.co/clubs/69401',verified:false,tones:['x1','x4','x6','x3']},
'Signal':{addr:'',hood:'Bushwick',boro:'Brooklyn',ig:'',site:'',ra:'https://ra.co/clubs/256148',verified:false,tones:['x5','x2','x6','x1']},
'MoMA PS1':{addr:'',hood:'Long Island City',boro:'Queens',ig:'',site:'',ra:'https://ra.co/clubs/2495',verified:false,tones:['x3','x1','x5','x4']},
'H0L0':{addr:'',hood:'Ridgewood',boro:'Queens',ig:'',site:'',ra:'https://ra.co/clubs/137550',verified:false,tones:['x2','x6','x3','x5']},
'Good Room':{addr:'',hood:'Greenpoint',boro:'Brooklyn',ig:'',site:'',ra:'https://ra.co/clubs/97606',verified:false,tones:['x6','x4','x1','x2']},
'Festival':{addr:'',hood:'Venue on Dice',boro:'',ig:'',site:'',ra:'',verified:false,tones:['x2','x1','x5','x6']}};

let GENRES=['House','Deep house','Techno','Electro','Electronica','Disco','Ballroom','DnB','Latin','R&B','Bubbling','Baile funk','Trance'];
const DOORS=[['EARLY','Before 10pm'],['LATE','10pm to 1am'],['UNK','Time not listed']];
const AVAIL=[['on','On sale'],['out','Sold out']];
let AREAS=['All','Queens','Brooklyn'];
let CITIES=[['nyc','New York',true],['la','Los Angeles',false],['ldn','London',false],['ber','Berlin',false]];   /* replaced by /api/feed cities[] */
/* When tab. Each preset asks the API for that window; the month calendar below picks a single night. */
const PRESETS=[['tonight','Tonight'],['tomorrow','Tomorrow'],['weekend','This weekend']];
const HANDLES=['sunroommate','kj.wav','ninetyeight','lo.fidelity','marta.exe','pdrbk','yuna.tape','third.shift','glasshouse.ny','avenue.c','bk.basement','sable.tt','mmmoire','vhs.night','pale.route','okjune','tenpm.club','ridgewood.rave','soft.opening','nine.volt','curfew.bk','late.bloom'];
const VIS=[['count','Count only','You add to the number. Nobody sees your handle, and you only see numbers back.'],
           ['mutuals','People I follow','Your handle shows to people you follow. You see theirs, if they opted in too.'],
           ['public','Everyone','Your handle shows to anyone on the event. You see everyone who chose the same.']];
const IGPOSTS=[['Reel','Last Saturday'],['Post','This weekend'],['Reel','Main room'],['Post','Door notice'],['Reel','Closing set'],['Post','New dates']];
const PHOTOS=['Main room','The bar','Doors','Outside'];

const S={mode:'image',view:'image',from:0,to:0,i:0,city:'nyc',area:'All',geo:false,
 gen:new Set(),door:new Set(),avail:new Set(),plat:new Set(),
 saved:new Set(),going:new Set(),signedIn:false,ig:'',vis:'count',signStep:1,
 /* When tab: which preset is active, the night picked on the calendar, and the month grid's cached counts */
 preset:'tonight',rangeLabel:'',picked:'',dayList:'',calMonth:'',counts:{},countsMonth:'',countsCity:'',countsNote:'',
 /* going rows by uuid -> created_at, the feed's generated_at, and rows removed that the feed had counted:
    together these correct a cached going_count without guessing */
 mineAt:new Map(),feedAt:'',goOff:new Set(),
 sortTaste:false,only:false,
 recs:{loading:false,loaded:false,error:false,list:[],history:0}};
/* true once a real feed replaces the sample weekend: only then are there rows to read and write */
let LIVE=false;
const $=s=>document.querySelector(s);
const dayName=i=>DAYS[i][2];
const dayFull=i=>`${DAYS[i][0]} ${DAYS[i][1]}`;
const band=e=>!e.door?'UNK':(+e.door.slice(0,2)<22?'EARLY':'LATE');
const prices=e=>e.srcs.map(s=>s[1]).filter(v=>v!==null);
/* `from` is the cheapest price NOCT knows, including from a source that cannot sell a ticket -- 19hz lists
   door prices and is the main source outside New York, so without this half of Chicago read "See listing". */
const low=e=>prices(e).length?Math.min(...prices(e)):(typeof e.from==='number'?e.from:null);
const high=e=>prices(e).length?Math.max(...prices(e)):(typeof e.from==='number'?e.from:null);
const priceLbl=e=>e.soldout?'Sold out':(low(e)===null?'See listing':(high(e)!==low(e)?'From $':'$')+low(e));
const genOf=e=>e.genre.length?e.genre.join(', '):'Not tagged';
const esc=s=>String(s).replace(/'/g,"\\'");
const vInfo=v=>VENUES[v]||{hood:'',boro:'',tones:['x1','x2','x3','x4'],verified:false};
const vibesOf=e=>(e.vibes||[]).slice(0,2).map(v=>(v.glyph?v.glyph+' ':'')+v.label);
/* enriched events lead with the primary genre and up to two vibe chips; untagged ones keep the raw source genres */
const tagLine=e=>e.primary?[e.primary,...vibesOf(e)].join(' · '):genOf(e);
/* image view: sound only. Free / RSVP / ages are logistics and belong on the event page. */
const genreLine=e=>e.primary||(e.genre&&e.genre.length?e.genre.join(', '):'');
const art=e=>e.image?` style="background:url(&quot;${e.image}&quot;) center/cover #0b0b0b"`:'';

/* going, with reciprocity.
   S.going / S.saved hold event UUIDs, not the numeric render ids: the feed renumbers on every load, so only
   the uuid is stable enough to persist. These helpers keep the call sites talking in numeric ids. */
const evById=id=>EV.find(e=>e.id===id);
const uuidOf=id=>{const e=evById(id);return e?e.uuid:''};
const isGoing=id=>{const u=uuidOf(id);return !!u&&S.going.has(u)};
const isSaved=id=>{const u=uuidOf(id);return !!u&&S.saved.has(u)};
/* Handles are simulated only on the sample weekend; live events have no profiles behind them yet. */
const crowdOf=id=>{if(LIVE)return [];const n=3+(id*11)%16,o=[];for(let k=0;k<n;k++)o.push(HANDLES[(id*7+k*3)%HANDLES.length]);return[...new Set(o)]};
const attVis=h=>{const n=h.length*3+h.charCodeAt(0);return n%10<4?'public':n%10<7?'mutuals':'count'};
const iFollow=h=>(h.charCodeAt(1)+h.length)%3===0;
function visibleTo(id){
  const c=crowdOf(id);
  if(!S.signedIn||S.vis==='count')return [];
  if(S.vis==='mutuals')return c.filter(h=>iFollow(h)&&attVis(h)!=='count');
  return c.filter(h=>attVis(h)==='public'||(attVis(h)==='mutuals'&&iFollow(h)));
}
/* The feed is edge-cached for five minutes, so its going_count can predate my own row. Compare the row's
   created_at with the feed's generated_at instead of guessing: newer than the feed means it is not counted
   yet (+1); a row I removed that the feed HAD counted is the -1 case (S.goOff). */
function goDelta(u){
  const at=S.mineAt.get(u);
  if(at&&at>S.feedAt)return 1;
  if(S.goOff.has(u))return -1;
  return 0;
}
const goCount=id=>{
  const e=evById(id);if(!e)return 0;
  if(!LIVE)return crowdOf(id).length+(S.going.has(e.uuid)?1:0);
  return Math.max(0,(e.going_count||0)+goDelta(e.uuid));
};

function ok(e){
  if(e.d<S.from||e.d>S.to)return false;
  const vi=vInfo(e.venue);
  if(S.area!=='All'&&vi.boro!==S.area)return false;
  if(S.gen.size&&!e.genre.some(g=>S.gen.has(g)))return false;
  if(S.door.size&&!S.door.has(band(e)))return false;
  if(S.avail.size&&!S.avail.has(e.soldout?'out':'on'))return false;
  return true;
}
/* A recommendation outranks any taste score (tasteScore is bounded far below 1000), and both only apply
   under "For you" -- "By time" has to mean by time, or the sort control is a lie. */
const rank=e=>(recFor(e)?1000:0)+tasteScore(e);
/**
 * Does NOCT have a reason to show this one? A recommendation, or a real genre overlap with the declared taste.
 * Deliberately NOT `tasteScore(e) > 0`: that score carries a popularity tiebreak, so almost every event with
 * an interested count passed it and "For you" barely narrowed anything (197 -> 142 on a weekend).
 */
const forMe=e=>{
  if(recFor(e))return true;
  if(!TASTE.length)return false;
  const codes=e.genre_codes||[];
  return TASTE.some(t=>codes.includes(t)||codes.some(c=>c.split('.')[0]===t.split('.')[0]));
};
/** Nothing to filter by until there is a taste or a recommendation, so the control stays hidden until then. */
const canFilterForMe=()=>TASTE.length>0||S.recs.list.some(r=>!r.gone);
const results=()=>EV.filter(ok).filter(e=>!S.only||forMe(e)).sort((a,b)=>a.d-b.d
  ||(S.sortTaste?rank(b)-rank(a):0)
  ||(a.door||'99').localeCompare(b.door||'99'));
/** One switch for both views. In image view the caption's "1 of N" is what makes the change legible. */
function toggleOnly(){
  S.only=!S.only;
  if(S.only)S.sortTaste=true;            /* filtering by taste while ignoring it in the order is incoherent */
  S.i=0;buildAll();render();renderOnlyBtn();
}
function renderOnlyBtn(){
  const b=$('#btnFor'),sep=$('#forSep'),lbl=$('#forLbl');
  if(!b||!sep||!lbl)return;
  const show=canFilterForMe()&&(S.view==='image'||S.view==='list');
  b.hidden=!show;sep.hidden=!show;
  lbl.textContent=S.only?'For you':'All';
  b.setAttribute('aria-pressed',String(S.only));
}
const nF=()=>S.gen.size+S.door.size+S.avail.size;
/* the preset's own words when one is active ("This weekend"), otherwise the nights themselves */
const dateLabel=()=>{
  if(S.rangeLabel)return S.rangeLabel;
  if(S.from===S.to){const d=DAYS[S.from]||DAYS[0];return d[2]==='Tonight'||d[2]==='Tomorrow'?d[2]:`${d[0]} ${d[1]}`}
  return `${DAYS[S.from][1]} – ${DAYS[S.to][1]}`;
};
const cityName=()=>(CITIES.find(c=>c[0]===S.city)||CITIES[0])[1];
const locLabel=()=>S.area==='All'?cityName():`${cityName()}, ${S.area}`;

function renderImage(){
  const list=results();
  if(S.i>=list.length)S.i=0;
  $('#slides').innerHTML=list.map((e,n)=>`<div class="slide ${n===S.i?'on':''}"><div class="tex ${e.tex}"${n===S.i?art(e):''}></div></div>`).join('');
  $('#swipeLbl').textContent=list.length?`Swipe ${dateLabel().toLowerCase()}`:'Nothing here';
  if(!list.length){$('#caption').innerHTML=`<div class="sm">Nothing matches.</div><button class="lnk" onclick="clearAll()" style="margin-top:10px">Clear filters</button>`;return}
  const e=list[S.i],rec=recFor(e);
  $('#caption').innerHTML=`
    <div class="idx sm">${S.i+1} of ${list.length} · ${dayFull(e.d)}</div>
    ${rec?`<div class="fortag"><span class="fydot"></span>For you</div>`:''}
    <div class="name">${e.head}</div>
    <div class="gen">${genreLine(e)}</div>
    <div class="meta sm">${e.venue}</div>
    <button class="lnk" onclick="openDet(${e.id})">View event</button>`;
}
function filmCut(){
  const g=document.getElementById('gate'); if(!g) return;
  if(typeof gsap!=='undefined'){
    gsap.killTweensOf(g);
    gsap.timeline()
      .set(g,{opacity:0})
      .to(g,{opacity:.66,duration:.06,ease:'power2.in'})
      .to(g,{opacity:.08,duration:.05})
      .to(g,{opacity:.44,duration:.05})
      .to(g,{opacity:0,duration:.24,ease:'power2.out'});
  } else { g.classList.remove('flick'); void g.offsetWidth; g.classList.add('flick'); }
}
function captionIn(){
  if(typeof gsap==='undefined')return;
  gsap.fromTo('#caption > *',{y:9,opacity:0},{y:0,opacity:1,duration:.5,stagger:.045,ease:'power3.out',overwrite:true});
}
function step(n){const l=results();if(!l.length)return;S.i=(S.i+n+l.length)%l.length;filmCut();renderImage();captionIn()}

function renderList(){
  const list=results();
  renderFbar();
  let out='',cur=-1;
  list.forEach(e=>{
    if(e.d!==cur){cur=e.d;out+=`<div class="dayhead">${dayName(e.d)} · ${dayFull(e.d)}</div>`}
    const rec=recFor(e);
    out+=`<div class="row" role="button" tabindex="0" onclick="openDet(${e.id})" onkeydown="if(event.key==='Enter'){openDet(${e.id})}">
      <div class="rt">${rec?`<span class="rfor">For you</span> · `:''}${e.door||'Time on listing'}</div>
      <div class="rn">${e.head}</div>
      <div class="rg">${tagLine(e)}</div>
      <div class="rv">${e.venue}</div>
      <div class="rp ${e.soldout||low(e)===null?'gone':''}">${priceLbl(e)}</div>
      <div class="rgo">${goCount(e.id)} going</div>
    </div>`;
  });
  $('#rows').innerHTML=list.length?out:`<div class="empty">Nothing matches. <button class="lnk" onclick="clearAll()">Clear filters</button></div>`;
}

/* "For you": events scored against this account's own going/saved history (0015). Recommendations are not
   part of the loaded feed — they span other nights — so each carries its own date and opens on its platform. */
function renderRecs(){
  const el=$('#recList');if(!el)return;
  if(!LIVE){el.innerHTML=`<div class="empty">Live data only.</div>`;return}
  const r=S.recs;
  if(r.loading&&!r.list.length){el.innerHTML=`<div class="empty">Reading your nights…</div>`;return}
  if(r.error){el.innerHTML=`<div class="empty">Recommendations unavailable right now.</div>`;return}
  if(!r.list.length){
    el.innerHTML=r.history
      ? `<div class="empty">Nothing close enough to your ${r.history} mark${r.history===1?'':'s'} yet — check back as more nights are listed.</div>`
      : `<div class="empty">Mark a few nights you're going to and NOCT will start suggesting others.</div>`;
    return;
  }
  el.innerHTML=r.list.map((e,i)=>e.gone
    ? `<div class="frow rec"><div class="recgone">Not for me — <button class="lnk" onclick="undoRec(${i})">Undo</button></div></div>`
    : `<div class="frow rec">`
      +`<button class="recmain" onclick="openRec(${i})"><div class="fn">${e.head}</div>`
      +`<div class="fm">${e.night_label}${e.venue?' · '+e.venue:''}${e.door?' · '+e.door:''}</div>`
      +`<div class="why">${e.why}</div></button>`
      +`<div class="recend"><span class="tg">${e.price}</span>`
      +`<button class="recx" onclick="dismissRec(${i})" aria-label="Not for me, stop suggesting this">✕</button></div></div>`).join('');
}
/* The same recommendations, pinned to the top of image / list / calendar. The rail is a shortcut, not a
   second feature: it reads S.recs, indexes into the same array, and stays hidden until there is something
   worth pinning — an empty "For you" over the artwork would be pure noise. */
/* ---------- Onboarding ----------
   Two questions, both skippable, neither of them typing. Genres first because they are the one axis where
   every option has something on; then real flyers to tap, because a tap on a night carries its artists,
   venue, vibes and price all at once — a far better first profile than a list of DJ names nobody in a new
   city recognises (1,015 of NYC's 1,194 upcoming artists play exactly one date).
   The picks are saved as ordinary `saved` rows, so nothing downstream needs a special case. */
const ONB_KEY='noct.onb.v1';
let ONB={step:0,genres:new Set(),picks:new Set(),opts:[],cards:[],busy:false};
let TASTE=[];                                    /* genre codes, also used to sort the feed */

let TASTE_LABELS={};                             /* code -> label, so the menu never has to guess from the code */
function tasteRestore(){try{const v=JSON.parse(localStorage.getItem(ONB_KEY)||'null');
  if(v&&Array.isArray(v.genres)){TASTE=v.genres;TASTE_LABELS=v.labels||{};return true}}catch(e){}return false}
function tasteRemember(){
  ONB.opts.forEach(g=>{if(TASTE.includes(g.code))TASTE_LABELS[g.code]=g.label});
  try{localStorage.setItem(ONB_KEY,JSON.stringify({genres:TASTE,labels:TASTE_LABELS,at:Date.now()}))}catch(e){}
}

async function maybeOnboard(){
  if(!LIVE||tasteRestore())return;               /* already answered (or skipped) on this device */
  try{
    const r=await fetch(`${API_BASE}/api/taste?city=${encodeURIComponent(S.city||'nyc')}`,{headers:{accept:'application/json'}});
    if(!r.ok)return;                              /* no options, no onboarding: never block the app */
    ONB.opts=(await r.json()).genres||[];
    if(ONB.opts.length<4)return;
    ONB.step=1;renderOnb();$('#onb').classList.add('open');
  }catch(e){}
}
function closeOnb(){$('#onb').classList.remove('open')}
function renderOnb(){
  const b=$('#onbBody');if(!b)return;
  if(ONB.step===1){
    b.innerHTML=`<div class="sh2">What do you play loud?</div>`
      +`<div class="onbsub">Pick whatever fits. It only sorts your feed — you can change it any time.</div>`
      +`<div class="opts">`+ONB.opts.map((g,i)=>`<button aria-pressed="${ONB.genres.has(g.code)}" onclick="onbGenre(${i})">${clean(g.label)}</button>`).join('')+`</div>`
      +`<div class="onbfoot"><button class="lnk" style="color:var(--d2)" onclick="onbSkip()">Skip</button>`
      +`<button class="lnk" onclick="onbNext()">${ONB.genres.size?'Next →':'Not sure yet →'}</button></div>`;
    return;
  }
  b.innerHTML=`<div class="sh2">Would you go?</div>`
    +`<div class="onbsub">Tap the ones you like the look of. That is all NOCT needs to start.</div>`
    +(ONB.cards.length?`<div class="pk">`+ONB.cards.map((e,i)=>`<button class="pkc" aria-pressed="${ONB.picks.has(e.uuid)}" onclick="onbPick(${i})">`
      +`<img src="${e.image}" alt="" loading="lazy">`
      +`<span class="pkt">✓</span>`
      +`<span class="pkl"><b>${e.head}</b><span>${[e.night_label,e.venue].filter(Boolean).join(' · ')}</span></span></button>`).join('')+`</div>`
      :`<div class="empty" style="padding:24px 0">Nothing to show right now — you are all set.</div>`)
    +`<div class="onbfoot"><button class="lnk" style="color:var(--d2)" onclick="onbBack()">← Genres</button>`
    +`<button class="lnk" onclick="onbDone()">${ONB.picks.size?`Done · ${ONB.picks.size} saved`:'Done'}</button></div>`;
}
/* Back to step 1 with the same chips still selected. Nights already tapped stay saved -- they were saved the
   moment they were tapped, and changing a genre is no reason to un-save one. */
function onbBack(){ONB.step=1;renderOnb();const sh=$('#onb');if(sh)sh.scrollTop=0}
function onbGenre(i){const g=ONB.opts[i];if(!g)return;
  ONB.genres.has(g.code)?ONB.genres.delete(g.code):ONB.genres.add(g.code);renderOnb()}
async function onbNext(){
  TASTE=[...ONB.genres];tasteRemember();applyTaste();          /* the feed re-sorts behind the sheet */
  ONB.step=2;ONB.cards=[];renderOnb();const sh=$('#onb');if(sh)sh.scrollTop=0;
  try{
    const q=TASTE.length?`&genres=${encodeURIComponent(TASTE.join(','))}`:'';
    const r=await fetch(`${API_BASE}/api/taste?picks=1&limit=8&city=${encodeURIComponent(S.city||'nyc')}${q}`,{headers:{accept:'application/json'}});
    if(r.ok)ONB.cards=((await r.json()).events||[]).filter(e=>e.image).map(e=>({uuid:e.id,head:clean(e.head),
      venue:clean(e.venue),night_label:nightLabel(e.night),image:cleanUrl(e.image)}));
  }catch(e){}
  renderOnb();
}
/* Each tap writes immediately, so "Done" is never a save button that can fail with the sheet already closing. */
function onbPick(i){const e=ONB.cards[i];if(!e)return;
  const on=!ONB.picks.has(e.uuid);
  on?ONB.picks.add(e.uuid):ONB.picks.delete(e.uuid);
  on?S.saved.add(e.uuid):S.saved.delete(e.uuid);
  renderOnb();persist('saved',e.uuid,on);
}
function onbSkip(){TASTE=[];tasteRemember();closeOnb();persistTaste()}
function onbDone(){
  tasteRemember();closeOnb();applyTaste();
  persistTaste();invalidateRecs();loadRecs();render();
}
function persistTaste(){
  if(!LIVE)return;
  try{sbRest('POST','/profile',{taste_genres:TASTE,onboarded_at:new Date().toISOString()}).catch(()=>{})}catch(e){}
}
/* Taste sorts *within* a night, never across one: people read the calendar chronologically and a Saturday
   headliner must not jump above Friday. Nothing is hidden — only reordered. */
function tasteScore(e){
  if(!TASTE.length)return 0;
  const codes=e.genre_codes||[];
  let hit=0,fam=0;
  TASTE.forEach(t=>{
    if(codes.includes(t))hit++;
    else if(codes.some(c=>c.split('.')[0]===t.split('.')[0]))fam++;
  });
  return hit*3+fam+Math.min((e.interested||0)/4000,.5);
}
function applyTaste(){S.sortTaste=TASTE.length>0;buildAll();render()}
function genreLabel(code){
  if(TASTE_LABELS[code])return TASTE_LABELS[code];
  const o=ONB.opts.find(g=>g.code===code);if(o)return o.label;
  for(const e of EV){const t=(e.tags||[]).find(t=>t.code===code);if(t&&t.label)return t.label}
  return code.split('.').pop().replace(/_/g,' ');
}
/* "change it any time": the same first question, reopened from the menu with the current answer filled in. */
function editTaste(){
  closeAll();
  if(!ONB.opts.length){maybeOnboard();return}
  ONB.step=1;ONB.genres=new Set(TASTE);renderOnb();$('#onb').classList.add('open');
}
/* A recommendation that also falls inside the loaded nights, by uuid: the rail and the feed are two views of
   one answer, so a card can carry the reason the recommender already worked out. */
function recFor(e){
  if(!e||!e.uuid)return null;
  return S.recs.list.find(r=>r.uuid===e.uuid&&!r.gone)||null;
}
/* A recommendation is usually on another night than the one loaded, so send people to the listing itself
   rather than silently reloading the feed underneath them. Opening one is recorded as a mild interest
   signal (0016) — after window.open, so a blocked-popup heuristic can never eat the click. */
function openRec(i){
  const e=S.recs.list[i];if(!e)return;
  const url=e.url||e.ra||e.dice;
  if(url)window.open(url,'_blank','noopener');
  feedback(e.uuid,'opened');
}
/* "Not for me": the event goes away and, from the next load on, its artists/genre/venue count against
   similar suggestions. Reversible, because ✕ sits one thumb-width from the row itself. */
function dismissRec(i){
  const e=S.recs.list[i];if(!e||e.gone)return;
  e.gone=true;renderRecs();
  feedback(e.uuid,'dismissed');
}
function undoRec(i){
  const e=S.recs.list[i];if(!e)return;
  e.gone=false;renderRecs();
  if(LIVE&&e.uuid)sbRest('DELETE','/rec_feedback?event_id=eq.'+encodeURIComponent(e.uuid)).catch(()=>{});
}
/** Record a reaction to a recommendation. Fire and forget: it tunes the next load, never this one. */
function feedback(uuid,action){
  if(!LIVE||!uuid)return;
  try{sbRest('POST','/rec_feedback',{event_id:uuid,action:action}).catch(()=>{})}catch(e){}
}
const WHY_LEAD={artist:'You saw',genre:'You go to',venue:'You go to',vibe:'Your nights are'};
function whyLine(why){
  const parts=(why||[]).slice(0,2).map(w=>`${WHY_LEAD[w.kind]||'Matches'} ${clean(w.detail)}`);
  return parts.join(' · ')||'Close to your taste';
}
async function loadRecs(){
  if(!LIVE)return;
  S.recs={loading:true,loaded:false,error:false,list:S.recs.list,history:S.recs.history};renderRecs();
  try{
    const s=await sbSession();if(!s)throw new Error('no session');
    const r=await fetch(`${API_BASE}/api/recommend?limit=12`,{headers:{accept:'application/json',authorization:'Bearer '+s.access_token}});
    if(!r.ok)throw new Error('HTTP '+r.status);
    const j=await r.json();
    S.recs={loading:false,loaded:true,error:false,history:j.history_size||0,
      list:(j.events||[]).map(e=>({uuid:e.id,head:clean(e.head),venue:clean(e.venue),door:clean(e.door),
        night_label:nightLabel(e.night),price:clean(priceOf(e)),why:whyLine(e.why),
        url:cleanUrl(e.url),ra:cleanUrl(e.ra),dice:cleanUrl(e.dice)}))};
  }catch(err){S.recs={loading:false,loaded:true,error:true,list:[],history:S.recs.history}}
  renderRecs();renderOnlyBtn();
}
/* the recommendation JSON is the feed's event shape, so reuse its price wording */
const priceOf=e=>{const p=(e.srcs||[]).map(s=>s[1]).filter(v=>typeof v==='number');
  return e.soldout?'Sold out':(!p.length?'See listing':(Math.max(...p)!==Math.min(...p)?'From $':'$')+Math.min(...p))};
const nightLabel=d=>{if(!d)return '';const t=new Date(d+'T12:00:00Z');
  return ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][t.getUTCDay()]+' '+
    ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][t.getUTCMonth()]+' '+t.getUTCDate()};

function renderSaved(){
  renderRecs();
  const go=EV.filter(e=>S.going.has(e.uuid));
  $('#goingList').innerHTML=go.length?go.map(e=>`<button class="frow" onclick="openDet(${e.id})"><div><div class="fn">${e.head}</div><div class="fm">${dayFull(e.d)} · ${e.venue}</div></div><div class="tg">${priceLbl(e)}</div></button>`).join('')
    :`<div class="empty">Not going to anything yet.</div>`;
  const sv=EV.filter(e=>S.saved.has(e.uuid));
  $('#savedList').innerHTML=sv.length?sv.map(e=>`<button class="frow" onclick="openDet(${e.id})"><div><div class="fn">${e.head}</div><div class="fm">${dayFull(e.d)} · ${e.venue}</div></div><div class="tg">${priceLbl(e)}</div></button>`).join(''):`<div class="empty">Nothing saved yet.</div>`;
}

function renderVenues(){
  const vs=[...new Set(EV.map(e=>e.venue))].sort();
  $('#venueList').innerHTML=vs.map(v=>{
    const i=vInfo(v),n=EV.filter(e=>e.venue===v).length;
    return `<button class="frow" onclick="openVenue('${esc(v)}')"><div><div class="fn">${v}</div><div class="fm">${i.hood}${i.boro?', '+i.boro:''}</div></div><div class="tg">${n} event${n===1?'':'s'}</div></button>`;
  }).join('');
}

function openDet(eid){
  const e=EV.find(x=>x.id===eid);
  const p=prices(e),gap=p.length>1?Math.max(...p)-Math.min(...p):0;
  const crowd=crowdOf(e.id),vis=visibleTo(e.id),hidden=crowd.length-vis.length,me=isGoing(e.id);
  let guest;
  if(!S.signedIn){
    guest=`<div class="prose">${goCount(e.id)} people on NOCT are going. <button class="lnk" onclick="openSign()">Sign in to see who</button></div>`;
  }else if(S.vis==='count'){
    guest=`<div class="prose">${goCount(e.id)} going. You are set to Count only, so you see numbers and nobody sees you.</div>
      <div class="goline"><button class="lnk" onclick="setView('profile')">Change this in Profile</button> to see who else is going.</div>`;
  }else{
    guest=`<div class="crowd">${me?`<span class="me">@${S.ig||'you'}</span>`:''}${vis.slice(0,12).map(h=>`<span>@${h}</span>`).join('')}${vis.length>12?`<span class="more">+${vis.length-12} more</span>`:''}</div>
      <div class="goline">${vis.length?`${vis.length} of ${goCount(e.id)} chose to be visible to you. `:'Nobody here has opted in to be seen by you yet. '}${hidden?`${hidden} are going quietly.`:''}</div>`;
  }
  $('#det').innerHTML=`
  <div class="dhero"><div class="tex ${e.tex}"${art(e)}></div><button class="dx" onclick="closePage('det')" aria-label="Close">✕</button></div>
  <div class="dbody">
    <div class="dname">${e.head}</div>
    <div class="dsup">${dayFull(e.d)}${e.door?` · ${e.door}${e.close?' to '+e.close:''}`:''} · ${e.venue}${e.room?' · '+e.room:''}</div>
    <div class="specs">
      <div class="k">Genre</div><div>${e.genre.length
        ?genOf(e)
        :`<span style="color:var(--d2)">No genre yet.</span> <button class="go" onclick="suggestGenre(${e.id})">Suggest one</button>`}</div>
      ${e.sound?`<div class="k">Sound</div><div>${e.sound}</div>`:''}
      ${(e.vibes||[]).length?`<div class="k">Vibe</div><div>${e.vibes.map(v=>(v.glyph?v.glyph+' ':'')+v.label).join(' · ')}</div>`:''}
      <div class="k">Venue</div><div><button class="go" onclick="openVenue('${esc(e.venue)}')">${e.venue} →</button></div>
      ${vInfo(e.venue).hood?`<div class="k">Area</div><div>${vInfo(e.venue).hood}${vInfo(e.venue).boro?', '+vInfo(e.venue).boro:''}</div>`:''}
      ${e.age?`<div class="k">Ages</div><div>${e.age}</div>`:''}
      ${e.interested?`<div class="k">Interested</div><div>${e.interested.toLocaleString()}</div>`:''}
    </div>
    <div class="grp"><h3>Going on NOCT · ${goCount(e.id)}</h3>${guest}
      <div class="foot" style="margin-top:18px"><button class="lnk" aria-pressed="${me}" onclick="toggleGoing(${e.id})">${me?"You're going":"I'm going"}</button></div>
    </div>
    <div class="grp"><h3>Tickets · ${e.srcs.length} way${e.srcs.length===1?'':'s'} in</h3>
      ${e.srcs.map(s=>`<div class="tk ${e.soldout?'dead':''}"><div><div class="src">${s[2]||'Ticket'}</div></div><div class="amt">${s[1]===null?'':'$'+s[1]}</div><a class="lnk" href="${s[3]||e.ra||e.dice||e.url||'#'}" target="_blank" rel="noopener">${e.soldout?'Resale':'Open'}</a></div>`).join('')}
      ${gap>0?`<div class="gapnote">Two prices for the same night, $${gap} apart. The RSVP is cheaper but does not guarantee entry.</div>`:''}
      ${!e.full?`<div class="gapnote">Price and set times are not listed here yet. Open the listing for the full record.</div>`:''}
    </div>
    ${e.set?`<div class="grp"><h3>Set times</h3>${e.set.map(t=>`<div class="ro"><div class="t">${t[0]}</div><div class="who">${t[1]}</div></div>`).join('')}</div>`
      :e.lineup.length?`<div class="grp"><h3>Line-up</h3>${e.lineup.map(a=>`<div class="ro"><div class="t"></div><div class="who">${a}</div></div>`).join('')}</div>`:''}
    ${e.note?`<div class="grp"><h3>About</h3><p class="prose">${e.note}</p></div>`:''}
    <div class="dacts">
      <button class="lnk" onclick="toggleSave(${e.id});openDet(${e.id})">${isSaved(e.id)?'Saved':'Save'}</button>
      <a class="lnk" href="${e.ra||e.dice||e.url||'#'}" target="_blank" rel="noopener">Open listing</a>
      <button class="lnk">Add to calendar</button>
      <button class="lnk" onclick="shareEvent(${e.id})">Share</button>
    </div>
  </div>`;
  $('#det').classList.add('open');$('#det').scrollTop=0;
}

/**
 * Share a night. NOCT has no per-event route, so the link carries the event's uuid AND its date: the recipient
 * lands on that night's feed with the sheet already open, instead of on whatever is on tonight.
 */
function shareEvent(id){
  const e=evById(id);if(!e)return;
  const date=(DAYS[e.d]||[])[3]||'';
  const q=new URLSearchParams({e:e.uuid||'',city:S.city||'nyc'});
  if(date){q.set('from',date);q.set('to',date)}
  const url=`${location.origin}${location.pathname}?${q}`;
  copyText(url).then(ok=>toast(ok?'Link copied':'Could not copy — '+url));
}
/** Clipboard API needs https and a gesture; the textarea path covers the browsers that refuse it. */
function copyText(t){
  if(navigator.clipboard&&navigator.clipboard.writeText)
    return navigator.clipboard.writeText(t).then(()=>true).catch(()=>fallbackCopy(t));
  return Promise.resolve(fallbackCopy(t));
}
function fallbackCopy(t){
  try{
    const a=document.createElement('textarea');
    a.value=t;a.setAttribute('readonly','');a.style.position='fixed';a.style.opacity='0';
    document.body.appendChild(a);a.select();
    const ok=document.execCommand('copy');
    document.body.removeChild(a);return ok;
  }catch(err){return false}
}
/** A shared link opens its event once the feed carrying it has landed. Consumed once, so a re-render or a
    later city switch does not keep re-opening the sheet. */
function openShared(){
  if(openShared.done)return;
  const want=new URLSearchParams(location.search).get('e');
  if(!want)return;
  const hit=EV.find(x=>x.uuid===want);
  if(!hit)return;                                  /* not in this range yet; a later load may still carry it */
  openShared.done=true;
  openDet(hit.id);
}
function openVenue(v){
  const i=vInfo(v),ev=EV.filter(e=>e.venue===v);
  const q=i.addr?`${v} ${i.addr}`:`${v} ${i.hood} New York`;
  const maps=`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
  const ig=i.ig?`https://www.instagram.com/${i.ig}/`:`https://www.instagram.com/explore/search/keyword/?q=${encodeURIComponent(v)}`;
  $('#ven').innerHTML=`
  <div class="dhero"><div class="tex ${i.tones[0]}"></div><button class="dx" onclick="closePage('ven')" aria-label="Close">✕</button></div>
  <div class="dbody">
    <div class="dname">${v}</div>
    <div class="dsup">${i.addr||(i.hood?i.hood+(i.boro?', '+i.boro:''):'Address not on file')}</div>
    ${!i.verified?`<div class="mini" style="margin-top:14px">Address and handle not yet confirmed for this venue.</div>`:''}
    <div class="grp"><h3>Go there</h3>
      <div class="links">
        <a href="${maps}" target="_blank" rel="noopener">Google Maps<span>${i.addr?'Exact address':'Search'}</span></a>
        <a href="${ig}" target="_blank" rel="noopener">Instagram<span>${i.ig?'@'+i.ig:'Search'}</span></a>
        ${i.ra?`<a href="${i.ra}" target="_blank" rel="noopener">RA venue page<span>All dates</span></a>`:''}
        ${i.site?`<a href="${i.site}" target="_blank" rel="noopener">Website<span>Door policy</span></a>`:''}
      </div>
    </div>
    <div class="grp"><h3>Photos</h3>
      <div class="strip">${PHOTOS.map((p,n)=>`<div class="ph"><div class="tex ${i.tones[n%i.tones.length]}"></div><div class="shade"></div><div class="cp">${p}</div></div>`).join('')}</div>
      <div class="mini">Placeholder. Real venue photography goes here.</div>
    </div>
    <div class="grp"><h3>From their Instagram</h3>
      <div class="iggrid">${IGPOSTS.map((p,n)=>`<a class="igt" href="${ig}" target="_blank" rel="noopener"><div class="tex ${i.tones[(n+1)%i.tones.length]}"></div><div class="shade"></div><div class="kind">${p[0]==='Reel'?'▶':'▣'}</div><div class="cp">${p[1]}</div></a>`).join('')}</div>
    </div>
    <div class="grp"><h3>This weekend here</h3>
      ${ev.map(e=>`<div class="row" style="padding-left:0;padding-right:0" role="button" tabindex="0" onclick="openDet(${e.id})">
        <div class="rt">${dayFull(e.d)}${e.door?' · '+e.door:''}</div>
        <div class="rn">${e.head}</div>
        <div class="rg">${tagLine(e)}</div>
        <div class="rv">${e.venue}</div>
        <div class="rp ${e.soldout?'gone':''}">${priceLbl(e)}</div>
      </div>`).join('')}
    </div>
  </div>`;
  $('#ven').classList.add('open');$('#ven').scrollTop=0;
}
function closePage(id){$('#'+id).classList.remove('open')}
function suggestGenre(id){
  const e=EV.find(x=>x.id===id);
  const g=prompt(`No source tagged a genre for "${e.head}". What would you call it?`);
  if(g&&g.trim()){e.genre=g.split(',').map(x=>x.trim()).filter(Boolean);openDet(id);render()}
}

/* sign in, two steps */
function openSign(){S.signStep=1;renderSign();$('#signSheet').classList.add('open');setTimeout(()=>{const el=$('#igInput');if(el)el.focus()},340)}
function renderSign(){
  if(S.signStep===1){
    $('#signBody').innerHTML=`
      <button class="sx" onclick="closeAll()" aria-label="Close">✕</button>
      <div class="sh2">Sign in</div>
      <p class="lede">Your Instagram handle is how people recognise each other on a guest list.</p>
      <div class="field"><b>@</b><input id="igInput" value="${S.ig}" placeholder="yourhandle" autocomplete="off" spellcheck="false"></div>
      <p class="note">We only read your public profile. We never post, and we never follow anyone for you.</p>
      <div class="foot"><button class="lnk" onclick="signStep2()">Continue</button><button class="lnk" style="color:var(--d2)" onclick="closeAll()">Not now</button></div>`;
  }else{
    $('#signBody').innerHTML=`
      <button class="sx" onclick="S.signStep=1;renderSign()" aria-label="Back">←</button>
      <div class="sh2">Who can see you</div>
      <p class="lede">This works both ways. You see the people who chose to be seen by you, and nothing more. Change it any time.</p>
      ${VIS.map(v=>`<button class="pick" aria-pressed="${S.vis===v[0]}" onclick="S.vis='${v[0]}';renderSign()"><div class="t">${v[1]}</div><div class="d">${v[2]}</div></button>`).join('')}
      <div class="foot"><button class="lnk" onclick="finishSign()">Done</button></div>`;
  }
}
function signStep2(){const el=$('#igInput');S.ig=(el?el.value:'').trim().replace(/^@/,'');S.signStep=2;renderSign()}
function finishSign(){S.signedIn=true;closeAll();setView('profile')}
function saveHandle(){const el=$('#igEdit');S.ig=(el?el.value:'').trim().replace(/^@/,'');renderProfile()}
function signOut(){S.signedIn=false;S.ig='';S.vis='count';renderProfile()}   /* going/saved stay: they belong to the anonymous account, not the handle */
function toggleGoing(id){const u=uuidOf(id);if(!u)return;
  const on=!S.going.has(u),was=S.mineAt.get(u);
  if(on){S.going.add(u);S.mineAt.set(u,new Date().toISOString());S.goOff.delete(u)}
  else{S.going.delete(u);S.mineAt.delete(u);if(!(was&&was>S.feedAt))S.goOff.add(u)}
  openDet(id);render();
  invalidateRecs();                                                   /* the taste profile just changed */
  persist('going',u,on).then(ok=>{if(ok)return;                       /* server said no: put the UI back */
    if(on){S.going.delete(u);S.mineAt.delete(u)}else{S.going.add(u);if(was)S.mineAt.set(u,was);S.goOff.delete(u)}
    liveNote('Could not save that — check your connection');openDet(id);render()});
}
function toggleSave(id){const u=uuidOf(id);if(!u)return;
  const on=!S.saved.has(u);
  on?S.saved.add(u):S.saved.delete(u);
  invalidateRecs();
  render();
  persist('saved',u,on).then(ok=>{if(ok)return;on?S.saved.delete(u):S.saved.add(u);
    liveNote('Could not save that — check your connection');render()});
}

function renderProfile(){
  const b=$('#profileBody');
  if(!S.signedIn){
    b.innerHTML=`<div><div class="vtitle">Profile</div><div style="padding:0 var(--pad)">
      <p class="lede">Sign in to mark yourself going and see who else is.</p>
      <div class="foot" style="margin-top:0"><button class="lnk" onclick="openSign()">Sign in with Instagram</button></div>
      <div class="grp"><h3>Without an account</h3><div class="prose">You can still browse the weekend, filter, and buy tickets. None of that is locked.</div></div></div></div>`;
    return;
  }
  const cur=VIS.find(v=>v[0]===S.vis);
  b.innerHTML=`<div><div class="vtitle">${S.ig?'@'+S.ig:'Profile'}</div><div style="padding:0 var(--pad)">
    ${S.ig?`<p class="lede"><a href="https://instagram.com/${encodeURIComponent(S.ig)}" target="_blank" rel="noopener" style="text-decoration:underline;text-underline-offset:4px">View on Instagram</a></p>`:'<p class="lede">No handle set. Add one to appear on guest lists.</p>'}
    <div class="grp"><h3>Instagram handle</h3>
      <div class="field"><b>@</b><input id="igEdit" value="${S.ig}" placeholder="yourhandle" autocomplete="off" spellcheck="false"></div>
      <div class="foot" style="margin-top:16px"><button class="lnk" onclick="saveHandle()">Save handle</button></div>
    </div>
    <div class="grp"><h3>Who can see you</h3>
      ${VIS.map(v=>`<button class="pick" aria-pressed="${S.vis===v[0]}" onclick="S.vis='${v[0]}';renderProfile()"><div class="t">${v[1]}</div><div class="d">${v[2]}</div></button>`).join('')}
      <div class="note">Right now: ${cur[2]}</div>
    </div>
    <div class="grp"><h3>Your weekend</h3>
      <div class="specs">
        <div class="k">Going</div><div>${S.going.size}</div>
        <div class="k">Saved</div><div>${S.saved.size}</div>
        <div class="k">City</div><div>New York</div>
      </div>
    </div>
    <div class="foot"><button class="lnk" style="color:var(--d2)" onclick="signOut()">Sign out</button></div></div></div>`;
}

function opt(el,items,isOn,onPick){
  el.innerHTML='';
  items.forEach(it=>{
    const val=Array.isArray(it)?it[0]:it,label=Array.isArray(it)?it[1]:it;
    const b=document.createElement('button');b.textContent=label;
    b.setAttribute('aria-pressed',isOn(val));
    b.onclick=()=>{onPick(val);buildAll();render()};
    el.appendChild(b);
  });
}
function buildAll(){
  opt($('#oCity'),CITIES.map(c=>[c[0],c[2]?c[1]:c[1]+' (soon)']),v=>S.city===v,v=>{const c=CITIES.find(x=>x[0]===v);if(c&&c[2]&&S.city!==v){S.city=v;S.area='All';closeAll();loadFeed();}});
  opt($('#oArea'),AREAS,v=>S.area===v,v=>S.area=v);
  opt($('#oPreset'),PRESETS,v=>S.preset===v,v=>pickRange(v));
  $('#gSort').hidden=!TASTE.length;                 /* nothing to sort by until a taste exists */
  opt($('#fSort'),[['you','For you'],['time','By time']],v=>(v==='you')===S.sortTaste,v=>{S.sortTaste=(v==='you');S.i=0});
  opt($('#fGen'),GENRES,v=>S.gen.has(v),v=>S.gen.has(v)?S.gen.delete(v):S.gen.add(v));
  opt($('#fDoor'),DOORS,v=>S.door.has(v),v=>S.door.has(v)?S.door.delete(v):S.door.add(v));
  opt($('#fAvail'),AVAIL,v=>S.avail.has(v),v=>S.avail.has(v)?S.avail.delete(v):S.avail.add(v));
  renderCal();renderCalList();
}
function clearAll(){S.gen.clear();S.door.clear();S.avail.clear();S.sortTaste=TASTE.length>0;S.i=0;buildAll();render()}
function useGeo(){S.geo=!S.geo;$('#geoState').textContent=S.geo?'On':'Off';render()}
function resetLoc(){const was=S.city;S.city='nyc';S.area='All';S.geo=false;if(was!=='nyc'){closeAll();loadFeed();return}buildAll();render()}

function renderMenu(){
  const tasteLbl=TASTE.length?TASTE.map(c=>genreLabel(c)).slice(0,2).join(', ')+(TASTE.length>2?` +${TASTE.length-2}`:''):'Not set';
  $('#mNav').innerHTML=[['Events','Back to the feed'],['Venues',''],['Saved',''],['Your taste',tasteLbl],['Profile',S.signedIn?(S.ig?'@'+S.ig:'Signed in'):'Sign in']]
    .map(n=>`<button onclick="menuGo('${n[0]}')">${n[0]}<span>${n[1]}</span></button>`).join('');
}
function menuGo(n){closeAll();
  if(n==='Events')setView(S.mode);
  if(n==='Venues')setView('venues');
  if(n==='Saved')setView('saved');
  if(n==='Profile')setView('profile');
  if(n==='Your taste')editTaste();
}
function closeAll(){document.querySelectorAll('.sheet').forEach(el=>el.classList.remove('open'))}
function goProfile(){closeAll();closePage('det');closePage('ven');setView('profile')}
function openFilter(){closeAll();document.getElementById('filt').classList.add('open')}
function renderFbar(){
  const bar=document.getElementById('fbar'); if(!bar) return;
  const inRange=EV.filter(e=>e.d>=S.from&&e.d<=S.to);
  const tally={};
  inRange.forEach(e=>{
    const g=e.primary||(e.genre&&e.genre[0]);
    if(g)tally[g]=(tally[g]||0)+1;
  });
  const gs=Object.keys(tally).sort((a,b)=>tally[b]-tally[a]||a.localeCompare(b)).slice(0,6);
  const n=nF();
  bar.innerHTML=
    `<button class="fb ${n?'on':''}" onclick="openFilter()">Filter${n?' \u00b7 '+n:''}</button>`+
    gs.map(g=>`<button class="fb ${S.gen.has(g)?'on':''}" onclick="quickGen('${String(g).replace(/'/g,"\\'")}')">${g}</button>`).join('')+
    (n?`<button class="fb plain" onclick="clearAll()">Clear</button>`:'');
}
function quickGen(g){S.gen.has(g)?S.gen.delete(g):S.gen.add(g);S.i=0;buildAll();render()}
function goBack(){setView(S.mode)}
function goHome(){
  closeAll();closePage('det');closePage('ven');
  S.i=0;setView(S.mode);
  ['listView','savedView','venuesView','profileView'].forEach(id=>{const el=$('#'+id);if(el)el.scrollTop=0});
  $('#topscrim').classList.remove('on');
}
function setView(v){
  if(LIVE&&!S.recs.loading&&!S.recs.loaded)loadRecs();
  S.view=v;if(v==='image'||v==='list')S.mode=v;
  const secondary=(v==='saved'||v==='venues'||v==='profile');
  $('#ctrlRow').hidden=secondary;
  $('#backRow').hidden=!secondary;
  $('#backLbl').textContent=S.mode==='list'?'List view':'Events';
  $('#imageView').hidden=v!=='image';$('#listView').hidden=v!=='list';
  $('#savedView').hidden=v!=='saved';$('#venuesView').hidden=v!=='venues';$('#profileView').hidden=v!=='profile';
  document.querySelectorAll('[data-mode]').forEach(b=>b.setAttribute('aria-pressed',b.dataset.mode===S.mode&&(v==='image'||v==='list')));
  const listy=(v==='list');
  const bar=$('#fbar');
  if(bar){bar.hidden=!listy; if(listy)renderFbar();}
  renderOnlyBtn();
  $('#listView').classList.toggle('withbar',listy);
  $('#topscrim').classList.toggle('tall',listy);
  $('#topscrim').classList.remove('on');
  $('#botscrim').classList.toggle('on',v!=='image');
  render();
}
document.querySelectorAll('[data-mode]').forEach(b=>b.onclick=()=>setView(b.dataset.mode));
['listView','savedView','venuesView','profileView'].forEach(id=>{
  $('#'+id).addEventListener('scroll',e=>{$('#topscrim').classList.toggle('on',e.target.scrollTop>6)},{passive:true});
});
/* Sheets are absolutely positioned siblings inside .app. Focusing a control in a closed one (tab, or a tap
   that lands as the sheet slides) scrolls the clipped container and pushes the whole UI off-screen; pin it. */
(()=>{const app=document.querySelector('.app');app.addEventListener('scroll',()=>{if(app.scrollTop)app.scrollTop=0},{passive:true})})();
$('#btnLoc').onclick=()=>$('#locSheet').classList.add('open');
$('#btnDate').onclick=()=>{$('#dateSheet').classList.add('open');loadCounts()};
$('#openMenu').onclick=()=>{renderMenu();$('#menu').classList.add('open')};
document.addEventListener('keydown',e=>{
  if(e.key!=='Escape')return;
  const detOpen=$('#det').classList.contains('open'),venOpen=$('#ven').classList.contains('open');
  const sheetOpen=[...document.querySelectorAll('.sheet')].some(el=>el.classList.contains('open'));
  if(venOpen){closePage('ven');return}
  if(detOpen){closePage('det');return}
  if(sheetOpen){closeAll();return}
  if(S.view==='saved'||S.view==='venues'||S.view==='profile')goBack();
});
let x0=null;
$('#imageView').addEventListener('pointerdown',e=>x0=e.clientX);
$('#imageView').addEventListener('pointerup',e=>{if(x0===null)return;const dx=e.clientX-x0;x0=null;if(Math.abs(dx)>40)step(dx<0?1:-1)});

function render(){
  $('#locLbl').textContent=locLabel();
  $('#dateLbl').textContent=dateLabel();
  if(S.view==='image')renderImage();
  if(S.view==='list')renderList();
  if(S.view==='saved')renderSaved();
  if(S.view==='venues')renderVenues();
  if(S.view==='profile')renderProfile();
}
/* ---------- live data: /api/feed replaces the sample constants above (docs/FRONTEND.md) ---------- */
const SHORT_PLAT={'Resident Advisor':'RA','DICE':'Dice'};
const TEX=['x1','x2','x3','x4','x5','x6'];
/* source text lands in the innerHTML templates above unchanged, so markup is neutralised once here rather than in every template */
const clean=s=>String(s==null?'':s).replace(/</g,'‹').replace(/>/g,'›').replace(/"/g,'”').replace(/\\/g,'');
const cleanUrl=u=>{u=String(u==null?'':u).trim();return /^https?:\/\//i.test(u)?u.replace(/["'<>\\\s]/g,''):''};
const hashOf=s=>{let h=7;for(const c of String(s))h=(h*31+c.charCodeAt(0))>>>0;return h};
const tonesOf=name=>{const h=hashOf(name);return [0,1,2,3].map(k=>TEX[(h+k*2)%TEX.length])};
const nyDate=off=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(Date.now()+off*864e5));

/* ---------- identity: an anonymous Supabase session ----------
   Every visitor gets a durable user_id with no login screen, so "going" and "saved" survive a reload and a
   taste history starts accumulating from day one; the same account is upgraded in place later (linkIdentity /
   updateUser) without losing those rows. The publishable key below is meant to sit in client code — Row Level
   Security is what protects the data: a session may read and write only its own rows (0005), and `going_count`
   is the one public aggregate. Written against the REST endpoints directly so the page keeps its property of
   having no third-party runtime dependency; if any of it fails the app simply falls back to memory-only marks. */
const SB_URL='https://cwjxhddnddvntxpikqbz.supabase.co';
const SB_KEY='sb_publishable_bHn9dc0u9Mfuhuy5INKVUA_U6tTAuMB';
const SB_STORE='noct.session';
let SB=null;
const sbHeaders=t=>Object.assign({apikey:SB_KEY,'content-type':'application/json'},t?{authorization:'Bearer '+t}:{});
function sbRemember(j){
  if(!j||!j.access_token)return null;
  SB={access_token:j.access_token,refresh_token:j.refresh_token,user_id:(j.user||{}).id||'',
      expires_at:Date.now()+((j.expires_in||3600)-60)*1000};
  try{localStorage.setItem(SB_STORE,JSON.stringify(SB))}catch(e){}
  return SB;
}
function sbRestore(){try{const s=JSON.parse(localStorage.getItem(SB_STORE)||'null');if(s&&s.access_token)SB=s}catch(e){}return SB}
async function sbAuth(path,body){
  const r=await fetch(SB_URL+'/auth/v1/'+path,{method:'POST',headers:sbHeaders(),body:JSON.stringify(body)});
  return r.ok?sbRemember(await r.json()):null;
}
/** A live token, refreshing or re-registering as needed. Null when Supabase is unreachable. */
async function sbSession(){
  if(SB&&SB.expires_at>Date.now())return SB;
  try{
    if(SB&&SB.refresh_token){const s=await sbAuth('token?grant_type=refresh_token',{refresh_token:SB.refresh_token});if(s)return s}
    SB=null;try{localStorage.removeItem(SB_STORE)}catch(e){}
    return await sbAuth('signup',{});                      /* anonymous sign-in */
  }catch(e){return null}
}
async function sbRest(method,path,body){
  const s=await sbSession();if(!s)return null;
  const opts={method,headers:Object.assign(sbHeaders(s.access_token),{prefer:'resolution=merge-duplicates'})};
  if(body)opts.body=JSON.stringify(body);
  let r=await fetch(SB_URL+'/rest/v1'+path,opts);
  if(r.status===401){                                      /* token rejected: start a new session once */
    SB=null;const s2=await sbSession();if(!s2)return null;
    opts.headers=Object.assign(sbHeaders(s2.access_token),{prefer:'resolution=merge-duplicates'});
    r=await fetch(SB_URL+'/rest/v1'+path,opts);
  }
  return r;
}
/** A new mark changes the taste profile. Mark it stale rather than blanking it: the rail keeps showing the
    previous answer until a fresh one lands, so marking a night does not make it flicker. */
function invalidateRecs(){S.recs.loaded=false;S.recs.error=false}
/** Mirror one toggle into Postgres. user_id is defaulted to auth.uid() server-side (0014). */
async function persist(table,uuid,on){
  if(!LIVE)return true;                                    /* the sample weekend has no rows to write */
  try{
    const r=on?await sbRest('POST','/'+table,{event_id:uuid}):await sbRest('DELETE','/'+table+'?event_id=eq.'+encodeURIComponent(uuid));
    return !!r&&r.ok;
  }catch(e){return false}
}
/** Load this account's going/saved so a reload (or another device, once the account is upgraded) restores them. */
async function syncMine(){
  if(!LIVE)return;
  try{
    const [g,sv]=await Promise.all([sbRest('GET','/going?select=event_id,created_at'),sbRest('GET','/saved?select=event_id')]);
    if(g&&g.ok){const rows=await g.json();
      S.going=new Set(rows.map(r=>r.event_id));
      S.mineAt=new Map(rows.map(r=>[r.event_id,r.created_at]));}
    if(sv&&sv.ok){const rows=await sv.json();S.saved=new Set(rows.map(r=>r.event_id))}
    S.goOff.clear();
    render();
  }catch(e){}
}

/* ---------- When: range presets + month calendar ----------
   Plain YYYY-MM-DD strings all the way through (UTC parsing only, so no local-midnight drift). A preset asks
   the API for that window; the calendar asks for counts only (~1 KB a month instead of ~320 KB of records)
   and loads a single night's cards when a date is tapped. */
const MONTHS=['January','February','March','April','May','June','July','August','September','October','November','December'];
const WD=['S','M','T','W','T','F','S'];
const dAdd=(s,n)=>new Date(Date.parse(s+'T00:00:00Z')+n*864e5).toISOString().slice(0,10);
const dDow=s=>new Date(Date.parse(s+'T00:00:00Z')).getUTCDay();
const dMonth=s=>s.slice(0,7);
const monthStart=m=>m+'-01';
const monthEnd=m=>{const p=m.split('-').map(Number);return `${m}-${String(new Date(Date.UTC(p[0],p[1],0)).getUTCDate()).padStart(2,'0')}`};
const monthAdd=(m,n)=>{const p=m.split('-').map(Number);return new Date(Date.UTC(p[0],p[1]-1+n,1)).toISOString().slice(0,7)};

/** [from, to, label] for a preset key, in New York's calendar. */
function rangeOf(key){
  const t=nyDate(0);
  if(key==='tomorrow')return [nyDate(1),nyDate(1),'Tomorrow'];
  if(key==='weekend'){
    const dow=dDow(t);
    if(dow===0)return [t,t,'Tonight'];                        /* Sunday: the weekend ends tonight */
    const start=(dow===5||dow===6)?t:dAdd(t,5-dow);           /* Mon–Thu jump to Friday */
    return [start,dAdd(start,dDow(start)===5?2:1),'This weekend'];
  }
  return [t,t,'Tonight'];
}
function pickRange(key){
  const r=rangeOf(key);
  S.preset=key;S.rangeLabel=r[2];S.picked=r[0]===r[1]?r[0]:'';S.calMonth=dMonth(r[0]);S.dayList='';
  closeAll();loadFeed({from:r[0],to:r[1]});
}
/* A calendar night previews in place: the sheet stays open and the night's cards render under the grid. */
async function pickDate(date){
  S.preset='';S.rangeLabel='';S.picked=date;S.dayList=date;
  renderCal();renderCalList();
  await loadFeed({from:date,to:date});
  renderCalList();
}
/** Tapping one of those cards leaves the sheet and opens that event in the image view. */
function openFromCal(i){closeAll();S.i=i;setView('image')}
function renderCalList(){
  const el=$('#calList');if(!el)return;
  if(!S.dayList){el.innerHTML='';return}
  if(!DAYS.length||DAYS[0][3]!==S.dayList){el.innerHTML=`<div class="grp"><div class="note">Loading…</div></div>`;return}
  const list=results(),d=DAYS[0];
  if(!list.length){el.innerHTML=`<div class="grp"><div class="note">Nothing on ${d[0]} ${d[1]}${nF()?' with your filters':''}.</div></div>`;return}
  el.innerHTML=`<div class="grp"><h3>${d[0]} ${d[1]} · ${list.length} event${list.length===1?'':'s'}</h3>`
    +list.map((e,i)=>`<div class="row" role="button" tabindex="0" onclick="openFromCal(${i})" onkeydown="if(event.key==='Enter'){openFromCal(${i})}">`
      +`<div class="rt">${e.door||'Time on listing'}</div>`
      +`<div class="rn">${e.head}</div>`
      +`<div class="rg">${tagLine(e)}</div>`
      +`<div class="rv">${e.venue}</div>`
      +`<div class="rp ${e.soldout||low(e)===null?'gone':''}">${priceLbl(e)}</div>`
      +`<div class="rgo">${goCount(e.id)} going</div></div>`).join('')
    +`</div>`;
}
function calMove(n){S.calMonth=monthAdd(S.calMonth||dMonth(nyDate(0)),n);renderCal();loadCounts()}
function renderCal(){
  const el=$('#rcal');if(!el)return;
  const m=S.calMonth||dMonth(nyDate(0)),today=nyDate(0);
  const first=monthStart(m),days=Number(monthEnd(m).slice(8)),p=m.split('-').map(Number);
  let cells='';
  for(let i=0;i<dDow(first);i++)cells+='<div class="pad"></div>';
  for(let d=1;d<=days;d++){
    const date=`${m}-${String(d).padStart(2,'0')}`,n=S.counts[date]||0,dis=date<today||!n;
    cells+=`<button ${dis?'disabled':''} aria-pressed="${S.picked===date}"${date===today?' aria-current="date"':''}`
      +` onclick="pickDate('${date}')" aria-label="${d} ${MONTHS[p[1]-1]}, ${n} event${n===1?'':'s'}">`
      +`${d}${n?`<span class="n">${n}</span>`:''}</button>`;
  }
  el.innerHTML=`<div class="calhd">`
    +`<button ${monthAdd(m,-1)>=dMonth(today)?'':'disabled'} onclick="calMove(-1)" aria-label="Previous month">‹</button>`
    +`<div class="m">${MONTHS[p[1]-1]} ${p[0]}</div>`
    +`<button onclick="calMove(1)" aria-label="Next month">›</button></div>`
    +`<div class="calg">${WD.map(w=>`<div class="wd">${w}</div>`).join('')}${cells}</div>`
    +(S.countsNote?`<div class="note">${S.countsNote}</div>`:'');
}
/** Counts for the visible month, cached per month+city so reopening the sheet is free. */
async function loadCounts(){
  const m=S.calMonth||dMonth(nyDate(0)),city=S.city||'nyc';
  if(S.countsMonth===m&&S.countsCity===city)return;
  if(/[?&]demo=1(&|$)/.test(location.search))return;
  renderCal();
  try{
    const qs=new URLSearchParams({city,from:monthStart(m),to:monthEnd(m),counts:'1'});
    const r=await fetch(`${API_BASE}/api/feed?${qs}`,{headers:{accept:'application/json'}});
    if(!r.ok)throw new Error('HTTP '+r.status);
    const j=await r.json();
    (j.days||[]).forEach(d=>{S.counts[d.date]=d.events|0});
    S.countsMonth=m;S.countsCity=city;
    S.countsNote='';
  }catch(e){S.countsNote='Month counts unavailable.'}
  renderCal();
}
const liveNote=msg=>{const el=$('#liveNote');el.textContent=msg;el.hidden=!msg};
/** liveNote is for states that end when the state does; a confirmation has to clear itself. */
function toast(msg,ms){
  liveNote(msg);
  clearTimeout(toast.t);
  toast.t=setTimeout(()=>{if($('#liveNote').textContent===msg)liveNote('')},ms||2600);
}
function applyFeed(f){
  if(!f||!Array.isArray(f.days)||!f.days.length||!Array.isArray(f.events))throw new Error('unexpected feed shape');
  DAYS=f.days.map(d=>[clean(d.label),clean(d.sub),clean(d.hint),d.date]);
  /* id stays the numeric index the onclick handlers expect; the event uuid rides along as uuid */
  EV=f.events.map(e=>({
    id:e.n,uuid:e.id,d:e.d,head:clean(e.head),lineup:(e.lineup||[]).map(clean),venue:clean(e.venue),room:e.room?clean(e.room):'',
    door:clean(e.door),close:clean(e.close),genre:(e.genre||[]).map(clean),primary:e.primary?clean(e.primary):'',
    genre_codes:(e.genre_codes||[]).map(clean),tags:(e.tags||[]).map(t=>({code:clean(t.code),label:clean(t.label)})),
    genre_confidence:typeof e.genre_confidence==='number'?e.genre_confidence:null,
    vibes:(e.vibes||[]).map(v=>({code:clean(v.code),label:clean(v.label),glyph:clean(v.glyph)})),
    scalars:e.scalars||{},sound:clean(e.sound),age:clean(e.age),interested:e.interested||0,
    srcs:(e.srcs||[]).map(s=>[SHORT_PLAT[s[0]]||clean(s[0]),typeof s[1]==='number'?s[1]:null,clean(s[2]),cleanUrl(s[3])]),
    from:typeof e.from==='number'?e.from:null,
    ra:cleanUrl(e.ra),dice:cleanUrl(e.dice),eb:cleanUrl(e.eb),url:cleanUrl(e.url),tex:TEX.indexOf(e.tex)>=0?e.tex:'x1',
    full:!!e.full,soldout:!!e.soldout,note:clean(e.note),status:clean(e.status),image:cleanUrl(e.image),going_count:e.going_count||0
  }));
  const vs={};
  Object.keys(f.venues||{}).forEach(k=>{const v=f.venues[k]||{};vs[clean(k)]={addr:clean(v.addr),hood:clean(v.hood),boro:clean(v.boro),
    ig:clean(v.ig).replace(/[^\w.]/g,''),site:cleanUrl(v.site),ra:cleanUrl(v.ra),dice:cleanUrl(v.dice),verified:!!v.verified,tones:tonesOf(k)}});
  VENUES=vs;
  GENRES=(f.genres||[]).map(clean);
  AREAS=['All',...new Set(EV.map(e=>vInfo(e.venue).boro).filter(Boolean))];
  if(Array.isArray(f.cities)&&f.cities.length)CITIES=f.cities.map(c=>[c.key,clean(c.name),!!c.enabled]);
  if(f.city&&f.city.key)S.city=f.city.key;
  /* the loaded window IS the selection now — the When tab decides what gets loaded */
  S.from=0;S.to=DAYS.length-1;S.i=0;
  if(!S.calMonth)S.calMonth=dMonth(DAYS[0][3]);
  LIVE=true;S.feedAt=f.generated_at||new Date().toISOString();S.goOff.clear();
  if(AREAS.indexOf(S.area)<0)S.area='All';
  buildAll();setView(S.view);
}
/* Where /api lives. Deployed: same origin. Opened from disk or a local static server (UI work): the production
   API, which allows cross-origin reads. Override with ?api=https://host, or ?demo=1 for the sample weekend. */
const LIVE_API='https://noct-navy.vercel.app';
const API_BASE=(()=>{
  const q=new URLSearchParams(location.search).get('api');
  if(q)return q.replace(/\/+$/,'');
  const local=location.protocol==='file:'||/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  return local?LIVE_API:'';
})();
async function loadFeed(range){
  if(/[?&]demo=1(&|$)/.test(location.search))return;
  const q=new URLSearchParams(location.search);
  if(q.get('city')&&!loadFeed.cityFromUrlUsed){S.city=q.get('city');loadFeed.cityFromUrlUsed=true}
  const city=S.city||'nyc';
  const first=!loadFeed.loadedOnce;loadFeed.loadedOnce=true;
  /* a When-tab pick wins; then ?from/?to on the very first load; otherwise the active preset, so a city
     switch re-asks for the same window in the new city's own calendar */
  let from=null,to=null;
  if(range){from=range.from;to=range.to}
  else if(first&&(q.get('from')||q.get('to'))){from=q.get('from');to=q.get('to');S.preset='';S.rangeLabel=''}
  else{const r=rangeOf(S.preset||'tonight');from=r[0];to=r[1];S.rangeLabel=r[2];S.picked=r[0]===r[1]?r[0]:''}
  const qs=new URLSearchParams({city});if(from)qs.set('from',from);if(to)qs.set('to',to);
  liveNote('Loading '+(CITIES.find(c=>c[0]===city)||[,city])[1]+'…');
  try{
    const r=await fetch(`${API_BASE}/api/feed?${qs}`,{headers:{accept:'application/json'}});
    if(!r.ok)throw new Error(`HTTP ${r.status}`);
    applyFeed(await r.json());
    liveNote('');
    syncMine();                      /* restore this account's going/saved; renders again when it lands */
    loadRecs();                      /* the rail is pinned to every view, so recommendations load with the feed */
    if(tasteRestore()){S.sortTaste=TASTE.length>0;render()}else{maybeOnboard()}
    openShared();
  }catch(err){
    liveNote('Live data unavailable — showing sample weekend');
  }
}
sbRestore();buildAll();setView('image');loadFeed();
