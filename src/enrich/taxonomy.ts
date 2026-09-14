/**
 * NOCT genre + vibe taxonomy — the single source of truth.
 *
 * supabase/migrations/0004_enrichment.sql seeds the same rows (tests/unit/taxonomy.test.ts asserts the DB
 * equals these lists when DATABASE_URL is set). Codes are stable strings `family.sub`; never rename a code,
 * add a new one and migrate event_tag rows instead.
 *
 * Source vocabularies captured live on 2026-09-13:
 *  - RA: the 70 names returned by `{ genres { id name } }` on https://ra.co/graphql (RA_GENRE_NAMES below)
 *  - DICE: `genre_tags` suffixes after the `dj:` / `party:` / `gig:` prefix (tests/fixtures/dice_events_v2.json)
 *  - Elsewhere: 'Electronic','Live Electronic','Indie','Rock','Pop','Hip Hop / R&B'
 *  - Discogs: release `style[]` names (CC0) for the artist-profile cron
 * `aliases` are phrases safe for word-boundary matching in free text (titles / descriptions), so deliberately
 * exclude bare words that name NYC venues or rooms ("house", "disco", "garage", "basement", "ballroom").
 */
import { z } from 'zod';

export type VibeKind = 'space' | 'time' | 'format' | 'crowd' | 'policy';

export interface GenreDef {
  code: string;
  family: string;
  label: string;
  description: string;
  ra_names: string[];
  dice_tags: string[];
  discogs_styles: string[];
  aliases: string[];
  sort: number;
}

export interface VibeDef {
  code: string;
  kind: VibeKind;
  label: string;
  glyph: string;
  description: string;
  sort: number;
}

const g = (
  code: string, label: string, description: string,
  src: { ra?: string[]; dice?: string[]; discogs?: string[]; aliases?: string[] }, sort: number,
): GenreDef => ({
  code, family: code.split('.')[0] as string, label, description,
  ra_names: src.ra ?? [], dice_tags: src.dice ?? [], discogs_styles: src.discogs ?? [], aliases: src.aliases ?? [], sort,
});

