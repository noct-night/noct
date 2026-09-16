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

const S={mode:'image',view:'image',from:0,to:0,i:0,city:'nyc',area:'All',geo:false,
 gen:new Set(),door:new Set(),avail:new Set(),plat:new Set(),
 saved:new Set(),going:new Set(),signedIn:false,ig:'',vis:'count',signStep:1,
 /* When tab: which preset is active, the night picked on the calendar, and the month grid's cached counts */
 preset:'tonight',rangeLabel:'',picked:'',dayList:'',calMonth:'',counts:{},countsMonth:'',countsCity:'',countsNote:'',
 /* going rows by uuid -> created_at, the feed's generated_at, and rows removed that the feed had counted:
    together these correct a cached going_count without guessing */
 mineAt:new Map(),feedAt:'',goOff:new Set(),
 /* which nights the three views show: everything, the ones NOCT has a reason for, or the picks for one night */
 sortTaste:false,sel:'all',
 recs:{loading:false,loaded:false,error:false,list:[],history:0},
 /* up to three for the first night loaded -- Best match, Safer choice, Wildcard -- see loadPicks() */
 picks:{loading:false,loaded:false,error:false,list:[],night:''}};
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
/* A single-name line-up that repeats the title is the norm, not an error: of 55 such events 19 in 20 are real
   headliners (Ben Bohmer, Cat Dealers, Six Sex) and the odd one is a party brand (Indo Warehouse). Printing
   the same string as the title and again under "Line-up" just reads like a bug, so the TITLE becomes the tap
   target and the row is dropped. */
const sameName=(a,b)=>String(a||'').toLowerCase().replace(/\s+/g,' ').trim()===String(b||'').toLowerCase().replace(/\s+/g,' ').trim();
const titleIsTheAct=e=>{
  const one=(e.lineup&&e.lineup.length===1)?e.lineup[0]:(!(e.lineup||[]).length&&e.act?e.act:null);
  return one&&sameName(one,e.head)?one:null;
};
const vInfo=v=>VENUES[v]||{hood:'',boro:'',tones:['x1','x2','x3','x4'],verified:false};
/* Labels only. The taxonomy carries a glyph per vibe, but a row of emoji in a monochrome, editorial UI reads
   as a different product; the words do the work. */
const vibesOf=e=>(e.vibes||[]).slice(0,2).map(v=>v.label);
/* Up to N genre words, lead first. The order is the classifier's ranking and the words are the whole "sound
   profile" the data can stand behind: a bar per genre would imply a share of the night nobody measured (the
   only per-genre number is classifier confidence, identical across genres on half the events). */
const genreWords=(e,n)=>{
  if(!e.primary)return e.genre&&e.genre.length?e.genre.slice(0,n):[];
  const rest=(e.tags||[]).map(t=>t.label).filter(l=>l&&l!==e.primary);
  return [e.primary,...rest].slice(0,n);
};
/* enriched events lead with two genre words and up to two vibe chips; untagged ones keep the raw source genres */
const tagLine=e=>e.primary?[...genreWords(e,2),...vibesOf(e)].join(' · '):genOf(e);
/* image view: sound only, up to three words. Free / RSVP / ages are logistics and belong on the event page. */
const genreLine=e=>genreWords(e,3).join(' · ');
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
  /* "On sale" is a ticketer saying a ticket can be bought (on_sale), not the absence of "sold out": a
     door-price night is listed, and matches neither filter */
  if(S.avail.size&&!S.avail.has(e.soldout?'out':(e.on_sale?'on':'listed')))return false;
  return true;
}
/* A recommendation outranks any taste score (tasteScore is bounded far below 1000), and both only apply
   under "For you" -- "By time" has to mean by time, or the sort control is a lie. */
const rank=e=>(recFor(e)?1000:0)+tasteScore(e);
/**
 * Does NOCT have a reason to show this one? A recommendation, or one of your genres among its MAIN ones.
 *
 * Two loosenings have been taken back out. `tasteScore(e) > 0` carried a popularity tiebreak, so nearly every
 * event with an interested count passed (197 -> 142 on a weekend). Family matching then let any `techno.*`
 * through for a `techno.peak` taste — and `techno.peak` is the crosswalk's generic bucket for a bare "techno"
 * tag, so it is on 146 events citywide. Requiring an exact code among the event's top two, where genre_codes
 * is ordered by confidence, is the rule that actually shortlists: 198 -> 50 -> 32 on the same weekend.
 */
const LEAD_GENRES=2;
const forMe=e=>{
  if(recFor(e))return true;
  if(!TASTE.length)return false;
  return (e.genre_codes||[]).slice(0,LEAD_GENRES).some(c=>TASTE.includes(c));
};
/** Nothing to filter by until there is a taste or a recommendation, so the control stays hidden until then. */
const canFilterForMe=()=>TASTE.length>0||S.recs.list.some(r=>!r.gone);
/* Picks are an ordered answer -- Best, Safer, Wildcard -- so they come back in that order, not by door time.
   The night's own filters still apply: "Filter · 2" has to mean the same thing on three cards as on thirty. */