export const GENRES: readonly GenreDef[] = [
  // ---- house -------------------------------------------------------------------------------------
  g('house.deep', 'Deep House', 'Warm mid-tempo house: deep chords, soulful or jazzy textures, dubby low end (Larry Heard to Chaos In The CBD).',
    { ra: ['Deep House', 'House'], dice: ['deephouse', 'house', 'deep-house'], discogs: ['Deep House', 'House'], aliases: ['deep house', 'deep-house', 'dubby house', 'deep & dubby'] }, 110),
  g('house.tech', 'Tech House', 'Stripped, groove-first house with techno drums; the big-room end includes Hot Creations / Solid Grooves style rollers.',
    { ra: ['Tech House'], dice: ['tech-house', 'techhouse', 'tech house'], discogs: ['Tech House'], aliases: ['tech house', 'tech-house'] }, 120),
  g('house.progressive', 'Progressive / Melodic', 'Long-build melodic house and "melodic techno" (Afterlife / Anjunadeep lineage): emotive synths, breakdowns, 120-126 bpm.',
    { ra: ['Progressive House'], dice: ['progressivehouse', 'melodictechno', 'melodic-techno', 'melodichouse', 'organichouse'], discogs: ['Progressive House'],
      aliases: ['progressive house', 'prog house', 'melodic techno', 'melodic house', 'melodic house & techno', 'organic house'] }, 130),
  g('house.afro', 'Afro House', 'Afro house and afro tech: polyrhythmic percussion, vocals and chants over 4/4 (Black Coffee, Keinemusik, Culoe De Song).',
    { ra: ['Afro House', 'Afro Tech'], dice: ['afrohouse', 'afro_house', 'afro-house', 'afrotech', 'tribal'], discogs: ['Afro House', 'Tribal House'],
      aliases: ['afro house', 'afro-house', 'afrohouse', 'afro tech', 'afro-tech', 'tribal house'] }, 140),
  g('house.latin', 'Latin House', 'Latin house, tribal guaracha, zapateo and aleteo: Latin percussion and vocals over hard-driving house.',
    { ra: ['Guaracha'], dice: ['latinhouse', 'latin_house', 'guaracha'], discogs: ['Latin House'], aliases: ['latin house', 'guaracha', 'tribal guaracha', 'zapateo', 'aleteo'] }, 150),
  g('house.disco', 'Disco House / Nu-Disco', 'Disco-sampling and disco-influenced house, nu-disco, italo and cosmic edits played at house tempo.',
    { ra: ['Italo Disco'], dice: ['nudisco', 'nu-disco', 'italo', 'italodisco', 'discohouse'], discogs: ['Nu-Disco', 'Italo-Disco', 'Disco House'],
      aliases: ['nu-disco', 'nu disco', 'nudisco', 'disco house', 'italo disco', 'italo-disco', 'italo', 'disco edits', 'cosmic disco'] }, 160),
  g('house.garage', 'UK Garage / Garage House', 'UK garage, 2-step, speed garage, bassline and the New York garage-house lineage.',
    { ra: ['Garage'], dice: ['garage', 'ukg', 'ukgarage', 'uk-garage', 'speedgarage', 'bassline'], discogs: ['UK Garage', 'Garage House', 'Speed Garage', 'Bassline'],
      aliases: ['uk garage', 'ukg', 'garage house', 'speed garage', '2-step', '2 step', 'two-step garage', 'bassline house'] }, 170),
  g('house.jackin', 'Jackin / Chicago House', 'Raw, drum-machine-led Chicago and ghetto house: jacking rhythms, chopped vocals, 125-135 bpm.',
    { ra: [], dice: ['jackin', 'jackinhouse', 'chicagohouse', 'ghettohouse'], discogs: ['Chicago House', 'Ghetto House'],
      aliases: ['jackin house', 'jacking house', 'jackin', 'chicago house', 'ghetto house', 'booty house'] }, 180),
  g('house.soulful', 'Soulful / Gospel House', 'Vocal, gospel and spiritual house from the New York / New Jersey lineage (Joe Claussell, Louie Vega, Kerri Chandler).',
    { ra: [], dice: ['soulfulhouse', 'soulful-house', 'gospelhouse', 'vocalhouse'], discogs: ['Soulful House', 'Gospel House'],
      aliases: ['soulful house', 'gospel house', 'vocal house', 'spiritual house', 'classic house', 'new york house', 'jersey house', 'new jersey house'] }, 190),
  // ---- techno ------------------------------------------------------------------------------------
  g('techno.peak', 'Peak-Time Techno', 'Driving, functional peak-time techno and hard-groove: 130-140 bpm, big rooms, generic "Techno" tags land here.',
    { ra: ['Techno'], dice: ['techno', 'peaktimetechno', 'peak-time-techno', 'hardgroove'], discogs: ['Techno'],
      aliases: ['peak time techno', 'peak-time techno', 'hard groove', 'hardgroove', 'driving techno', 'big room techno', 'groovy techno', 'techno'] }, 210),
  g('techno.hard', 'Hard / Industrial Techno', 'Hard techno, industrial techno and schranz: 140-160 bpm, distorted kicks, warehouse aesthetics.',
    { ra: [], dice: ['hardtechno', 'hard-techno', 'hard techno', 'industrialtechno', 'schranz'], discogs: ['Hard Techno', 'Schranz'],
      aliases: ['hard techno', 'hardtechno', 'industrial techno', 'schranz', 'hard & fast', 'hard and fast'] }, 220),
  g('techno.dub', 'Dub / Hypnotic Techno', 'Dub techno, deep and hypnotic techno: slow-burn, reverb-soaked, loop-driven (Basic Channel, Donato Dozzy).',
    { ra: ['Dub Techno'], dice: ['dubtechno', 'dub-techno', 'hypnotictechno', 'deeptechno'], discogs: ['Dub Techno'],
      aliases: ['dub techno', 'hypnotic techno', 'deep techno', 'hypnotic', 'slow techno', 'ambient techno'] }, 230),
  g('techno.minimal', 'Minimal', 'Minimal techno, minimal house, microhouse and rominimal: sparse, long, detail-focused sets.',
    { ra: ['Minimal', 'Minimal Techno'], dice: ['minimal', 'minimaltechno', 'minimal-techno', 'minimalhouse', 'microhouse'], discogs: ['Minimal', 'Minimal Techno'],
      aliases: ['minimal techno', 'minimal house', 'microhouse', 'micro house', 'rominimal', 'romanian minimal', 'minimal'] }, 240),
  g('techno.acid', 'Acid', 'Acid techno and acid house built on the TB-303 squelch.',
    { ra: ['Acid'], dice: ['acid', 'acidtechno', 'acidhouse', 'acid-house'], discogs: ['Acid', 'Acid House'],
      aliases: ['acid techno', 'acid house', 'acid', '303'] }, 250),
  g('techno.detroit', 'Detroit Techno', 'Detroit and classic techno: Belleville Three lineage, hi-tech soul, UR.',
    { ra: [], dice: ['detroittechno', 'detroit-techno'], discogs: ['Detroit Techno'],
      aliases: ['detroit techno', 'hi-tech soul', 'high tech soul', 'classic techno'] }, 260),
  // ---- trance ------------------------------------------------------------------------------------
  g('trance.prog', 'Progressive Trance', 'Progressive trance: layered, slower-building trance (Anjunabeats lineage).',
    { ra: [], dice: ['progressivetrance', 'progressive-trance'], discogs: ['Progressive Trance'], aliases: ['progressive trance', 'prog trance'] }, 310),
  g('trance.uplifting', 'Trance', 'Uplifting, vocal and classic trance; generic "Trance" tags land here.',
    { ra: ['Trance'], dice: ['trance', 'uplifting', 'upliftingtrance', 'vocaltrance', 'techtrance'], discogs: ['Trance', 'Vocal Trance', 'Tech Trance'],
      aliases: ['uplifting trance', 'vocal trance', 'classic trance', 'trance classics', 'tech trance', 'trance'] }, 320),
  g('trance.psy', 'Psytrance', 'Psytrance, goa and forest psy: 140-150 bpm rolling basslines, outdoor / festival culture.',
    { ra: ['Psytrance'], dice: ['psytrance', 'psy-trance', 'psy', 'psych', 'goa'], discogs: ['Psy-Trance', 'Goa Trance'],
      aliases: ['psytrance', 'psy-trance', 'psy trance', 'goa trance', 'forest psy', 'full-on psy', 'hi-tech psy', 'progressive psy'] }, 330),
  g('trance.hard', 'Hard Trance', 'Hard trance and hard dance: 145-155 bpm, offbeat bass, big leads.',
    { ra: [], dice: ['hardtrance', 'hard-trance', 'harddance'], discogs: ['Hard Trance'], aliases: ['hard trance', 'hardtrance', 'hard dance'] }, 340),
  // ---- drum & bass -------------------------------------------------------------------------------
  g('dnb.liquid', 'Liquid Drum & Bass', 'Liquid and soulful drum & bass: melodic, vocal, rolling.',
    { ra: [], dice: ['liquid', 'liquiddnb', 'liquidfunk'], discogs: ['Liquid Funk'], aliases: ['liquid drum & bass', 'liquid dnb', 'liquid d&b', 'liquid funk', 'liquid drum and bass'] }, 410),
  g('dnb.neuro_jumpup', 'Drum & Bass', 'Dancefloor drum & bass: neurofunk, jump-up, techstep; generic "Drum & Bass" tags land here.',
    { ra: ['Drum & Bass'], dice: ['drumandbass', 'drumnbass', 'drum&bass', 'drum-and-bass', 'drum n bass', 'dnb', 'd&b', 'neurofunk', 'jumpup'], discogs: ['Drum n Bass', 'Neurofunk', 'Jump-Up'],
      aliases: ['drum & bass', 'drum and bass', 'drum n bass', 'drum\'n\'bass', 'dnb', 'd&b', 'd n b', 'neurofunk', 'jump up', 'jump-up', 'techstep'] }, 420),
  g('dnb.jungle', 'Jungle', 'Jungle and ragga jungle: chopped breaks, reggae basslines, 160-170 bpm.',
    { ra: ['Jungle'], dice: ['jungle', 'raggajungle'], discogs: ['Jungle', 'Ragga Jungle'], aliases: ['jungle', 'ragga jungle', 'junglist'] }, 430),
  // ---- bass / club -------------------------------------------------------------------------------
  g('bass.breaks', 'Breakbeat / Breaks', 'Breakbeat, nu-skool breaks, big beat and electro-breaks.',
    { ra: ['Breakbeat'], dice: ['breakbeat', 'breaks', 'nuskoolbreaks', 'bigbeat'], discogs: ['Breakbeat', 'Breaks', 'Big Beat'],
      aliases: ['breakbeat', 'breakbeats', 'breaks', 'nu skool breaks', 'nu-skool breaks', 'big beat', 'electro breaks'] }, 510),
  g('bass.ukfunky', 'UK Funky', 'UK funky: syncopated 130 bpm house-meets-soca-and-broken-beat.',
    { ra: ['UK Funky'], dice: ['ukfunky', 'uk-funky'], discogs: ['UK Funky'], aliases: ['uk funky', 'ukfunky'] }, 520),
  g('bass.club', 'Club / Bass', 'Club music and UK/US bass: Jersey and Baltimore club, ghettotech, hard drum, deconstructed club; generic "Bass"/"Club" tags land here.',
    { ra: ['Bass', 'Club', 'Hard Drum', 'Ghetto Tech'], dice: ['bass', 'club', 'jersey_club', 'jerseyclub', 'jersey-club', 'baltimoreclub', 'ghettotech', 'harddrum', 'clubmusic', 'ukbass', 'deconstructedclub'],
      discogs: ['Bass Music', 'Ghettotech', 'Baltimore Club', 'Jersey Club', 'UK Bass'],
      aliases: ['jersey club', 'baltimore club', 'bmore club', 'philly club', 'ghetto tech', 'ghettotech', 'hard drum', 'club music', 'deconstructed club', 'uk bass', 'bass music', 'club sounds'] }, 530),
  g('bass.grime', 'Grime', 'Grime: 140 bpm UK MC music and instrumental grime.',
    { ra: ['Grime'], dice: ['grime'], discogs: ['Grime'], aliases: ['grime', 'instrumental grime'] }, 540),
  g('bass.footwork', 'Footwork / Juke', 'Chicago footwork and juke: 160 bpm triplet drum programming.',
    { ra: ['Footwork'], dice: ['footwork', 'juke'], discogs: ['Footwork', 'Juke'], aliases: ['footwork', 'juke', 'chicago juke'] }, 550),
  // ---- dubstep -----------------------------------------------------------------------------------
  g('dubstep.140', 'Dubstep / 140', 'UK dubstep and 140: half-step, sub-bass, sound-system rooted (DMZ, Deep Medi).',
    { ra: ['Dubstep'], dice: ['dubstep', '140', 'deepdubstep', 'deep-dubstep'], discogs: ['Dubstep'],
      aliases: ['dubstep', 'deep dubstep', '140 bpm', '140bpm', 'dungeon sound', 'system music'] }, 610),
  g('dubstep.us_bass', 'US Bass / Riddim', 'US festival bass: brostep, riddim, tearout, trap-bass hybrids.',
    { ra: [], dice: ['riddim', 'brostep', 'tearout', 'trapbass', 'bassmusicus'], discogs: ['Brostep'],
      aliases: ['brostep', 'tearout', 'tear out', 'trap bass', 'festival bass', 'headbangers'] }, 620),
  // ---- hard --------------------------------------------------------------------------------------
  g('hard.hardcore', 'Hardcore', 'Hardcore techno, happy hardcore, UK hardcore, frenchcore and speedcore.',
    { ra: ['Hardcore'], dice: ['hardcore', 'happyhardcore', 'ukhardcore', 'frenchcore', 'speedcore'], discogs: ['Hardcore', 'Happy Hardcore', 'Speedcore'],
      aliases: ['hardcore techno', 'happy hardcore', 'uk hardcore', 'frenchcore', 'speedcore', 'hardcore rave'] }, 710),
  g('hard.gabber', 'Gabber', 'Gabber and early / Rotterdam hardcore: 170-200 bpm distorted kicks.',
    { ra: ['Gabber'], dice: ['gabber'], discogs: ['Gabber'], aliases: ['gabber', 'rotterdam hardcore', 'early hardcore'] }, 720),
  g('hard.hardstyle', 'Hardstyle', 'Hardstyle, rawstyle and euphoric hardstyle: 150 bpm reverse bass.',
    { ra: [], dice: ['hardstyle', 'rawstyle'], discogs: ['Hardstyle'], aliases: ['hardstyle', 'rawstyle', 'euphoric hardstyle'] }, 730),
  g('hard.breakcore', 'Breakcore', 'Breakcore, digital hardcore and mashcore: chaotic amen breaks at hardcore tempos.',
    { ra: ['Breakcore'], dice: ['breakcore'], discogs: ['Breakcore'], aliases: ['breakcore', 'digital hardcore', 'mashcore'] }, 740),
  // ---- electro / wave ----------------------------------------------------------------------------
  g('electro.electro', 'Electro', 'Electro: 808-driven broken-beat machine funk (Drexciya, Detroit / Miami electro).',
    { ra: ['Electro'], dice: ['electro'], discogs: ['Electro'], aliases: ['electro', 'electro funk', 'electrofunk', 'miami bass', 'detroit electro'] }, 810),
  g('electro.ebm_industrial', 'EBM / Industrial / Coldwave', 'EBM, industrial, coldwave, darkwave and minimal synth: dark, dancefloor-facing body music.',
    { ra: ['EBM', 'Industrial'], dice: ['ebm', 'industrial', 'darkwave', 'coldwave', 'minimalsynth'], discogs: ['EBM', 'Industrial', 'Darkwave', 'Coldwave', 'Minimal Synth'],
      aliases: ['ebm', 'industrial', 'coldwave', 'cold wave', 'darkwave', 'dark wave', 'body music', 'minimal synth', 'minimal wave', 'techno-industrial', 'industrial dance'] }, 820),
  g('electro.postpunk_newwave', 'Post-Punk / New Wave', 'Post-punk, new wave, synth-pop and goth nights.',
    { ra: ['New Wave', 'Post-Punk'], dice: ['postpunk', 'post-punk', 'newwave', 'new-wave', 'goth', 'synthpop'], discogs: ['New Wave', 'Post-Punk', 'Synth-pop', 'Goth Rock'],
      aliases: ['post-punk', 'post punk', 'postpunk', 'new wave', 'synth-pop', 'synthpop', 'synth pop', 'goth night', 'goth', 'deathrock'] }, 830),
  // ---- leftfield ---------------------------------------------------------------------------------
  g('leftfield.ambient', 'Ambient / Drone', 'Ambient, drone and new age: beatless or near-beatless listening music.',
    { ra: ['Ambient', 'Drone'], dice: ['ambient', 'drone', 'newage'], discogs: ['Ambient', 'Drone', 'Dark Ambient', 'New Age'],
      aliases: ['ambient', 'drone', 'dark ambient', 'new age', 'deep listening', 'ambient set'] }, 910),
  g('leftfield.downtempo', 'Downtempo / Trip-Hop', 'Downtempo, trip-hop, chillout and lo-fi beats.',
    { ra: ['Downtempo'], dice: ['downtempo', 'triphop', 'trip-hop', 'chillout', 'lofi', 'lo-fi'], discogs: ['Downtempo', 'Trip Hop', 'Chillout'],
      aliases: ['downtempo', 'trip hop', 'trip-hop', 'triphop', 'chillout', 'chill out', 'lo-fi beats', 'lofi beats', 'slow & low'] }, 920),
  g('leftfield.experimental', 'Experimental / IDM', 'Experimental, IDM, noise, abstract and outsider electronics; krautrock and vaporwave land here too.',
    { ra: ['Experimental', 'IDM', 'Noise', 'Krautrock', 'Vaporwave'], dice: ['experimental', 'idm', 'noise', 'avantgarde', 'avant-garde', 'leftfield', 'electroacoustic', 'glitch'],
      discogs: ['Experimental', 'Abstract', 'IDM', 'Noise', 'Leftfield', 'Krautrock', 'Vaporwave', 'Musique Concrète', 'Avantgarde', 'Glitch', 'Power Electronics'],
      aliases: ['experimental', 'idm', 'braindance', 'noise', 'harsh noise', 'power electronics', 'krautrock', 'kosmische', 'vaporwave', 'avant-garde', 'avant garde', 'sound art', 'outsider dance', 'outsider electronics', 'leftfield', 'left-field'] }, 930),
  // ---- hip-hop -----------------------------------------------------------------------------------
  g('hiphop.rap', 'Hip-Hop / Rap', 'Hip-hop, rap and trap nights and showcases.',
    { ra: ['Hip-Hop'], dice: ['hiphop', 'hip-hop', 'hip_hop', 'rap', 'trap', 'boombap'], discogs: ['Hip Hop', 'Trap', 'Boom Bap', 'Gangsta', 'Conscious'],
      aliases: ['hip hop', 'hip-hop', 'hiphop', 'rap', 'trap', 'boom bap', 'boom-bap', 'rap night'] }, 1010),
  g('hiphop.rnb', 'R&B', 'R&B, neo-soul and slow jams.',
    { ra: ['R&B'], dice: ['rnb', 'r&b', 'rhythmandblues', 'neosoul'], discogs: ['RnB/Swing', 'Contemporary R&B', 'Neo Soul'],
      aliases: ['r&b', 'rnb', 'r and b', 'rhythm and blues', 'neo soul', 'neo-soul', 'slow jams'] }, 1020),
  g('hiphop.drill', 'Drill', 'Drill: Chicago, UK and Brooklyn drill.',
    { ra: ['Drill'], dice: ['drill', 'ukdrill', 'uk-drill'], discogs: ['Drill', 'UK Drill'], aliases: ['drill', 'uk drill', 'ny drill', 'brooklyn drill'] }, 1030),
  // ---- latin club --------------------------------------------------------------------------------
  g('latin.reggaeton', 'Reggaeton', 'Reggaeton and perreo; generic "Latin" party tags land here.',
    { ra: ['Reggaeton'], dice: ['reggaeton', 'latin', 'latino', 'perreo', 'urbano'], discogs: ['Reggaeton'],
      aliases: ['reggaeton', 'reggaetón', 'perreo', 'perreo intenso', 'latin urban', 'urbano', 'latin night', 'noche latina'] }, 1110),
  g('latin.dembow', 'Dembow', 'Dominican dembow.',
    { ra: ['Dembow'], dice: ['dembow'], discogs: ['Dembow'], aliases: ['dembow'] }, 1120),
  g('latin.neoperreo', 'Neoperreo', 'Neoperreo: internet-era, queer-leaning experimental reggaeton.',
    { ra: ['Neo Perreo'], dice: ['neoperreo', 'neo-perreo'], discogs: ['Neoperreo'], aliases: ['neoperreo', 'neo perreo', 'neo-perreo'] }, 1130),
  g('latin.baile_funk', 'Baile Funk', 'Baile funk / funk carioca / Rio funk and its bruxaria and mandelão offshoots.',
    { ra: ['Baile Funk', 'Rio Funk'], dice: ['baile_funk', 'bailefunk', 'baile-funk', 'funkcarioca', 'brazilianfunk'], discogs: ['Baile Funk', 'Funk Carioca'],
      aliases: ['baile funk', 'funk carioca', 'rio funk', 'brazilian funk', 'funk brasileiro', 'bruxaria', 'mandelão', 'mandelao'] }, 1140),
  g('latin.latin_bass', 'Latin Bass / Cumbia Club', 'Latin bass, cumbia digital, moombahton and tribal guarachero club sounds.',
    { ra: ['Latin Bass'], dice: ['latinbass', 'latin-bass', 'cumbia', 'moombahton', 'tribalguarachero'], discogs: ['Cumbia', 'Moombahton', 'Tribal Guarachero'],
      aliases: ['latin bass', 'latin club', 'cumbia', 'cumbia digital', 'nu cumbia', 'nu-cumbia', 'moombahton', 'tribal guarachero', 'electro cumbia', 'electrocumbia'] }, 1150),
  // ---- afro diaspora -----------------------------------------------------------------------------
  g('afro.afrobeats', 'Afrobeats', 'Afrobeats, afropop, alté and afroswing: contemporary West African pop for the dancefloor. DICE\'s bare "afrobeat" party tag lands here.',
    { ra: ['Afrobeats'], dice: ['afrobeats', 'afrobeat', 'afropop', 'alte', 'afroswing', 'naija', 'afrofusion'], discogs: ['Afrobeats', 'Afropop'],
      aliases: ['afrobeats', 'afro beats', 'afropop', 'afro-pop', 'alté', 'alte night', 'afroswing', 'naija', 'afro-fusion', 'afrofusion', 'afro fusion'] }, 1210),
  g('afro.amapiano', 'Amapiano', 'Amapiano and 3-step: log-drum basslines, South African piano house at 110-115 bpm.',
    { ra: ['Amapiano'], dice: ['amapiano', '3step', 'privateschool'], discogs: ['Amapiano'],
      aliases: ['amapiano', '3-step', '3 step', 'private school amapiano', 'bacardi house', 'sgija', 'log drum'] }, 1220),
  g('afro.gqom_kuduro_singeli', 'Gqom / Kuduro / Singeli', 'Gqom, kuduro, batida, kwaito, singeli: African club electronics from Durban, Luanda / Lisbon and Dar es Salaam.',
    { ra: ['Gqom', 'Kuduro', 'Kwaito', 'Singeli'], dice: ['gqom', 'kuduro', 'kwaito', 'singeli', 'batida', 'afroelectronic', 'afro_electronic'], discogs: ['Gqom', 'Kuduro', 'Kwaito', 'Singeli', 'Batida'],
      aliases: ['gqom', 'kuduro', 'kwaito', 'singeli', 'batida', 'afro-electronic', 'shangaan electro', 'tarraxo', 'tarraxinha'] }, 1230),
  g('afro.afrobeat', 'Afrobeat (Fela-style)', 'Afrobeat proper and highlife: Fela / Tony Allen lineage, usually live bands or 70s-focused DJ sets.',
    { ra: ['Afrobeat'], dice: [], discogs: ['Afrobeat', 'Highlife'],
      aliases: ['afrobeat', 'fela', 'fela kuti', 'tony allen', 'highlife', 'afro-funk', 'afrofunk', 'afro funk'] }, 1240),
  // ---- caribbean ---------------------------------------------------------------------------------
  g('carib.dancehall', 'Dancehall', 'Dancehall, bashment and ragga; DICE\'s "afro_caribbean" party tag lands here.',
    { ra: ['Dancehall'], dice: ['dancehall', 'bashment', 'afro_caribbean', 'afrocaribbean', 'caribbean'], discogs: ['Dancehall', 'Ragga'],
      aliases: ['dancehall', 'bashment', 'ragga', 'caribbean night', 'caribbean party', 'dancehall night'] }, 1310),
  g('carib.reggae_dub', 'Reggae / Dub', 'Reggae, roots, dub and sound-system sessions. RA\'s "Dub" tag lands here (dub techno has its own code).',
    { ra: ['Dub'], dice: ['reggae', 'dub', 'roots', 'rootsreggae', 'loversrock'], discogs: ['Reggae', 'Dub', 'Roots Reggae', 'Lovers Rock', 'Rocksteady', 'Ska'],
      aliases: ['reggae', 'roots reggae', 'dub reggae', 'lovers rock', 'rocksteady', 'ska', 'dub session', 'dub night', 'dubwise', 'steppers'] }, 1320),
  g('carib.soca', 'Soca', 'Soca, power soca, groovy soca and calypso; carnival fetes and j\'ouvert.',
    { ra: [], dice: ['soca', 'carnival', 'calypso'], discogs: ['Soca', 'Calypso'],
      aliases: ['soca', 'calypso', 'power soca', 'groovy soca', 'carnival fete', 'j\'ouvert', 'jouvert', 'fete'] }, 1330),
  // ---- ballroom ----------------------------------------------------------------------------------
  g('ballroom.vogue', 'Ballroom / Vogue', 'Ballroom scene: vogue beats, kiki balls, functions and the queer club music around them.',
    { ra: ['Ballroom'], dice: ['ballroom', 'vogue', 'voguing', 'kiki'], discogs: ['Ballroom'],
      aliases: ['vogue', 'voguing', 'vogue beats', 'kiki ball', 'kiki function', 'ballroom scene', 'ballroom function', 'ballroom beats', 'ha beats', 'mini ball', 'vogue night'] }, 1410),
  // ---- disco / funk ------------------------------------------------------------------------------
  g('disco.disco', 'Disco / Funk / Boogie', 'Disco, funk, boogie and rare groove played as such (Danny Krivit, 718 Sessions) — not disco-house.',
    { ra: ['Disco', 'Funk / Soul'], dice: ['disco', 'funk', 'soul', 'boogie', 'funkandsoul', 'funk-soul', 'motown'], discogs: ['Disco', 'Funk', 'Soul', 'Boogie'],
      aliases: ['boogie', 'soul night', 'funk & soul', 'funk and soul', 'soul & funk', 'disco night', 'disco party', 'disco classics', 'rare groove', 'loft classics', 'all vinyl disco', 'disco & boogie', 'funk night'] }, 1510),
  // ---- live / indie ------------------------------------------------------------------------------
  g('live.indie_electronic', 'Live / Indie Electronic', 'Live electronic acts, electronica, hyperpop, electroclash and indie-dance gigs; RA "Pop"/"Classical" land here as non-club signals.',
    { ra: ['Electronica', 'Pop', 'Classical'], dice: ['electronica', 'hyperpop', 'indieelectronic', 'indie_electronic', 'indie-electronic', 'synth', 'altpop', 'indie', 'pop', 'indietronica', 'electroclash'],
      discogs: ['Electronica', 'Indie Pop', 'Electroclash', 'Chillwave', 'Hyperpop', 'Synthwave'],
      aliases: ['electronica', 'indie electronic', 'indietronica', 'live electronic', 'live electronics', 'hyperpop', 'electroclash', 'chillwave', 'synthwave', 'art pop', 'alt pop', 'alt-pop', 'indie dance', 'indie sleaze'] }, 1610),
  // ---- jazz / global -----------------------------------------------------------------------------
  g('jazz.brokenbeat', 'Jazz / Broken Beat', 'Broken beat / bruk, nu-jazz, jazz-funk, spiritual jazz and jazz-dance nights.',
    { ra: ['Jazz', 'Broken Beat'], dice: ['jazz', 'brokenbeat', 'broken-beat', 'nujazz', 'acidjazz', 'progressivejazz', 'jazzfunk', 'spiritualjazz'],
      discogs: ['Broken Beat', 'Future Jazz', 'Acid Jazz', 'Jazz-Funk', 'Jazzdance', 'Contemporary Jazz', 'Spiritual Jazz'],
      aliases: ['broken beat', 'bruk', 'nu jazz', 'nu-jazz', 'acid jazz', 'jazz-funk', 'jazz funk', 'spiritual jazz', 'jazz dance', 'future jazz', 'live jazz', 'jazz night'] }, 1710),
  g('jazz.balearic_global', 'Balearic / Global Grooves', 'Balearic, cosmic and global-grooves selecting: world records, sunset sessions, "anything goes as long as it sways".',
    { ra: ['Balearic'], dice: ['balearic', 'world', 'global', 'worldmusic', 'bollywood', 'globalbass'], discogs: ['Balearic'],
      aliases: ['balearic', 'balearic beat', 'global grooves', 'world grooves', 'global sounds', 'global bass', 'tropical', 'sunset session', 'sunset sessions'] }, 1720),
  // ---- open format -------------------------------------------------------------------------------
  g('open.eclectic', 'Open Format / Eclectic', 'Deliberately mixed-genre parties: open format, all-vinyl anything-goes, genre-fluid crews.',
    { ra: [], dice: ['openformat', 'open-format', 'eclectic', 'allgenres', 'mixed', 'multigenre'], discogs: [],
      aliases: ['open format', 'open-format', 'all genres', 'all vinyl', 'across the board', 'eclectic', 'anything goes', 'genre-fluid', 'genre fluid', 'no genre', 'multi-genre', 'multigenre'] }, 1810),
];

export const GENRE_CODES = GENRES.map((x) => x.code) as readonly string[];
export const GENRE_FAMILIES = [...new Set(GENRES.map((x) => x.family))] as readonly string[];
export const GENRE_BY_CODE: ReadonlyMap<string, GenreDef> = new Map(GENRES.map((x) => [x.code, x]));

/** The 70 RA genre names (ra.co/graphql `genres { name }`, captured 2026-09-13). Every one maps to exactly one code. */
export const RA_GENRE_NAMES: readonly string[] = [
  'Progressive House', 'Trance', 'Breakbeat', 'Drum & Bass', 'Techno', 'House', 'Acid', 'Afrobeat', 'Hip-Hop', 'Baile Funk',
  'Hardcore', 'Bass', 'Garage', 'Tech House', 'Balearic', 'Electro', 'Breakcore', 'Minimal', 'Ambient', 'Deep House',
  'Disco', 'Downtempo', 'Dub', 'Dubstep', 'Experimental', 'Funk / Soul', 'Grime', 'Broken Beat', 'Jazz', 'Pop',
  'Classical', 'Club', 'Dancehall', 'Drone', 'Dub Techno', 'EBM', 'Footwork', 'Gqom', 'IDM', 'Industrial',
  'Italo Disco', 'Jungle', 'Krautrock', 'Kuduro', 'Kwaito', 'New Wave', 'Noise', 'Post-Punk', 'R&B', 'UK Funky',
  'Vaporwave', 'Amapiano', 'Drill', 'Hard Drum', 'Reggaeton', 'Singeli', 'Rio Funk', 'Latin Bass', 'Guaracha', 'Neo Perreo',
  'Ghetto Tech', 'Dembow', 'Ballroom', 'Afro House', 'Gabber', 'Afrobeats', 'Electronica', 'Psytrance', 'Minimal Techno', 'Afro Tech',
];