const results=()=>{
  /* a group deck is a fixed hand of cards, in the order the plan was dealt; the ones no longer listed drop out */
  if(GRP.active){const out=[];GRP.deck.forEach(u=>{const e=EV.find(x=>x.uuid===u);if(e)out.push(e)});return out}
  if(S.sel==='picks'){
    const out=[];
    S.picks.list.forEach(p=>{const e=EV.find(x=>x.uuid===p.uuid);if(e&&ok(e))out.push(e)});
    return out;
  }
  return EV.filter(ok).filter(e=>S.sel!=='you'||forMe(e)).sort((a,b)=>a.d-b.d
    ||(S.sortTaste?rank(b)-rank(a):0)
    ||(a.door||'99').localeCompare(b.door||'99'));
};
/** One switch for all three views. In image view the caption's "1 of N" is what makes the change legible. */
const SEL_KEY='noct.sel';
function setSel(v){
  if(S.sel===v)return;
  S.sel=v;
  if(v!=='all')S.sortTaste=true;         /* filtering by taste while ignoring it in the order is incoherent */
  try{sessionStorage.setItem(SEL_KEY,v)}catch(e){}   /* an explicit choice holds for the session */
  S.i=0;buildAll();render();renderOnlyBtn();
}
function renderOnlyBtn(){
  const b=$('#btnFor');
  if(!b)return;
  /* a night change empties the picks until the new ones land; do not bounce someone to All in between */
  const loadingPicks=S.picks.loading&&S.sel==='picks';
  const have={all:true,you:canFilterForMe(),picks:S.picks.list.length>0||loadingPicks};
  if(!have[S.sel])S.sel='all';                        /* the taste was cleared, or the night has no picks */
  const show=(have.you||have.picks)&&!GRP.active&&(S.view==='image'||S.view==='list'||S.view==='map');
  b.hidden=!show;
  b.querySelectorAll('button').forEach(x=>{
    x.hidden=!have[x.dataset.sel];
    x.setAttribute('aria-pressed',String(x.dataset.sel===S.sel));
  });
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
  $('#swipeLbl').textContent=GRP.active?'Pass · Like':list.length?`Swipe ${dateLabel().toLowerCase()}`:'Nothing here';   /* the pill's own arrows say which is which */
  if(!list.length){
    if(GRP.active){$('#caption').innerHTML=`<div class="sm">Nothing on this night any more.</div><button class="lnk" onclick="openGroupResult()" style="margin-top:10px">See the plan</button>`;return}
    $('#caption').innerHTML=`<div class="sm">Nothing matches.</div><button class="lnk" onclick="clearAll()" style="margin-top:10px">Clear filters</button>`;return
  }
  const e=list[S.i],rec=recFor(e),pk=pickFor(e),my=GRP.active?GRP.mine[e.uuid]:undefined;
  $('#caption').innerHTML=`
    <div class="idx sm">${S.i+1} of ${list.length} · ${dayFull(e.d)}</div>
    ${GRP.active?(my===true?`<div class="fortag"><span class="fydot"></span>Liked</div>`:my===false?`<div class="fortag">Passed</div>`:'')
      :pk?`<div class="fortag"><span class="fydot"></span>${pk.slot}</div>`:rec?`<div class="fortag"><span class="fydot"></span>For you</div>`:''}
    <div class="name">${e.head}</div>
    <div class="gen">${genreLine(e)}</div>
    <div class="meta sm ${pk&&!GRP.active?'haswhy':''}">${e.venue}</div>
    ${pk&&!GRP.active?`<div class="why">${pk.note}</div>`:''}
    ${GRP.active?`<div class="gvote"><button onclick="vote(false)" aria-pressed="${my===false}">Pass</button><button onclick="vote(true)" aria-pressed="${my===true}">Like</button></div>`:''}
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

/* ---------- Map ----------
   The same nights the other two views show -- results(), so filters and For-you apply -- placed on the venues
   that hold them. One dot per venue family, sized by count, filled when a For-you night is there. Tapping a
   dot opens the venue sheet, which already lists that room's nights; no new list UI.
   Every live city. Coverage after the 0022 backfill: New York 82%, Chicago 76%, Los Angeles 69% of nights
   placed; the rest read as "N without a location yet". */
const MAP_CITIES=new Set(['nyc','la','chi']);
const CITY_CENTRE={nyc:[40.716,-73.955],la:[34.05,-118.30],chi:[41.89,-87.66]};
let MAP=null,MAP_LAYER=null;
function renderMapOption(){
  const b=$('#modeMap');if(!b)return;
  const ok=MAP_CITIES.has(S.city||'nyc');
  b.hidden=!ok;
  if(!ok&&S.view==='map')setView('image');   /* switched to a city without a map while on it */
}
function ensureMap(){
  if(MAP||typeof L==='undefined')return MAP;
  MAP=L.map('map',{zoomControl:false,attributionControl:true,zoomSnap:.5});
  L.control.zoom({position:'bottomright'}).addTo(MAP);          /* top-left is where the NO sits */
  /* OpenStreetMap's own tiles, inverted and desaturated in CSS into the app's palette. CARTO's dark basemap
     would have matched out of the box but now wants an API key. */
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{
    maxZoom:19,
    attribution:'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(MAP);
  MAP_LAYER=L.layerGroup().addTo(MAP);
  MAP.setView(CITY_CENTRE[S.city]||CITY_CENTRE.nyc,12);
  return MAP;
}
function renderMap(){
  if(typeof L==='undefined'){$('#mapNote').textContent='Map is loading…';$('#mapNote').hidden=false;setTimeout(()=>{if(S.view==='map')renderMap()},400);return}
  const m=ensureMap();if(!m)return;
  MAP_LAYER.clearLayers();
  const list=results();
  /* group by venue name (what the venue sheet keys on); coordinates come from the venue record */
  const groups=new Map();
  let placed=0,unplaced=0;const missing=[];
  list.forEach(e=>{
    const i=vInfo(e.venue);
    const lat=Number(i.lat),lng=Number(i.lng);
    if(!isFinite(lat)||!isFinite(lng)||!lat||!lng){unplaced++;const pk=pickFor(e);if(pk)missing.push(pk.slot);return}
    placed++;
    const g=groups.get(e.venue)||{lat,lng,n:0,you:false,slots:[],events:[]};
    g.n++;g.events.push(e);
    /* a pick fills the dot like a For-you night does, and says which pick it is beside it: a filled dot alone
       cannot tell Best match from Wildcard, and on a map there is no row to carry the word */
    const pk=pickFor(e);
    if(pk){g.you=true;if(!g.slots.includes(pk.slot))g.slots.push(pk.slot)}
    else if(forMe(e))g.you=true;
    groups.set(e.venue,g);
  });
  const pts=[],order=Object.values(SLOT);
  groups.forEach((g,name)=>{
    const size=Math.min(16+g.n*4,40);
    const icon=L.divIcon({className:'',html:`<div class="vdot ${g.you?'you':''}" style="width:${size}px;height:${size}px">${g.n>1?g.n:''}</div>`,iconSize:[size,size],iconAnchor:[size/2,size/2]});
    const mk=L.marker([g.lat,g.lng],{icon,title:name,keyboard:true}).on('click',()=>openVenue(name));
    if(g.slots.length){
      g.slots.sort((a,b)=>order.indexOf(a)-order.indexOf(b));
      mk.bindTooltip(g.slots.join(' · '),{permanent:true,direction:'right',offset:[size/2+4,0],className:'vlbl',interactive:false});
    }
    mk.addTo(MAP_LAYER);
    pts.push([g.lat,g.lng]);
  });
  if(pts.length&&!renderMap.fitted){
    /* Fit to where the nights are, not to the furthest room RA filed under the city. The median point is
       immune to a lone dot in Elk Grove or Catskill; 0.2 degrees (~20 km) around it is the metro core. */
    const med=a=>{const x=[...a].sort((p,q)=>p-q);return x[Math.floor(x.length/2)]};
    const c=[med(pts.map(p=>p[0])),med(pts.map(p=>p[1]))];
    const near=pts.filter(p=>Math.abs(p[0]-c[0])<.2&&Math.abs(p[1]-c[1])<.25);
    m.fitBounds(near.length>=3?near:pts,{padding:[40,40],maxZoom:14});renderMap.fitted=true;
  }
  const note=$('#mapNote');
  /* a pick at a secret location is a fact about the night, not a gap in the map: say which pick it is */
  const secret=missing.sort((a,b)=>order.indexOf(a)-order.indexOf(b));
  if(!list.length){note.textContent='Nothing matches.';note.hidden=false}
  else if(S.sel==='picks'&&secret.length&&unplaced===secret.length){note.textContent=`${secret.join(' and ')}: location not announced yet`;note.hidden=false}
  else if(unplaced){note.textContent=`${placed} on the map · ${unplaced} without a location yet${secret.length?` (${secret.join(', ')})`:''}`;note.hidden=false}
  else note.hidden=true;
  setTimeout(()=>m.invalidateSize(),50);   /* the container was display:none a moment ago */
}
function renderList(){
  const list=results();
  renderFbar();
  let out='',cur=-1;
  list.forEach(e=>{
    if(e.d!==cur){cur=e.d;out+=`<div class="dayhead">${dayName(e.d)} · ${dayFull(e.d)}</div>`}
    const rec=recFor(e),pk=pickFor(e);
    out+=`<div class="row" role="button" tabindex="0" onclick="openDet(${e.id})" onkeydown="if(event.key==='Enter'){openDet(${e.id})}">
      <div class="rt">${pk?`<span class="rfor">${pk.slot}</span> · `:rec?`<span class="rfor">For you</span> · `:''}${e.door||'Time on listing'}</div>
      <div class="rn">${e.head}</div>
      <div class="rg">${tagLine(e)}</div>
      <div class="rv">${e.venue}</div>
      <div class="rp ${e.soldout||low(e)===null?'gone':''}">${priceLbl(e)}</div>
      <div class="rgo">${goCount(e.id)} going</div>
      ${pk?`<div class="why">${pk.note}</div>`:''}
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
    ONB.step=1;ONB.editing=false;renderOnb();$('#onb').classList.add('open');
  }catch(e){}
}
function closeOnb(){$('#onb').classList.remove('open')}
function renderOnb(){
  const b=$('#onbBody');if(!b)return;
  if(ONB.step===1){
    b.innerHTML=`<div class="sh2">What do you play loud?</div>`
      +`<div class="onbsub">Pick whatever fits. It only sorts your feed — you can change it any time.</div>`
      +`<div class="opts">`+ONB.opts.map((g,i)=>`<button aria-pressed="${ONB.genres.has(g.code)}" onclick="onbGenre(${i})">${clean(g.label)}</button>`).join('')+`</div>`
      +(ONB.editing
        ? `<div class="onbfoot"><button class="lnk" style="color:var(--d2)" onclick="closeOnb()">Cancel</button>`
          +`<button class="lnk" onclick="onbSaveEdit()">Done</button></div>`
        : `<div class="onbfoot"><button class="lnk" style="color:var(--d2)" onclick="onbSkip()">Skip</button>`
          +`<button class="lnk" onclick="onbNext()">${ONB.genres.size?'Next →':'Not sure yet →'}</button></div>`);
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
/* Editing saves the genres and stops there: someone changing a genre does not need the flyers again. */
function onbSaveEdit(){
  TASTE=[...ONB.genres];tasteRemember();closeOnb();applyTaste();
  persistTaste().then(()=>{invalidateRecs();loadRecs();loadPicks()});render();
  toast(TASTE.length?'Taste updated':'Taste cleared');
}
function onbDone(){
  tasteRemember();closeOnb();applyTaste();
  persistTaste().then(()=>{invalidateRecs();loadRecs();loadPicks()});render();
}
function persistTaste(){
  if(!LIVE)return Promise.resolve(null);
  try{return sbRest('POST','/profile',{taste_genres:TASTE,onboarded_at:new Date().toISOString()}).catch(()=>null)}catch(e){return Promise.resolve(null)}
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
/* "change it any time": the same first question, reopened from the menu with the current answer filled in.
   The options are fetched here if onboarding never ran on this device -- maybeOnboard() cannot be reused for
   that, because it returns early the moment a taste exists, which is exactly the person who wants to edit. */
async function editTaste(){
  closeAll();
  if(!ONB.opts.length){
    try{
      const r=await fetch(`${API_BASE}/api/taste?city=${encodeURIComponent(S.city||'nyc')}`,{headers:{accept:'application/json'}});
      if(r.ok)ONB.opts=(await r.json()).genres||[];
    }catch(e){}
    if(!ONB.opts.length){toast('Could not load genres right now');return}
  }
  ONB.step=1;ONB.genres=new Set(TASTE);ONB.picks=new Set();ONB.editing=true;
  renderOnb();const sh=$('#onb');sh.classList.add('open');sh.scrollTop=0;
}
/* A recommendation that also falls inside the loaded nights, by uuid: the rail and the feed are two views of
   one answer, so a card can carry the reason the recommender already worked out. */
function recFor(e){
  if(!e||!e.uuid)return null;
  return S.recs.list.find(r=>r.uuid===e.uuid&&!r.gone)||null;
}
/* ---------- Picks ----------
   Up to three for the first night loaded, in a fixed order: Best match, Safer choice, Wildcard. RA makes you
   read thirty cards and judge; this is the judgment, compressed -- and everything it says is something the
   card can show. No percentage (the score is a weighted sum, not a probability), no minutes away (there is
   no location), no "tickets available" unless a ticketer said so. Fewer than three when fewer qualify; the
   night is thin, and padding the slots would be the one thing that made the labels a lie. */
const SLOT={best:'Best match',safer:'Safer choice',wild:'Wildcard'};
function pickFor(e){
  if(!e||!e.uuid)return null;
  return S.picks.list.find(p=>p.uuid===e.uuid)||null;
}
/* Ranked rows from /api/recommend?night= -> the labelled picks. Pure, so the rule lives in one place:
   Best   = the top of the ranking; its note is the first reason the recommender gave.
   Safer  = of the rest, the one with the most evidence that other people are going or that a ticket can be
            bought -- ways in, an interested count, a ticketer's "on sale", a known price. Omitted when nothing
            has any: "safer" with no evidence is just a second-best.
   Wild   = of the rest, the highest-ranked one admitted WITHOUT an exact genre or artist match -- the same
            family, the same rooms, the same kind of night, in a genre this person did not name. */
function assignSlots(rows){
  const pool=rows.filter(r=>!r.soldout);
  if(!pool.length)return [];
  const out=[],used=new Set();
  const take=(r,slot,note)=>{used.add(r.uuid);out.push(Object.assign({},r,{slot,note}))};
  const best=pool[0];
  take(best,SLOT.best,whyOne(best.why));
  const rest=()=>pool.filter(r=>!used.has(r.uuid));
  const evidence=r=>(r.ways>=2?1:0)+(r.on_sale?1:0)+Math.min((r.interested||0)/500,2)+(r.from!==null?.5:0);
  const safer=rest().map(r=>[evidence(r),r]).filter(x=>x[0]>0).sort((a,b)=>b[0]-a[0]||b[1].score-a[1].score)[0];
  if(safer)take(safer[1],SLOT.safer,evidenceNote(safer[1]));
  const wild=rest().find(r=>r.signals&&+r.signals.genre===0&&+r.signals.artist===0);
  if(wild)take(wild,SLOT.wild,wild.primary?`Outside your genres · ${wild.primary}`:'Outside your genres');
  return out;
}
const whyOne=why=>{const w=(why||[])[0];return w?`${WHY_LEAD[w.kind]||'Matches'} ${clean(w.detail)}`:'Closest to your taste'};
const evidenceNote=r=>[r.on_sale?'On sale':null,r.interested?`${r.interested.toLocaleString()} interested`:null,
  r.ways>=2?`${r.ways} ways in`:null].filter(Boolean).slice(0,2).join(' · ')||'Listed';
async function loadPicks(){
  if(!LIVE)return;
  const night=(DAYS[0]||[])[3]||'';
  if(!night){S.picks={loading:false,loaded:true,error:false,list:[],night:''};renderOnlyBtn();return}
  const seq=++PICKS_SEQ;
  S.picks={loading:true,loaded:false,error:false,list:S.picks.night===night?S.picks.list:[],night};
  try{
    const s=await sbSession();if(!s)throw new Error('no session');
    /* deep enough to reach a wildcard: an exact-genre match scores ~1.35, a family-only one ~0.6, and a generic
       code like techno.peak sits on 146 nights citywide, so the top twelve are usually all exact matches */
    const qs=new URLSearchParams({city:S.city||'nyc',night,limit:'40'});
    const r=await fetch(`${API_BASE}/api/recommend?${qs}`,{headers:{accept:'application/json',authorization:'Bearer '+s.access_token}});
    if(!r.ok)throw new Error('HTTP '+r.status);
    const j=await r.json();
    if(seq!==PICKS_SEQ)return;                          /* a later load moved the night or the city */
    const rows=(j.events||[]).map(e=>({uuid:e.id,score:+e.score||0,signals:e.signals||{},soldout:!!e.soldout,on_sale:!!e.on_sale,
      interested:e.interested||0,ways:(e.srcs||[]).length,from:typeof e.from==='number'?e.from:null,
      primary:e.primary?clean(e.primary):'',why:Array.isArray(e.why)?e.why:[]}));
    S.picks={loading:false,loaded:true,error:false,list:assignSlots(rows),night};
  }catch(err){if(seq!==PICKS_SEQ)return;S.picks={loading:false,loaded:true,error:true,list:[],night}}
  /* First landing with picks to show: open on them. The thesis is that three good answers beat thirty cards,
     so the three come first -- All is one tap away, and a tap either way holds for the session. */
  let chosen='';try{chosen=sessionStorage.getItem(SEL_KEY)||''}catch(e){}
  if(!chosen&&!loadPicks.landed&&S.picks.list.length>=2){S.sel='picks';S.sortTaste=true;S.i=0;loadPicks.landed=true}
  renderOnlyBtn();render();
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
/* Each load is numbered so a slow answer for the previous city or night cannot land on top of the current one. */
let RECS_SEQ=0,PICKS_SEQ=0;
async function loadRecs(){
  if(!LIVE)return;
  const seq=++RECS_SEQ;
  S.recs={loading:true,loaded:false,error:false,list:S.recs.list,history:S.recs.history};renderRecs();
  try{
    const s=await sbSession();if(!s)throw new Error('no session');
    const r=await fetch(`${API_BASE}/api/recommend?limit=12&city=${encodeURIComponent(S.city||'nyc')}`,{headers:{accept:'application/json',authorization:'Bearer '+s.access_token}});
    if(!r.ok)throw new Error('HTTP '+r.status);
    const j=await r.json();
    if(seq!==RECS_SEQ)return;
    /* The server knows no taste but this device does: the anonymous account was re-created (a refresh that
       failed, a cleared session) and the profile row went with it. Put it back once and ask again -- otherwise
       every For you and every pick stays empty for someone who answered onboarding weeks ago. */
    if(!(j.history_size>0)&&TASTE.length&&!loadRecs.resynced){
      loadRecs.resynced=true;
      await persistTaste();
      if(seq!==RECS_SEQ)return;
      invalidateRecs();loadPicks();return loadRecs();
    }
    S.recs={loading:false,loaded:true,error:false,history:j.history_size||0,
      list:(j.events||[]).map(e=>({uuid:e.id,head:clean(e.head),venue:clean(e.venue),door:clean(e.door),
        night_label:nightLabel(e.night),price:clean(priceOf(e)),why:whyLine(e.why),
        url:cleanUrl(e.url),ra:cleanUrl(e.ra),dice:cleanUrl(e.dice)}))};
  }catch(err){if(seq!==RECS_SEQ)return;S.recs={loading:false,loaded:true,error:true,list:[],history:S.recs.history}}
  renderRecs();renderOnlyBtn();
}
/* the recommendation JSON is the feed's event shape, so reuse its price wording -- including `from`, the door
   price a non-ticketer listed, or half of Los Angeles reads "See listing" here and "$20" on the same card */
const priceOf=e=>{const p=(e.srcs||[]).map(s=>s[1]).filter(v=>typeof v==='number');
  const lo=p.length?Math.min(...p):(typeof e.from==='number'?e.from:null),hi=p.length?Math.max(...p):lo;
  return e.soldout?'Sold out':(lo===null?'See listing':(hi!==lo?'From $':'$')+lo)};
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

let DET_EV=null;                                   /* the event the sheet is showing; Track and After this key on it */
function openDet(eid){
  const e=EV.find(x=>x.id===eid);
  if(!e)return;
  if(!DET_EV||DET_EV.uuid!==e.uuid)stopTrack();  /* a different night: whatever was playing belongs to the last one */
  DET_EV=e;
  const p=prices(e),gap=p.length>1?Math.round((Math.max(...p)-Math.min(...p))*100)/100:0;   /* cents, not float dust */
  const crowd=crowdOf(e.id),vis=visibleTo(e.id),hidden=crowd.length-vis.length,me=isGoing(e.id);
  let guest;
  if(!S.signedIn){
    guest=`<div class="prose">${goCount(e.id)} going. <button class="lnk" onclick="openSign()">Sign in</button> to see who.</div>`;
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
      ${(e.vibes||[]).length?`<div class="k">Vibe</div><div>${e.vibes.map(v=>v.label).join(' · ')}</div>`:''}
      <div class="k">Venue</div><div><button class="go" onclick="openVenue('${esc(e.venue)}')">${e.venue} →</button></div>
      ${vInfo(e.venue).hood?`<div class="k">Area</div><div>${vInfo(e.venue).hood}${vInfo(e.venue).boro?', '+vInfo(e.venue).boro:''}</div>`:''}
      ${e.age?`<div class="k">Ages</div><div>${e.age}</div>`:''}
      ${e.interested?`<div class="k">Interested</div><div>${e.interested.toLocaleString()}</div>`:''}
    </div>
    ${lineupSection(e)}
    <div class="grp"><h3>Going on NOCT · ${goCount(e.id)}</h3>${guest}
      <div class="foot" style="margin-top:18px"><button class="lnk" aria-pressed="${me}" onclick="toggleGoing(${e.id})">${me?"You're going":"I'm going"}</button></div>
    </div>
    ${e.set?`<div class="grp"><h3>Set times<span class="hint"> · tap a name to hear their sets</span></h3>${e.set.map(t=>`<div class="ro"><div class="t">${t[0]}</div><div class="who"><button class="go" onclick="openArtistByName('${esc(t[1])}')">${t[1]} →</button></div></div>`).join('')}</div>`:''}
    <div class="grp"><h3>Tickets · ${e.srcs.length} way${e.srcs.length===1?'':'s'} in</h3>
      ${e.srcs.map(s=>`<div class="tk ${e.soldout?'dead':''}"><div><div class="src">${s[2]||'Ticket'}</div></div><div class="amt">${s[1]===null?'':'$'+s[1]}</div><a class="lnk" href="${s[3]||e.ra||e.dice||e.url||'#'}" target="_blank" rel="noopener">${e.soldout?'Resale':'Open'}</a></div>`).join('')}
      ${gap>0?`<div class="gapnote">Two prices for the same night, $${gap} apart. The RSVP is cheaper but does not guarantee entry.</div>`:''}
      ${!e.full?`<div class="gapnote">Price and set times are not listed here yet. Open the listing for the full record.</div>`:''}
    </div>
    <div class="grp" id="detNext" hidden></div>
    ${e.note?`<div class="grp"><h3>About</h3><p class="prose">${e.note}</p></div>`:''}
    <div class="dacts">
      <button class="lnk" onclick="toggleSave(${e.id});openDet(${e.id})">${isSaved(e.id)?'Saved':'Save'}</button>
      ${directionsUrl(e.venue)?`<a class="lnk" href="${directionsUrl(e.venue)}" target="_blank" rel="noopener">Directions</a>`:''}
      <a class="lnk" href="${e.ra||e.dice||e.url||'#'}" target="_blank" rel="noopener">Open listing</a>
      ${e.uuid?`<a class="lnk" href="${API_BASE}/api/ics?e=${encodeURIComponent(e.uuid)}" rel="noopener">Add to calendar</a>`:''}
      <button class="lnk" onclick="shareEvent(${e.id})">Share</button>
      ${LIVE&&e.uuid&&(GRP.id?true:deckFor(e.d,e.uuid).length>=3)?`<button class="lnk" onclick="${GRP.id?'openGroupResult()':`planWith(${e.id})`}">${GRP.id?'Plan':'Plan with friends'}</button>`:''}
    </div>
  </div>`;
  $('#det').classList.add('open');$('#det').scrollTop=0;
  loadNext(e);
}

/* ---------- Track ----------
   The track on the DICE listing for the night, on the platform's own 30-second clip (DICE-backed nights only).
   One <audio>, never autoplayed: Play starts it; Stop, the clip ending, or closing the sheet stops it. The
   platform is named and linked next to it -- the credit the platforms ask of their own integrations, and it is
   where the whole track lives. */
let AUDIO=null,TRK={uuid:'',key:''};
/* The tracks a sheet can play: the night's own (DICE, 0024) and one per artist (iTunes Search, 0029), each
   keyed so several rows can share one <audio>. Rebuilt by lineupSection() every time the sheet renders. */
let SHEET_TRACKS={};
const trackOf=key=>SHEET_TRACKS[key]||null;
const playingKey=()=>(AUDIO&&!AUDIO.paused&&TRK.uuid===(DET_EV&&DET_EV.uuid))?TRK.key:'';
/* a track's own words: its title is the control, the state rides after it. Under the artist's own row the
   artist's name is dropped from the front of the title ("Coco Maria - Me veo volar" -> "Me veo volar"). */
function trackTitle(t,artist){
  const title=String(t.title);
  if(!artist)return title;
  const m=new RegExp('^'+artist.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'\\s*[-–—:]\\s*','i');
  const cut=title.replace(m,'');
  return cut.length>=2?cut:title;
}
const trackLabel=(t,artist,state)=>`${trackTitle(t,artist)} · <span class="nw">${state==='stop'?'Stop':state==='gone'?'Unavailable':'Play 30&nbsp;s'}</span>`;
const platName=t=>t.platform==='apple'?'Apple Music':'Spotify';
/* Whose night-track this is, when the data says so: a line-up name inside the title ("Caiiro - Ndisize"),
   else the only name on the bill ("Afterglow" on a Nils Hoffmann night -- DICE drops the artist when it is
   the headliner). Two or more names and no match: the track stands alone at the end of the list. */
function trackWho(e){
  const names=(e.lineup&&e.lineup.length?e.lineup:(e.act?[e.act]:[])).filter(Boolean);
  const t=String(e.track.title).toLowerCase();
  const inTitle=names.find(n=>n.length>=3&&t.includes(n.toLowerCase()));
  if(inTitle)return inTitle;
  return names.length===1?names[0]:null;
}
const foldName=s=>String(s||'').normalize('NFKD').replace(/[̀-ͯ]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
/* ---------- Line-up ----------
   Its own section, one row per name, the first marked as the headliner when there are several (billing order
   is what every source gives us). "Set →" is what the tap answers: the artist sheet, with the searches for
   their sets and their other nights. Under each artist, a track: the night's own when it is theirs, else
   their representative one -- the title is the play control, the platform link plays the whole thing. A
   night-track nobody on the bill can be named for closes the list. Apple's previews carry Apple's credit. */
function trackRow(key,t,artist){
  const st=playingKey()===key?'stop':'play';
  return `<div class="tkr"><button class="tkp" id="trk-${key}" data-key="${key}" onclick="toggleTrack('${key}')" aria-pressed="${st==='stop'}">${trackLabel(t,artist,st)}</button><a href="${t.url}" target="_blank" rel="noopener">Play full (${platName(t)})</a></div>`;
}
function lineupSection(e){
  const names=(e.lineup&&e.lineup.length?e.lineup:(e.act?[e.act]:[])).filter(Boolean);
  const night=e.track||null;
  const byArtist=new Map((e.artist_tracks||[]).map(t=>[foldName(t.artist),t]));
  SHEET_TRACKS={};
  if(!names.length&&!night)return '';
  const who=night?trackWho(e):null;
  let apple=false;
  const rows=names.map((n,i)=>{
    const t=(night&&who===n)?night:(byArtist.get(foldName(n))||null);
    if(t){SHEET_TRACKS['a'+i]=t;if(t.platform==='apple')apple=true}
    return `<button class="lu ${t?'has':''}" onclick="openArtistByName('${esc(n)}')"><span class="lun">${n}${i===0&&names.length>1?`<span class="luh">Headliner</span>`:''}</span><span class="luset">Set →</span></button>`
      +(t?trackRow('a'+i,t,n):'');
  });
  if(night&&!(who&&names.includes(who))){SHEET_TRACKS.n=night;if(night.platform==='apple')apple=true;rows.push(trackRow('n',night,null))}
  return `<div class="grp"><h3>Line-up${names.length>1?` · ${names.length}`:''}</h3>${rows.join('')}`
    +(apple?`<div class="credit">Previews courtesy of Apple Music</div>`:'')+`</div>`;
}
function stopTrack(){
  if(AUDIO){AUDIO.pause();AUDIO.removeAttribute('src');AUDIO.load()}
  const was=TRK.key;TRK={uuid:'',key:''};
  const b=was?$('#trk-'+was):null;
  if(b&&!b.disabled){const t=trackOf(was);if(t)b.innerHTML=trackLabel(t,artistOfKey(was),'play');b.setAttribute('aria-pressed','false')}
}
/* the artist a row belongs to, for the title trim: 'a<i>' is the i-th name on the bill, 'n' is nobody's */
const artistOfKey=key=>{if(!DET_EV||!/^a\d+$/.test(key))return null;const names=(DET_EV.lineup&&DET_EV.lineup.length?DET_EV.lineup:(DET_EV.act?[DET_EV.act]:[])).filter(Boolean);return names[+key.slice(1)]||null};
function toggleTrack(key){
  const e=DET_EV,t=trackOf(key);if(!e||!t)return;
  if(playingKey()===key){stopTrack();return}
  stopTrack();                                   /* one clip at a time: a second row stops the first */
  if(!AUDIO){
    AUDIO=new Audio();AUDIO.preload='none';
    AUDIO.addEventListener('ended',stopTrack);
    AUDIO.addEventListener('error',()=>{if(!TRK.key)return;const k=TRK.key;TRK={uuid:'',key:''};const x=$('#trk-'+k),tt=trackOf(k);if(x&&tt){x.innerHTML=trackLabel(tt,artistOfKey(k),'gone');x.disabled=true}});
  }
  /* the tap answers at once; the clip follows when the platform has sent enough of it */
  const mine={uuid:e.uuid,key};TRK=mine;
  const b=$('#trk-'+key);if(b){b.innerHTML=trackLabel(t,artistOfKey(key),'stop');b.setAttribute('aria-pressed','true')}
  AUDIO.src=t.preview;
  AUDIO.play().catch(()=>{
    /* a Stop (or another sheet) before the clip started rejects play() too -- that is not a failure */
    if(TRK!==mine)return;
    TRK={uuid:'',key:''};if(b){b.innerHTML=trackLabel(t,artistOfKey(key),'gone');b.disabled=true}
  });
}

/* ---------- After this, nearby ----------
   The second stop the data can stand behind: rooms within 4 km whose listed close is two hours or more after
   this one's (src/feed/night.ts). Absent when there is nothing to say -- no heading, no placeholder, no
   "afters", no minutes. Directions starts the route at this door, on foot when it is close. */
let NEXT_SEQ=0,NEXT_DONE={uuid:'',html:''};       /* the last answer, so Save / I'm going re-renders do not refetch or blank it */
/* Straight-line distance said coarsely: the number is precise about a quantity nobody walks. Under the walking
   threshold the row says so (and Directions asks for the walking route); beyond it, whole kilometres. */
const kmLabel=(km,walk)=>km===null?'':(walk?'walkable':`${Math.max(1,Math.round(km))} km`);
async function loadNext(e){
  const el=$('#detNext');if(!el)return;
  if(NEXT_DONE.uuid&&NEXT_DONE.uuid===e.uuid){el.innerHTML=NEXT_DONE.html;el.hidden=!NEXT_DONE.html;return}
  el.hidden=true;el.innerHTML='';
  /* no close time, or a night that is not happening: "after this" has no anchor */
  if(!LIVE||!e.uuid||!e.door||!e.close||(e.status&&e.status!=='scheduled'))return;
  const seq=++NEXT_SEQ;
  try{
    const r=await fetch(`${API_BASE}/api/night?e=${encodeURIComponent(e.uuid)}`,{headers:{accept:'application/json'}});
    if(!r.ok)return;
    const j=await r.json();
    if(seq!==NEXT_SEQ||!DET_EV||DET_EV.uuid!==e.uuid)return;   /* the sheet moved on */
    const next=(j.next||[]).map(n=>({uuid:clean(n.id),head:clean(n.head),venue:clean(n.venue),room:n.room?clean(n.room):'',
      door:clean(n.door),close:clean(n.close),night:clean(n.night),km:typeof n.km==='number'?n.km:null,walk:!!n.walk,
      lat:typeof n.lat==='number'?n.lat:null,lng:typeof n.lng==='number'?n.lng:null})).filter(n=>n.uuid&&n.venue);
    let html='';
    if(next.length){
      const o=(j.main&&typeof j.main.lat==='number'&&typeof j.main.lng==='number')?{lat:j.main.lat,lng:j.main.lng}:null;
      html=`<h3>After this, nearby</h3>`+next.map(n=>{
        const dir=(o&&n.lat!==null&&n.lng!==null)?dirBetween(o,n,n.walk):directionsUrl(n.venue);
        const far=kmLabel(n.km,n.walk);
        return `<div class="nx"><button class="nxmain" onclick="openNext('${esc(n.uuid)}','${esc(n.night)}')">`
          +`<div class="nxv">${n.venue}${n.room?' · '+n.room:''}</div><div class="nxh">${n.head}</div>`
          +`<div class="nxs">${n.door}${n.close?'–'+n.close:''}${far?' · '+far:''}</div></button>`
          +(dir?`<a class="lnk" href="${dir}" target="_blank" rel="noopener">Directions</a>`:'')+`</div>`;
      }).join('');
    }
    NEXT_DONE={uuid:e.uuid,html};
    el.innerHTML=html;el.hidden=!html;
  }catch(err){}
}
function openNext(uuid,night){const ev=EV.find(x=>x.uuid===uuid);if(ev){openDet(ev.id);return}openNightAt(uuid,S.city,night)}
/* origin and destination as coordinates: Maps starts the route at this door, walking when it is close */
const dirBetween=(o,d,walk)=>`https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(o.lat+','+o.lng)}&destination=${encodeURIComponent(d.lat+','+d.lng)}&travelmode=${walk?'walking':'transit'}`;

/* ---------- Group Mode ----------
   One link, everyone swipes, the count decides. The owner taps "Plan with friends" on a night: NOCT deals a
   deck of up to twelve cards from the top of the owner's own list for that night, copies a link, and the
   owner swipes first. Everyone who opens the link swipes the same deck; the result is a count per card, in
   words -- "3 of 4 liked", "2 of 4 finished". Never a percentage, never "everyone" unless it is everyone who
   voted, and nobody's individual votes leave the database except their own (0025 group_result). */
const DECK_SIZE=12;
let GRP={id:'',city:'',night:'',deck:[],mine:{},active:false,result:null,owner:false,poll:null,since:0};
/* The owner's list for that night, one card per venue, flyers first, the night in hand leading. `rank`
   already folds recommendations and taste in; interested breaks ties. */
function deckFor(d,leadUuid){
  const pool=EV.filter(e=>e.d===d&&e.uuid&&(!e.status||e.status==='scheduled'))
    .sort((a,b)=>(b.image?1:0)-(a.image?1:0)||rank(b)-rank(a)||(b.interested||0)-(a.interested||0));
  const out=[],venues=new Set();
  const lead=pool.find(e=>e.uuid===leadUuid);
  if(lead){out.push(lead.uuid);venues.add(lead.venue)}
  for(const e of pool){if(out.length>=DECK_SIZE)break;if(venues.has(e.venue))continue;venues.add(e.venue);out.push(e.uuid)}
  return out;
}
const groupLink=()=>`${location.origin}${location.pathname}?${new URLSearchParams({g:GRP.id,city:GRP.city||S.city||'nyc',from:GRP.night,to:GRP.night})}`;
async function planWith(id){
  const e=evById(id);if(!e||!LIVE||!e.uuid)return;
  const deck=deckFor(e.d,e.uuid);
  if(deck.length<3){toast('Not enough on this night to plan around');return}
  const night=(DAYS[e.d]||[])[3]||'';
  let sid='';
  try{
    const r=await sbRest('POST','/group_session',{city:S.city||'nyc',night,deck},'return=representation');
    if(r&&r.ok){const rows=await r.json();sid=(Array.isArray(rows)&&rows[0]&&rows[0].session_id)||''}
  }catch(err){}
  if(!sid){toast('Could not start a plan — check your connection',4000);return}
  GRP={id:sid,city:S.city||'nyc',night,deck,mine:{},active:false,result:null,owner:true,poll:null,since:Date.now()};
  const ok=await copyText(groupLink());
  toast(ok?'Link copied · your turn first':'Could not copy — '+groupLink(),4000);
  startDeck();
}
/* the deck takes over the image view; the seg hides, the swipe pill says what a swipe now means */
function startDeck(){
  closeAll();closePage('det');closePage('ven');
  GRP.active=true;
  const list=results();
  const first=list.findIndex(e=>GRP.mine[e.uuid]===undefined);
  S.i=first>=0?first:0;
  setView('image');
}
function exitDeck(){GRP.active=false;stopPoll();closeAll();S.i=0;setView(S.mode)}
const unvotedLeft=()=>GRP.active&&results().some(e=>GRP.mine[e.uuid]===undefined);
async function vote(liked){
  if(!GRP.active||!GRP.id)return;
  const list=results(),e=list[S.i];if(!e)return;
  const prev=GRP.mine[e.uuid];
  GRP.mine[e.uuid]=liked;
  const after=list.findIndex((x,i)=>i>S.i&&GRP.mine[x.uuid]===undefined);
  const any=list.findIndex(x=>GRP.mine[x.uuid]===undefined);
  const next=after>=0?after:any;
  if(next>=0){S.i=next;filmCut();renderImage();captionIn()}
  else{renderImage();openGroupResult()}
  let ok=false;
  try{const r=await sbRest('POST','/group_vote',{session_id:GRP.id,event_id:e.uuid,liked});ok=!!r&&r.ok}catch(err){}
  if(!ok){
    if(prev===undefined)delete GRP.mine[e.uuid];else GRP.mine[e.uuid]=prev;
    liveNote('Could not save that — check your connection');renderImage();
  }
}
/* the link holder's view of a plan: the session, counts per card, and their own votes */
async function loadGroup(id){
  try{
    const r=await sbRest('POST','/rpc/group_result',{p_session:id},null);
    if(!r||!r.ok)return null;
    const j=await r.json();
    return j&&j.session&&j.session.id?j:null;
  }catch(err){return null}
}
function applyGroup(j){
  const s=j.session;
  GRP.id=clean(s.id);GRP.city=clean(s.city);GRP.night=clean(s.night);GRP.owner=!!s.owner;
  GRP.deck=((Array.isArray(s.live)&&s.live.length?s.live:s.deck)||[]).map(clean);
  const mine={};(j.mine||[]).forEach(v=>{if(v&&v.event_id)mine[clean(v.event_id)]=!!v.liked});
  GRP.mine=Object.assign(mine,GRP.mine);      /* a vote made a moment ago beats a stale read */
  GRP.result=j;
}
/** ?g=<session>: land on the plan's night (the link carries city/from/to), then pick up where this person left off. */
async function openGroupLink(){
  if(openGroupLink.done)return;
  const g=new URLSearchParams(location.search).get('g');
  if(!g)return;
  openGroupLink.done=true;
  if(!/^[0-9a-f-]{36}$/i.test(g)){toast('That plan is no longer available',4000);return}
  const j=await loadGroup(g);
  if(!j){toast('That plan is no longer available',4000);return}
  applyGroup(j);
  if(GRP.night&&GRP.night!==((DAYS[0]||[])[3]||'')){await loadFeed({from:GRP.night,to:GRP.night})}
  const past=GRP.night&&GRP.night<cityDate(0);
  const left=GRP.deck.some(u=>GRP.mine[u]===undefined&&EV.some(e=>e.uuid===u));
  if(past||!left){GRP.active=true;openGroupResult();if(past)liveNote('That night has passed')}
  else startDeck();
}
function openGroupResult(){
  if(!GRP.id)return;
  closeAll();closePage('det');closePage('ven');
  renderGroup();$('#group').classList.add('open');$('#group').scrollTop=0;
  refreshGroup();startPoll();
}
function closeGroup(){stopPoll();closeAll();if(GRP.active&&!unvotedLeft())exitDeck()}
async function refreshGroup(){
  if(!GRP.id)return;
  const j=await loadGroup(GRP.id);
  if(j&&GRP.id===clean(j.session.id)){applyGroup(j);renderGroup()}
}
/* Counts arrive on a poll, a few seconds apart, while the sheet is open and the tab is visible; nothing here
   says "live". Ten minutes is plenty -- a plan is decided or it is not. */
function startPoll(){
  stopPoll();GRP.since=Date.now();
  GRP.poll=setInterval(()=>{
    const open=$('#group').classList.contains('open');
    if(!open||Date.now()-GRP.since>600000){stopPoll();return}
    if(document.visibilityState==='visible')refreshGroup();
  },4000);
}
function stopPoll(){if(GRP.poll){clearInterval(GRP.poll);GRP.poll=null}}
function renderGroup(){
  const b=$('#groupBody');if(!b)return;
  const j=GRP.result,m=j?Number(j.members)||0:0,fin=j?Number(j.finished)||0:0;
  const rows=(j&&j.events||[]).map(x=>({e:EV.find(v=>v.uuid===x.event_id),likes:Number(x.likes)||0,votes:Number(x.votes)||0})).filter(x=>x.e);
  const top=rows[0];
  const head=!j?'Reading the plan…'
    :m===0?'No votes yet'
    :m===1?(Object.keys(GRP.mine).length?'Only you so far':'One person so far')
    :(top&&top.likes===m?`${m} of ${m} liked`:`Most liked: ${top?top.likes:0} of ${m}`);
  const left=unvotedLeft();
  b.innerHTML=`<button class="sx" onclick="closeGroup()" aria-label="Close">✕</button>`
    +`<div class="sh2">${head}</div>`
    +`<div class="gsub">${m?`${fin} of ${m} finished`:'Send the link'}${GRP.night?` · ${nightLabel(GRP.night)}`:''}</div>`
    +rows.map(x=>`<button class="frow" onclick="closeAll();openDet(${x.e.id})"><div><div class="fn">${x.e.head}</div>`
      +`<div class="fm">${x.e.venue}${x.e.door?' · '+x.e.door:''}${GRP.mine[x.e.uuid]===true?' · You liked this':GRP.mine[x.e.uuid]===false?' · You passed':''}</div></div>`
      +`<span class="gcount ${m&&x.likes===m?'all':''}">${m?`${x.likes} of ${m}`:'—'}</span></button>`).join('')
    +`<div class="foot"><button class="lnk" onclick="copyText(groupLink()).then(ok=>toast(ok?'Link copied':'Could not copy — '+groupLink()))">Copy link</button>`
    +(left?`<button class="lnk" onclick="closeAll();startDeck()">Keep swiping</button>`:`<button class="lnk" style="color:var(--d2)" onclick="exitDeck()">Back to the night</button>`)+`</div>`;
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
  if(!hit){
    // Silence here was the bug's second half: the reader saw an unrelated card and no explanation.
    openShared.done=true;
    toast('That night is no longer listed', 4000);
    return;
  }
  openShared.done=true;
  openDet(hit.id);
}
/* ---------- Search ----------
   Events, artists and venues in one box. The ranking is SQL's (search_noct, 0020); this debounces, groups and
   routes. An artist opens its own sheet rather than a dead row -- that is the point of listing artists at all. */
let SRCH={q:'',hits:[],busy:false,seq:0};
function openSearch(){
  closeAll();$('#srch').classList.add('open');
  const i=$('#srchIn');if(i){i.value=SRCH.q;setTimeout(()=>i.focus(),120)}
  renderSearch();
}
const SRCH_LABEL={event:'Nights',artist:'Artists',venue:'Venues'};
function renderSearch(){
  const el=$('#srchOut');if(!el)return;
  if(!LIVE){el.innerHTML=`<div class="empty">Live data only.</div>`;return}
  if(SRCH.q.trim().length<2){el.innerHTML=`<div class="empty">Type a name — a DJ, a room, a party.</div>`;return}
  if(SRCH.busy&&!SRCH.hits.length){el.innerHTML=`<div class="empty">Looking…</div>`;return}
  if(!SRCH.hits.length){el.innerHTML=`<div class="empty">Nothing on for “${clean(SRCH.q)}”.</div>`;return}
  let out='';
  for(const kind of ['artist','venue','event']){
    const group=SRCH.hits.filter(h=>h.kind===kind);
    if(!group.length)continue;
    out+=`<div class="sgrp"><h3>${SRCH_LABEL[kind]}</h3>`+group.map(h=>
      `<button class="shit" onclick="openHit('${h.kind}','${h.id}','${esc(h.label)}','${esc(h.city||'')}','${esc(h.night||'')}')"><span><b>${clean(h.label)}</b>`
      +`${(h.sub||h.city)?`<span class="ssub">${[clean(h.sub||''),h.city&&h.city!==S.city?clean(CITY_NAME(h.city)):''].filter(Boolean).join(' · ')}</span>`:''}</span>`
      +`<span>${h.kind==='event'?'':(h.n||'')}</span></button>`).join('')+`</div>`;
  }
  el.innerHTML=out;
}
async function runSearch(q){
  SRCH.q=q;
  if(q.trim().length<2){SRCH.hits=[];SRCH.busy=false;renderSearch();return}
  const seq=++SRCH.seq;SRCH.busy=true;renderSearch();
  const ask=async city=>{
    const u=`${API_BASE}/api/search?q=${encodeURIComponent(q.trim())}`+(city?`&city=${encodeURIComponent(city)}`:'');
    const r=await fetch(u,{headers:{accept:'application/json'}});
    return r.ok?((await r.json()).results||[]):[];
  };
  try{
    let hits=await ask(S.city||'nyc');
    /* A DJ playing Chicago next week is the answer to "kobosil", not "nothing on". Widen only on a miss, and
       the result carries its city so it never pretends to be tonight's town. */
    if(!hits.length)hits=await ask(null);
    if(seq!==SRCH.seq)return;                       /* a later keystroke already won */
    SRCH.hits=hits;
  }catch(e){if(seq===SRCH.seq)SRCH.hits=[]}
  if(seq===SRCH.seq){SRCH.busy=false;renderSearch()}
}
const CITY_NAME=k=>(CITIES.find(c=>c[0]===k)||[,k||''])[1];
function openHit(kind,id,label,city,night){
  if(kind==='venue'){closeAll();openVenue(label);return}   /* openVenue keys on the name, not the id */
  if(kind==='artist'){openArtist(id,label);return}
  const ev=EV.find(e=>e.uuid===id);
  if(ev){closeAll();openDet(ev.id);return}
  openNightAt(id,city,night);
}
/* Reopen the app on one night with that event's sheet up. The DATE is the part that matters: without it the
   app loads its default range, the event is not in it, and the reader lands on a different night's first card
   -- which is exactly what tapping a search result used to do. */
function openNightAt(uuid,city,night){
  const q=new URLSearchParams({e:uuid,city:city||S.city||'nyc'});
  if(night){q.set('from',night);q.set('to',night)}
  location.href=`${location.pathname}?${q}`;
}
/* ---------- Artist ----------
   A DJ's name is only useful if it leads somewhere. Their upcoming nights, and the search every listener
   actually runs: "<name> dj set". */
function listenLinks(name){
  const q=encodeURIComponent(name), set=encodeURIComponent(name+' dj set');
  return [
    ['YouTube',    `https://www.youtube.com/results?search_query=${set}`],
    ['SoundCloud', `https://soundcloud.com/search/sets?q=${set}`],
    ['Spotify',    `https://open.spotify.com/search/${q}`],
  ];
}
let ART={id:'',name:'',events:[],busy:false};
async function openArtist(id,name){
  ART={id,name:name||'',events:[],busy:true};
  closeAll();$('#artist').classList.add('open');$('#artist').scrollTop=0;renderArtist();
  try{
    const r=await fetch(`${API_BASE}/api/search?artist=${encodeURIComponent(id)}`,{headers:{accept:'application/json'}});
    if(r.ok){const j=await r.json();ART.name=(j.artist||{}).name||ART.name;ART.events=j.events||[]}
  }catch(e){}
  ART.busy=false;renderArtist();
}
/* A line-up entry is a string, not an id. Show the listen links immediately -- they only need the name -- and
   look the artist up in the background so the dates arrive too, which is most of why the sheet is worth
   opening. An exact name match only: a fuzzy one would put someone else's tour under this name. */
async function openArtistByName(name){
  ART={id:'',name:name,events:[],busy:true};
  closeAll();$('#artist').classList.add('open');$('#artist').scrollTop=0;renderArtist();
  try{
    const r=await fetch(`${API_BASE}/api/search?q=${encodeURIComponent(name)}&limit=8`,{headers:{accept:'application/json'}});
    const hits=r.ok?((await r.json()).results||[]):[];
    const norm=x=>String(x).toLowerCase().replace(/\s+/g,' ').trim();
    const exact=hits.find(h=>h.kind==='artist'&&norm(h.label)===norm(name));
    if(exact&&ART.name===name){openArtist(exact.id,exact.label);return}
  }catch(e){}
  if(ART.name===name){ART.busy=false;renderArtist()}
}
function renderArtist(){
  const b=$('#artistBody');if(!b)return;
  const name=ART.name||'Artist';
  b.innerHTML=`<button class="sx" onclick="closeAll()" aria-label="Close">✕</button>`
    +`<div class="sh2">${clean(name)}</div>`
    +`<div class="alisten">`+listenLinks(name).map(([l,u])=>
        `<a href="${u}" target="_blank" rel="noopener">${l}</a>`).join('')+`</div>`
    +(ART.busy?`<div class="empty">Looking for dates…</div>`
      :ART.events.length?`<div class="sgrp"><h3>Playing</h3>`+ART.events.map(e=>
         `<button class="shit" onclick="openArtistNight('${e.id}','${esc(e.night||'')}')"><span><b>${clean(e.head)}</b>`
         +`<span class="ssub">${nightLabel(e.night)}${e.venue?' · '+clean(e.venue):''}</span></span>`
         +`<span>${clean(priceOf(e))}</span></button>`).join('')+`</div>`
      :(ART.id?`<div class="empty">No upcoming dates in ${clean((CITIES.find(c=>c[0]===S.city)||[,'this city'])[1])}.</div>`:''));
}
function openArtistNight(uuid,night){
  const ev=EV.find(e=>e.uuid===uuid);
  if(ev){closeAll();openDet(ev.id);return}
  openNightAt(uuid,S.city,night);
}
/* Directions to a room. A coordinate pins the door; an address is next best; a name plus the city is the last
   resort and lets Google search. The dir/ endpoint opens the Google Maps app where it is installed. */
/* mirror of venue_is_placeholder() in SQL: a placeholder is not a place, so there is nowhere to go */
const venueIsPlaceholder=v=>/\b(tba|tbc)\b|to be announced|secret location|location tba|undisclosed|venue tba/i.test(String(v||''));
function directionsUrl(v){
  if(venueIsPlaceholder(v))return null;
  const i=vInfo(v)||{};
  const cityName=(CITIES.find(c=>c[0]===S.city)||[,'New York'])[1];
  const dest=(typeof i.lat==='number'&&typeof i.lng==='number'&&i.lat&&i.lng)?`${i.lat},${i.lng}`
            :(i.addr?`${v}, ${i.addr}`:`${v}, ${i.hood?i.hood+', ':''}${cityName}`);
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(dest)}`;
}
function openVenue(v){
  const i=vInfo(v),ev=EV.filter(e=>e.venue===v).sort((a,b)=>a.d-b.d||(a.door||'99').localeCompare(b.door||'99'));
  const ig=i.ig?`https://www.instagram.com/${i.ig}/`:`https://www.instagram.com/explore/search/keyword/?q=${encodeURIComponent(v)}`;
  /* What is on here comes FIRST -- from the map especially, that is the whole reason for the tap. The
     prototype's placeholder photo strip and fake Instagram grid are gone; a section that says "Placeholder.
     Real venue photography goes here." is not something to show a person. */
  $('#ven').innerHTML=`
  <div class="dhero"><div class="tex ${i.tones[0]}"></div><button class="dx" onclick="closePage('ven')" aria-label="Close">✕</button></div>
  <div class="dbody">
    <div class="dname">${v}</div>
    <div class="dsup">${i.addr||(i.hood?i.hood+(i.boro?', '+i.boro:''):'Address not on file')}</div>
    <div class="grp"><h3>${ev.length?`${ev.length===1?'One night':ev.length+' nights'} ${dateLabel().toLowerCase()==='tonight'?'tonight':'in '+dateLabel().toLowerCase()}`:'Nothing listed '+dateLabel().toLowerCase()}</h3>
      ${ev.map(e=>`<div class="row" style="padding-left:0;padding-right:0" role="button" tabindex="0" onclick="openDet(${e.id})">
        <div class="rt">${pickFor(e)?`<span class="rfor">${pickFor(e).slot}</span> · `:recFor(e)?`<span class="rfor">For you</span> · `:''}${dayFull(e.d)}${e.door?' · '+e.door:''}</div>
        <div class="rn">${e.head}</div>
        <div class="rg">${tagLine(e)}</div>
        <div class="rv">${e.room||''}</div>
        <div class="rp ${e.soldout?'gone':''}">${priceLbl(e)}</div>
      </div>`).join('')}
    </div>
    <div class="grp"><h3>Go there</h3>
      <div class="links">
        ${directionsUrl(v)?`<a href="${directionsUrl(v)}" target="_blank" rel="noopener">Directions<span>${(i.lat&&i.lng)?'Google Maps':(i.addr?'By address':'Search')}</span></a>`:`<div class="mini">Location not announced yet.</div>`}
        <a href="${ig}" target="_blank" rel="noopener">Instagram<span>${i.ig?'@'+i.ig:'Search'}</span></a>
        ${i.site?`<a href="${i.site}" target="_blank" rel="noopener">Website<span>Door policy</span></a>`:''}
      </div>
    </div>
  </div>`;
  $('#ven').classList.add('open');$('#ven').scrollTop=0;
}
function closePage(id){$('#'+id).classList.remove('open');if(id==='det')stopTrack()}
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
  opt($('#oCity'),CITIES.map(c=>[c[0],c[2]?c[1]:c[1]+' (soon)']),v=>S.city===v,v=>{const c=CITIES.find(x=>x[0]===v);if(c&&c[2]&&S.city!==v){S.city=v;S.area='All';renderMap.fitted=false;if(MAP)MAP.setView(CITY_CENTRE[v]||CITY_CENTRE.nyc,12);closeAll();loadFeed();}});
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
  $('#mNav').innerHTML=[['Events','Back to the feed'],['Search','Artists, venues, nights'],['Venues',''],['Saved',''],['Your taste',tasteLbl],['Profile',S.signedIn?(S.ig?'@'+S.ig:'Signed in'):'Sign in']]
    .map(n=>`<button onclick="menuGo('${n[0]}')">${n[0]}<span>${n[1]}</span></button>`).join('');
}
function menuGo(n){closeAll();
  if(n==='Events')setView(S.mode);
  if(n==='Venues')setView('venues');
  if(n==='Saved')setView('saved');
  if(n==='Profile')setView('profile');
  if(n==='Your taste')editTaste();
  if(n==='Search')openSearch();
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
function quickGen(g){S.gen.has(g)?S.gen.delete(g):S.gen.add(g);S.i=0;buildAll();render();syncTop()}
function goBack(){setView(S.mode)}
function goHome(){
  closeAll();closePage('det');closePage('ven');
  if(GRP.active){stopPoll();GRP.active=false}          /* the plan stays reachable from any event sheet ("Plan") */
  S.i=0;S.mode='image';setView('image');
  ['listView','savedView','venuesView','profileView'].forEach(id=>{const el=$('#'+id);if(el)el.scrollTop=0});
  $('#topscrim').classList.remove('on');
}
function setView(v){
  if(LIVE&&!S.recs.loading&&!S.recs.loaded)loadRecs();
  if(LIVE&&!S.picks.loading&&!S.picks.loaded)loadPicks();
  const primary=(v==='image'||v==='list'||v==='map');
  S.view=v;if(primary)S.mode=v;
  const secondary=(v==='saved'||v==='venues'||v==='profile');
  $('#ctrlRow').hidden=secondary;
  $('#backRow').hidden=!secondary;
  $('#backLbl').textContent=S.mode==='list'?'List view':S.mode==='map'?'Map view':'Events';
  $('#imageView').hidden=v!=='image';$('#listView').hidden=v!=='list';$('#mapView').hidden=v!=='map';
  $('#savedView').hidden=v!=='saved';$('#venuesView').hidden=v!=='venues';$('#profileView').hidden=v!=='profile';
  document.querySelectorAll('[data-mode]').forEach(b=>b.setAttribute('aria-pressed',b.dataset.mode===S.mode&&primary));
  const bar=$('#fbar');
  if(bar){bar.hidden=!primary; if(primary)renderFbar();}
  renderOnlyBtn();
  renderMapOption();
  $('#topscrim').classList.toggle('on',v==='map');       /* controls over map tiles need a ground; artwork does not */
  $('#botscrim').classList.toggle('on',v!=='image');
  render();
  syncTop();
  navPush();
}
/* The header grows and shrinks with the filter bar and the back row, so the scroll offset
   under it is measured rather than guessed at with a constant per view. */
function syncTop(){
  const t=document.querySelector('.top');if(!t)return;
  document.documentElement.style.setProperty('--topH',Math.round(t.getBoundingClientRect().height)+'px');
}
addEventListener('resize',syncTop);
document.querySelectorAll('[data-mode]').forEach(b=>b.onclick=()=>setView(b.dataset.mode));

/* Back should retrace where you were. Without this the first back press leaves the site, which
   reads as "it went home". Each view change and each overlay that opens becomes a history entry;
   popstate replays that snapshot rather than unwinding anything. */
let NAV_REPLAY=false;
function navSnapshot(){
  return {v:S.view,
          over:[...document.querySelectorAll('.sheet.open,.page.open')].map(el=>el.id),
          det:(typeof DET_EV!=='undefined'&&DET_EV)?DET_EV.id:null};
}
function navSame(a,b){return a&&b&&a.v===b.v&&a.det===b.det&&String(a.over)===String(b.over)}
function navPush(){
  if(NAV_REPLAY)return;
  const s=navSnapshot();
  try{ if(!navSame(history.state,s))history.pushState(s,'') }catch(e){}
}
function navApply(s){
  NAV_REPLAY=true;
  try{
    document.querySelectorAll('.sheet.open,.page.open').forEach(el=>{
      if(!s.over.includes(el.id)){el.classList.remove('open');if(el.id==='det')stopTrack()}
    });
    if(s.v&&s.v!==S.view)setView(s.v);
    s.over.forEach(id=>{
      const el=$('#'+id); if(!el||el.classList.contains('open'))return;
      if(id==='det'&&s.det!=null)openDet(s.det); else el.classList.add('open');
    });
  }finally{NAV_REPLAY=false}
}
addEventListener('popstate',ev=>navApply(ev.state||{v:'image',over:[],det:null}));
/* Overlays open from fourteen call sites; watching the class is cheaper than threading a push
   through every one of them, and cannot miss a new one. */
(()=>{
  const obs=new MutationObserver(ms=>{
    if(NAV_REPLAY)return;
    if(ms.some(m=>m.target.classList&&m.target.classList.contains('open')))navPush();
  });
  document.querySelectorAll('.sheet,.page').forEach(el=>obs.observe(el,{attributes:true,attributeFilter:['class']}));
})();
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
/* in a group deck the swipe IS the vote: left passes, right likes */
$('#imageView').addEventListener('pointerup',e=>{if(x0===null)return;const dx=e.clientX-x0;x0=null;if(Math.abs(dx)<=40)return;if(GRP.active)vote(dx>0);else step(dx<0?1:-1)});

function render(){
  $('#locLbl').textContent=locLabel();
  $('#dateLbl').textContent=dateLabel();
  if(S.view==='image')renderImage();
  if(S.view==='list')renderList();
  if(S.view==='map')renderMap();
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
/* the platforms' own hosts only, checked again on this side: a preview URL is data until it is in an <audio> */
const TRACK_HOST={spotify:/^p\.scdn\.co$/i,apple:/^(audio-ssl\.itunes\.apple\.com|[a-z0-9-]+\.mzstatic\.com)$/i};
const TRACK_LINK={spotify:/^open\.spotify\.com$/i,apple:/^(music|itunes)\.apple\.com$/i};
const hostOf=u=>{try{return /^https:\/\//i.test(u)?new URL(u).hostname:''}catch(e){return ''}};
function cleanTrack(t){
  if(!t||(t.platform!=='spotify'&&t.platform!=='apple'))return null;
  const preview=cleanUrl(t.preview),url=cleanUrl(t.url),title=clean(t.title).slice(0,160);
  if(!title||!TRACK_HOST[t.platform].test(hostOf(preview))||!TRACK_LINK[t.platform].test(hostOf(url)))return null;
  return {platform:t.platform,title,url,preview};
}
const hashOf=s=>{let h=7;for(const c of String(s))h=(h*31+c.charCodeAt(0))>>>0;return h};
const tonesOf=name=>{const h=hashOf(name);return [0,1,2,3].map(k=>TEX[(h+k*2)%TEX.length])};
/* Today in the CITY's clock. "Tonight" asked from Los Angeles at 10pm used to be New York's tomorrow. The zones
   arrive with /api/feed cities[]; New York until they do. */
let CITY_TZ={nyc:'America/New_York'};
const cityTz=()=>CITY_TZ[S.city]||'America/New_York';
const cityDate=off=>new Intl.DateTimeFormat('en-CA',{timeZone:cityTz(),year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(Date.now()+off*864e5));

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
/* One sign-in at a time. loadFeed() fires syncMine() and loadRecs() together and neither awaits the other, so
   on a first visit both found SB null and both signed up: two anonymous users per visit, which is why 80
   accounts existed for 4 people's worth of data. Callers now share the in-flight promise. */
let SB_INFLIGHT=null;
async function sbSession(){
  if(SB&&SB.expires_at>Date.now())return SB;
  if(SB_INFLIGHT)return SB_INFLIGHT;
  SB_INFLIGHT=(async()=>{
    try{
      if(SB&&SB.refresh_token){const s=await sbAuth('token?grant_type=refresh_token',{refresh_token:SB.refresh_token});if(s)return s}
      SB=null;try{localStorage.removeItem(SB_STORE)}catch(e){}
      return await sbAuth('signup',{});                    /* anonymous sign-in */
    }catch(e){return null}
  })();
  try{return await SB_INFLIGHT}finally{SB_INFLIGHT=null}
}
/* `prefer`: PostgREST's Prefer header -- upsert by default, 'return=representation' to read back an insert
   (a new plan's id), null for an RPC, which wants neither */
async function sbRest(method,path,body,prefer='resolution=merge-duplicates'){
  const s=await sbSession();if(!s)return null;
  const hdr=t=>Object.assign(sbHeaders(t),prefer?{prefer}:{});
  const opts={method,headers:hdr(s.access_token)};
  if(body)opts.body=JSON.stringify(body);
  let r=await fetch(SB_URL+'/rest/v1'+path,opts);
  if(r.status===401){                                      /* token rejected: start a new session once */
    SB=null;const s2=await sbSession();if(!s2)return null;
    opts.headers=hdr(s2.access_token);
    r=await fetch(SB_URL+'/rest/v1'+path,opts);
  }
  return r;
}
/** A new mark changes the taste profile. Mark it stale rather than blanking it: the rail keeps showing the
    previous answer until a fresh one lands, so marking a night does not make it flicker. */
/* `loading` is cleared too: a stale in-flight answer is dropped by its sequence number, and the next setView()
   asks again for the current city and night instead of waiting on the old request. */
function invalidateRecs(){S.recs.loaded=false;S.recs.error=false;S.recs.loading=false;S.picks.loaded=false;S.picks.error=false;S.picks.loading=false}
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
  const t=cityDate(0);
  if(key==='tomorrow')return [cityDate(1),cityDate(1),'Tomorrow'];
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
function calMove(n){S.calMonth=monthAdd(S.calMonth||dMonth(cityDate(0)),n);renderCal();loadCounts()}
function renderCal(){
  const el=$('#rcal');if(!el)return;
  const m=S.calMonth||dMonth(cityDate(0)),today=cityDate(0);
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
  const m=S.calMonth||dMonth(cityDate(0)),city=S.city||'nyc';
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
    vibes:(e.vibes||[]).map(v=>({code:clean(v.code),label:clean(v.label)})),
    scalars:e.scalars||{},sound:clean(e.sound),age:clean(e.age),interested:e.interested||0,
    srcs:(e.srcs||[]).map(s=>[SHORT_PLAT[s[0]]||clean(s[0]),typeof s[1]==='number'?s[1]:null,clean(s[2]),cleanUrl(s[3])]),
    from:typeof e.from==='number'?e.from:null,
    ra:cleanUrl(e.ra),dice:cleanUrl(e.dice),eb:cleanUrl(e.eb),url:cleanUrl(e.url),tex:TEX.indexOf(e.tex)>=0?e.tex:'x1',
    full:!!e.full,soldout:!!e.soldout,on_sale:!!e.on_sale,note:clean(e.note),status:clean(e.status),image:cleanUrl(e.image),going_count:e.going_count||0,
    act:e.act?clean(e.act):null,
    track:cleanTrack(e.track),
    artist_tracks:(Array.isArray(e.artist_tracks)?e.artist_tracks:[]).map(t=>{const c=cleanTrack(t);return c&&t&&t.artist?Object.assign(c,{artist:clean(t.artist)}):null}).filter(Boolean)
  }));
  const vs={};
  Object.keys(f.venues||{}).forEach(k=>{const v=f.venues[k]||{};vs[clean(k)]={addr:clean(v.addr),hood:clean(v.hood),boro:clean(v.boro),
    ig:clean(v.ig).replace(/[^\w.]/g,''),site:cleanUrl(v.site),ra:cleanUrl(v.ra),dice:cleanUrl(v.dice),verified:!!v.verified,tones:tonesOf(k),
    lat:typeof v.lat==='number'?v.lat:null,lng:typeof v.lng==='number'?v.lng:null}});
  VENUES=vs;
  GENRES=(f.genres||[]).map(clean);
  AREAS=['All',...new Set(EV.map(e=>vInfo(e.venue).boro).filter(Boolean))];
  if(Array.isArray(f.cities)&&f.cities.length){CITIES=f.cities.map(c=>[c.key,clean(c.name),!!c.enabled]);
    f.cities.forEach(c=>{if(c.key&&c.tz)CITY_TZ[clean(c.key)]=clean(c.tz)})}
  if(f.city&&f.city.key&&f.city.tz)CITY_TZ[clean(f.city.key)]=clean(f.city.tz);
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
    const feed=await r.json();
    /* a new window or city makes the last recommendations and picks stale; applyFeed() -> setView() then loads
       both exactly once (they used to be requested twice per load) */
    invalidateRecs();
    applyFeed(feed);
    liveNote('');
    syncMine();                      /* restore this account's going/saved; renders again when it lands */
    if(tasteRestore()){S.sortTaste=TASTE.length>0;render()}else{maybeOnboard()}
    openShared();
    openGroupLink();
  }catch(err){
    liveNote('Live data unavailable — showing sample weekend');
  }
}
(function(){
  const seg=document.getElementById('btnFor');
  if(seg)seg.querySelectorAll('button').forEach(b=>b.onclick=()=>setSel(b.dataset.sel||'all'));
})();
(function(){
  const i=document.getElementById('srchIn');if(!i)return;
  let t=null;
  i.addEventListener('input',()=>{clearTimeout(t);const v=i.value;t=setTimeout(()=>runSearch(v),180)});
  i.addEventListener('keydown',e=>{if(e.key==='Enter'){clearTimeout(t);runSearch(i.value)}});
})();
sbRestore();try{S.sel=['all','you','picks'].includes(sessionStorage.getItem(SEL_KEY))?sessionStorage.getItem(SEL_KEY):'all'}catch(e){}
buildAll();setView('image');loadFeed();
try{history.replaceState(navSnapshot(),'')}catch(e){}   /* the entry back lands on */
syncTop();