/**
 * Source labels that only name a FAMILY ("House", "Techno", "Trance", "Drum & Bass", "Bass", "Club", "Latin").
 * They still map to one representative code so every label has a home, but the crosswalk multiplies their
 * weight down and marks them `generic` so the classifier picks the subgenre from other evidence.
 */
export const GENERIC_LABELS: ReadonlySet<string> = new Set(['house', 'techno', 'trance', 'drumbass', 'drumandbass', 'dnb', 'bass', 'club', 'latin', 'latino', 'afrocaribbean', 'caribbean', 'world', 'global']);

/**
 * Labels that carry no subgenre but do say "this is DJ / club / electronic music" (is_electronic hint = true).
 */
export const ELECTRONIC_GENERIC_LABELS: ReadonlySet<string> = new Set(['electronic', 'dance', 'dj', 'edm', 'clubdance', 'danceelectronic', 'electronicmusic', 'dancemusic', 'rave']);

/**
 * Labels that say "not a club night" (is_electronic hint = false) — gigs, comedy, hip-hop-only showcases, etc.
 * Keyed by the squashed form (lower-case, no spaces / punctuation) the crosswalk normalises to.
 */
export const NON_ELECTRONIC_LABELS: ReadonlySet<string> = new Set([
  'pop', 'classical', 'indie', 'rock', 'indierock', 'altrock', 'alternative', 'altpop', 'dreampop', 'indiepop', 'punk', 'metal', 'deathmetal',
  'folk', 'blues', 'country', 'gospel', 'grunge', 'shoegaze', 'singer', 'singersongwriter', 'swing', 'rocknroll', 'moderncontemporaryrock',
  'psychedelica', 'comedy', 'theatre', 'film', 'talks', 'workshop', 'social', 'sport', 'karaoke', 'rollerskating', 'booklaunch', 'poetry',
  'hiphop', 'rap', 'drill', 'rnb', 'rhythmandblues', 'trap', 'boombap', 'artistsigning', 'playback', 'improvised', 'performance', 'other', 'vgm',
]);

// ---------------------------------------------------------------------------------------------------
// Vibes
// ---------------------------------------------------------------------------------------------------
const v = (code: string, kind: VibeKind, label: string, glyph: string, description: string, sort: number): VibeDef =>
  ({ code, kind, label, glyph, description, sort });

export const VIBES: readonly VibeDef[] = [
  // space
  v('dark_warehouse', 'space', 'Warehouse', '🏭', 'Industrial / warehouse room: concrete, low light, big system (Knockdown Center, Avant Gardner Great Hall, Basement).', 110),
  v('sweaty_basement', 'space', 'Basement', '🕳️', 'Small subterranean or basement room; low ceilings, close quarters.', 120),
  v('big_room_club', 'space', 'Big room', '🏟️', 'Purpose-built club or hall with 1,000+ capacity and a main-stage feel.', 130),
  v('intimate_room', 'space', 'Intimate', '🕯️', 'Under ~200 people: bars, back rooms, listening spaces.', 140),
  v('outdoor_yard', 'space', 'Outdoors', '🌳', 'Yard, garden, courtyard or ruins — at least part of the party is outside (Nowadays yard, Knockdown Ruins).', 150),
  v('rooftop', 'space', 'Rooftop', '🏙️', 'On a roof or terrace with skyline views.', 160),
  v('boat_party', 'space', 'Boat', '⛵', 'On a boat or yacht; fixed boarding time.', 170),
  v('art_space', 'space', 'Art space', '🎨', 'Gallery, studio or arts venue rather than a licensed nightclub.', 180),
  v('park_or_pier', 'space', 'Park / pier', '🌊', 'Public park, pier or beach event, usually daytime and free or cheap.', 190),
  v('pop_up_secret_location', 'space', 'Secret location', '📍', 'Address revealed to ticket holders only, or venue TBA.', 195),
  // time
  v('sunny_day_party', 'time', 'Day party', '☀️', 'Starts in the afternoon and ends by ~22:00 (Mister Sunday, Nowadays yard sessions).', 210),
  v('day_into_night', 'time', 'Day into night', '🌇', 'Starts in daylight and runs past 02:00 — a full arc from sun to closing.', 220),
  v('afters_marathon', 'time', 'Afters / marathon', '🌅', 'Starts after 02:00, or a 10h+ session that runs past sunrise.', 230),
  v('all_nighter', 'time', 'All night', '🌙', 'A night that runs 7h+ and closes at 05:00 or later.', 240),
  v('early_finish', 'time', 'Ends early', '🕐', 'Evening event that wraps by 01:00.', 250),
  v('weekly_residency', 'time', 'Weekly', '🔁', 'A recurring weekly party or residency (promoter prior).', 260),
  v('one_off_special', 'time', 'One-off', '✨', 'Anniversary, closing, opening or otherwise once-only occasion.', 270),
  // format
  v('one_dj_all_night', 'format', 'One DJ all night', '🎧', 'A single artist plays the whole session ("all night long" / "all day").', 310),
  v('long_sets', 'format', 'Long sets', '⏳', 'Extended sets (3h+ per act) rather than a stacked bill.', 320),
  v('b2b_heavy', 'format', 'B2B', '🤝', 'Multiple back-to-back pairings on the bill.', 330),
  v('live_act', 'format', 'Live', '🎛️', 'At least one live / hybrid performance on the lineup.', 340),
  v('listening_focus', 'format', 'Listening', '🔊', 'Listening-bar or hi-fi format: seated or low-key, sound over dancing.', 350),
  v('sound_system_focus', 'format', 'Sound system', '📢', 'The room\'s system is the point — audiophile or sound-system culture (Nowadays, Public Records, Good Room).', 360),
  v('festival_scale_lineup', 'format', 'Festival scale', '🎪', '7+ acts or multiple stages / rooms.', 370),
  v('performance_or_cabaret', 'format', 'Performance', '💃', 'Drag, cabaret, burlesque or performance art alongside music.', 380),
  // crowd
  v('queer_party', 'crowd', 'Queer', '🏳️‍🌈', 'Queer-run or queer-centred party.', 410),
  v('latinx_party', 'crowd', 'Latinx', '💃🏽', 'Latinx-centred party: reggaeton, perreo, cumbia, Latin house.', 420),
  v('black_diaspora_party', 'crowd', 'Diaspora', '🌍', 'Party rooted in Black diaspora sounds: afrobeats, amapiano, dancehall, soca, ballroom.', 430),
  v('local_crews', 'crowd', 'Local crews', '🏠', 'Resident and local-collective driven bill.', 440),
  v('international_headliner', 'crowd', 'Touring headliner', '✈️', 'A touring international headliner tops the bill.', 450),
  v('mainstream_club', 'crowd', 'Mainstream', '🍾', 'Bottle-service / commercial club or EDM-scale production.', 460),
  v('underground', 'crowd', 'Underground', '🚇', 'Underground scene: DIY promoters, non-commercial rooms, word-of-mouth.', 470),
  // policy / price
  v('free_rsvp', 'policy', 'Free / RSVP', '🎟️', 'Free entry or RSVP list.', 510),
  v('cheap_early', 'policy', 'Cheaper early', '⏰', 'Discounted entry before a stated time.', 520),
  v('pricey', 'policy', 'Pricey', '💸', 'Top ticket above $60.', 530),
  v('phone_free', 'policy', 'Phone-free', '📵', 'No photos / camera stickers / phone pouches on the floor.', 540),
  v('dress_code', 'policy', 'Dress code', '👗', 'A stated dress code or theme.', 550),
  v('18_plus', 'policy', '18+', '🔞', 'Minimum age 18.', 560),
  v('21_plus', 'policy', '21+', '🪪', 'Minimum age 21.', 570),
  v('all_ages', 'policy', 'All ages', '👨‍👩‍👧', 'All ages admitted (at least for part of the event).', 580),
  v('sober_friendly', 'policy', 'Sober-friendly', '🫖', 'Alcohol-free or explicitly sober-friendly.', 590),
  v('sold_out_risk', 'policy', 'Selling fast', '🔥', 'Sold out, off-sale, or high interest relative to capacity.', 595),
];

export const VIBE_CODES = VIBES.map((x) => x.code) as readonly string[];
export const VIBE_BY_CODE: ReadonlyMap<string, VibeDef> = new Map(VIBES.map((x) => [x.code, x]));
export const VIBE_KINDS: readonly VibeKind[] = ['space', 'time', 'format', 'crowd', 'policy'];

// zod enums derived from the arrays (structured outputs need enums, and they must equal the DB rows)
export const GenreCodeSchema = z.enum(GENRE_CODES as [string, ...string[]]);
export const VibeCodeSchema = z.enum(VIBE_CODES as [string, ...string[]]);
export type GenreCode = z.infer<typeof GenreCodeSchema>;
export type VibeCode = z.infer<typeof VibeCodeSchema>;

export function isGenreCode(x: string): x is GenreCode {
  return GENRE_BY_CODE.has(x);
}
export function isVibeCode(x: string): x is VibeCode {
  return VIBE_BY_CODE.has(x);
}
