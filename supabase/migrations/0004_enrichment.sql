-- NOCT 0004: genre / vibe enrichment — taxonomy seed, artist genre profiles, classification runs, tag votes.
-- Shapes (genre, vibe, event_tag, event.* enrichment columns, venue priors, promoter) come from 0003.
-- The taxonomy rows in section 1 are GENERATED from src/enrich/taxonomy.ts, the single source of truth —
-- regenerate rather than hand-edit (tests/unit/taxonomy.test.ts asserts the DB rows equal the TS lists).
-- Everything is idempotent so the file can be re-applied. Scheduling lives in 0008 (runner unit), not here.
set search_path = public, extensions;

------------------------------------------------------------------------------
-- 1. Taxonomy seed (generated)
------------------------------------------------------------------------------
insert into genre (code, family, label, description, ra_names, dice_tags, discogs_styles, aliases, sort) values
  ('house.deep', 'house', 'Deep House', 'Warm mid-tempo house: deep chords, soulful or jazzy textures, dubby low end (Larry Heard to Chaos In The CBD).', array['Deep House', 'House']::text[], array['deephouse', 'house', 'deep-house']::text[], array['Deep House', 'House']::text[], array['deep house', 'deep-house', 'dubby house', 'deep & dubby']::text[], 110),
  ('house.tech', 'house', 'Tech House', 'Stripped, groove-first house with techno drums; the big-room end includes Hot Creations / Solid Grooves style rollers.', array['Tech House']::text[], array['tech-house', 'techhouse', 'tech house']::text[], array['Tech House']::text[], array['tech house', 'tech-house']::text[], 120),
  ('house.progressive', 'house', 'Progressive / Melodic', 'Long-build melodic house and "melodic techno" (Afterlife / Anjunadeep lineage): emotive synths, breakdowns, 120-126 bpm.', array['Progressive House']::text[], array['progressivehouse', 'melodictechno', 'melodic-techno', 'melodichouse', 'organichouse']::text[], array['Progressive House']::text[], array['progressive house', 'prog house', 'melodic techno', 'melodic house', 'melodic house & techno', 'organic house']::text[], 130),
  ('house.afro', 'house', 'Afro House', 'Afro house and afro tech: polyrhythmic percussion, vocals and chants over 4/4 (Black Coffee, Keinemusik, Culoe De Song).', array['Afro House', 'Afro Tech']::text[], array['afrohouse', 'afro_house', 'afro-house', 'afrotech', 'tribal']::text[], array['Afro House', 'Tribal House']::text[], array['afro house', 'afro-house', 'afrohouse', 'afro tech', 'afro-tech', 'tribal house']::text[], 140),
  ('house.latin', 'house', 'Latin House', 'Latin house, tribal guaracha, zapateo and aleteo: Latin percussion and vocals over hard-driving house.', array['Guaracha']::text[], array['latinhouse', 'latin_house', 'guaracha']::text[], array['Latin House']::text[], array['latin house', 'guaracha', 'tribal guaracha', 'zapateo', 'aleteo']::text[], 150),
  ('house.disco', 'house', 'Disco House / Nu-Disco', 'Disco-sampling and disco-influenced house, nu-disco, italo and cosmic edits played at house tempo.', array['Italo Disco']::text[], array['nudisco', 'nu-disco', 'italo', 'italodisco', 'discohouse']::text[], array['Nu-Disco', 'Italo-Disco', 'Disco House']::text[], array['nu-disco', 'nu disco', 'nudisco', 'disco house', 'italo disco', 'italo-disco', 'italo', 'disco edits', 'cosmic disco']::text[], 160),
  ('house.garage', 'house', 'UK Garage / Garage House', 'UK garage, 2-step, speed garage, bassline and the New York garage-house lineage.', array['Garage']::text[], array['garage', 'ukg', 'ukgarage', 'uk-garage', 'speedgarage', 'bassline']::text[], array['UK Garage', 'Garage House', 'Speed Garage', 'Bassline']::text[], array['uk garage', 'ukg', 'garage house', 'speed garage', '2-step', '2 step', 'two-step garage', 'bassline house']::text[], 170),
  ('house.jackin', 'house', 'Jackin / Chicago House', 'Raw, drum-machine-led Chicago and ghetto house: jacking rhythms, chopped vocals, 125-135 bpm.', '{}'::text[], array['jackin', 'jackinhouse', 'chicagohouse', 'ghettohouse']::text[], array['Chicago House', 'Ghetto House']::text[], array['jackin house', 'jacking house', 'jackin', 'chicago house', 'ghetto house', 'booty house']::text[], 180),
  ('house.soulful', 'house', 'Soulful / Gospel House', 'Vocal, gospel and spiritual house from the New York / New Jersey lineage (Joe Claussell, Louie Vega, Kerri Chandler).', '{}'::text[], array['soulfulhouse', 'soulful-house', 'gospelhouse', 'vocalhouse']::text[], array['Soulful House', 'Gospel House']::text[], array['soulful house', 'gospel house', 'vocal house', 'spiritual house', 'classic house', 'new york house', 'jersey house', 'new jersey house']::text[], 190),
  ('techno.peak', 'techno', 'Peak-Time Techno', 'Driving, functional peak-time techno and hard-groove: 130-140 bpm, big rooms, generic "Techno" tags land here.', array['Techno']::text[], array['techno', 'peaktimetechno', 'peak-time-techno', 'hardgroove']::text[], array['Techno']::text[], array['peak time techno', 'peak-time techno', 'hard groove', 'hardgroove', 'driving techno', 'big room techno', 'groovy techno', 'techno']::text[], 210),
  ('techno.hard', 'techno', 'Hard / Industrial Techno', 'Hard techno, industrial techno and schranz: 140-160 bpm, distorted kicks, warehouse aesthetics.', '{}'::text[], array['hardtechno', 'hard-techno', 'hard techno', 'industrialtechno', 'schranz']::text[], array['Hard Techno', 'Schranz']::text[], array['hard techno', 'hardtechno', 'industrial techno', 'schranz', 'hard & fast', 'hard and fast']::text[], 220),
  ('techno.dub', 'techno', 'Dub / Hypnotic Techno', 'Dub techno, deep and hypnotic techno: slow-burn, reverb-soaked, loop-driven (Basic Channel, Donato Dozzy).', array['Dub Techno']::text[], array['dubtechno', 'dub-techno', 'hypnotictechno', 'deeptechno']::text[], array['Dub Techno']::text[], array['dub techno', 'hypnotic techno', 'deep techno', 'hypnotic', 'slow techno', 'ambient techno']::text[], 230),
  ('techno.minimal', 'techno', 'Minimal', 'Minimal techno, minimal house, microhouse and rominimal: sparse, long, detail-focused sets.', array['Minimal', 'Minimal Techno']::text[], array['minimal', 'minimaltechno', 'minimal-techno', 'minimalhouse', 'microhouse']::text[], array['Minimal', 'Minimal Techno']::text[], array['minimal techno', 'minimal house', 'microhouse', 'micro house', 'rominimal', 'romanian minimal', 'minimal']::text[], 240),
  ('techno.acid', 'techno', 'Acid', 'Acid techno and acid house built on the TB-303 squelch.', array['Acid']::text[], array['acid', 'acidtechno', 'acidhouse', 'acid-house']::text[], array['Acid', 'Acid House']::text[], array['acid techno', 'acid house', 'acid', '303']::text[], 250),
  ('techno.detroit', 'techno', 'Detroit Techno', 'Detroit and classic techno: Belleville Three lineage, hi-tech soul, UR.', '{}'::text[], array['detroittechno', 'detroit-techno']::text[], array['Detroit Techno']::text[], array['detroit techno', 'hi-tech soul', 'high tech soul', 'classic techno']::text[], 260),
  ('trance.prog', 'trance', 'Progressive Trance', 'Progressive trance: layered, slower-building trance (Anjunabeats lineage).', '{}'::text[], array['progressivetrance', 'progressive-trance']::text[], array['Progressive Trance']::text[], array['progressive trance', 'prog trance']::text[], 310),
  ('trance.uplifting', 'trance', 'Trance', 'Uplifting, vocal and classic trance; generic "Trance" tags land here.', array['Trance']::text[], array['trance', 'uplifting', 'upliftingtrance', 'vocaltrance', 'techtrance']::text[], array['Trance', 'Vocal Trance', 'Tech Trance']::text[], array['uplifting trance', 'vocal trance', 'classic trance', 'trance classics', 'tech trance', 'trance']::text[], 320),
  ('trance.psy', 'trance', 'Psytrance', 'Psytrance, goa and forest psy: 140-150 bpm rolling basslines, outdoor / festival culture.', array['Psytrance']::text[], array['psytrance', 'psy-trance', 'psy', 'psych', 'goa']::text[], array['Psy-Trance', 'Goa Trance']::text[], array['psytrance', 'psy-trance', 'psy trance', 'goa trance', 'forest psy', 'full-on psy', 'hi-tech psy', 'progressive psy']::text[], 330),
  ('trance.hard', 'trance', 'Hard Trance', 'Hard trance and hard dance: 145-155 bpm, offbeat bass, big leads.', '{}'::text[], array['hardtrance', 'hard-trance', 'harddance']::text[], array['Hard Trance']::text[], array['hard trance', 'hardtrance', 'hard dance']::text[], 340),
  ('dnb.liquid', 'dnb', 'Liquid Drum & Bass', 'Liquid and soulful drum & bass: melodic, vocal, rolling.', '{}'::text[], array['liquid', 'liquiddnb', 'liquidfunk']::text[], array['Liquid Funk']::text[], array['liquid drum & bass', 'liquid dnb', 'liquid d&b', 'liquid funk', 'liquid drum and bass']::text[], 410),
  ('dnb.neuro_jumpup', 'dnb', 'Drum & Bass', 'Dancefloor drum & bass: neurofunk, jump-up, techstep; generic "Drum & Bass" tags land here.', array['Drum & Bass']::text[], array['drumandbass', 'drumnbass', 'drum&bass', 'drum-and-bass', 'drum n bass', 'dnb', 'd&b', 'neurofunk', 'jumpup']::text[], array['Drum n Bass', 'Neurofunk', 'Jump-Up']::text[], array['drum & bass', 'drum and bass', 'drum n bass', 'drum''n''bass', 'dnb', 'd&b', 'd n b', 'neurofunk', 'jump up', 'jump-up', 'techstep']::text[], 420),
  ('dnb.jungle', 'dnb', 'Jungle', 'Jungle and ragga jungle: chopped breaks, reggae basslines, 160-170 bpm.', array['Jungle']::text[], array['jungle', 'raggajungle']::text[], array['Jungle', 'Ragga Jungle']::text[], array['jungle', 'ragga jungle', 'junglist']::text[], 430),
  ('bass.breaks', 'bass', 'Breakbeat / Breaks', 'Breakbeat, nu-skool breaks, big beat and electro-breaks.', array['Breakbeat']::text[], array['breakbeat', 'breaks', 'nuskoolbreaks', 'bigbeat']::text[], array['Breakbeat', 'Breaks', 'Big Beat']::text[], array['breakbeat', 'breakbeats', 'breaks', 'nu skool breaks', 'nu-skool breaks', 'big beat', 'electro breaks']::text[], 510),
  ('bass.ukfunky', 'bass', 'UK Funky', 'UK funky: syncopated 130 bpm house-meets-soca-and-broken-beat.', array['UK Funky']::text[], array['ukfunky', 'uk-funky']::text[], array['UK Funky']::text[], array['uk funky', 'ukfunky']::text[], 520),
  ('bass.club', 'bass', 'Club / Bass', 'Club music and UK/US bass: Jersey and Baltimore club, ghettotech, hard drum, deconstructed club; generic "Bass"/"Club" tags land here.', array['Bass', 'Club', 'Hard Drum', 'Ghetto Tech']::text[], array['bass', 'club', 'jersey_club', 'jerseyclub', 'jersey-club', 'baltimoreclub', 'ghettotech', 'harddrum', 'clubmusic', 'ukbass', 'deconstructedclub']::text[], array['Bass Music', 'Ghettotech', 'Baltimore Club', 'Jersey Club', 'UK Bass']::text[], array['jersey club', 'baltimore club', 'bmore club', 'philly club', 'ghetto tech', 'ghettotech', 'hard drum', 'club music', 'deconstructed club', 'uk bass', 'bass music', 'club sounds']::text[], 530),
  ('bass.grime', 'bass', 'Grime', 'Grime: 140 bpm UK MC music and instrumental grime.', array['Grime']::text[], array['grime']::text[], array['Grime']::text[], array['grime', 'instrumental grime']::text[], 540),
  ('bass.footwork', 'bass', 'Footwork / Juke', 'Chicago footwork and juke: 160 bpm triplet drum programming.', array['Footwork']::text[], array['footwork', 'juke']::text[], array['Footwork', 'Juke']::text[], array['footwork', 'juke', 'chicago juke']::text[], 550),
  ('dubstep.140', 'dubstep', 'Dubstep / 140', 'UK dubstep and 140: half-step, sub-bass, sound-system rooted (DMZ, Deep Medi).', array['Dubstep']::text[], array['dubstep', '140', 'deepdubstep', 'deep-dubstep']::text[], array['Dubstep']::text[], array['dubstep', 'deep dubstep', '140 bpm', '140bpm', 'dungeon sound', 'system music']::text[], 610),
  ('dubstep.us_bass', 'dubstep', 'US Bass / Riddim', 'US festival bass: brostep, riddim, tearout, trap-bass hybrids.', '{}'::text[], array['riddim', 'brostep', 'tearout', 'trapbass', 'bassmusicus']::text[], array['Brostep']::text[], array['brostep', 'tearout', 'tear out', 'trap bass', 'festival bass', 'headbangers']::text[], 620),
  ('hard.hardcore', 'hard', 'Hardcore', 'Hardcore techno, happy hardcore, UK hardcore, frenchcore and speedcore.', array['Hardcore']::text[], array['hardcore', 'happyhardcore', 'ukhardcore', 'frenchcore', 'speedcore']::text[], array['Hardcore', 'Happy Hardcore', 'Speedcore']::text[], array['hardcore techno', 'happy hardcore', 'uk hardcore', 'frenchcore', 'speedcore', 'hardcore rave']::text[], 710),
  ('hard.gabber', 'hard', 'Gabber', 'Gabber and early / Rotterdam hardcore: 170-200 bpm distorted kicks.', array['Gabber']::text[], array['gabber']::text[], array['Gabber']::text[], array['gabber', 'rotterdam hardcore', 'early hardcore']::text[], 720),
  ('hard.hardstyle', 'hard', 'Hardstyle', 'Hardstyle, rawstyle and euphoric hardstyle: 150 bpm reverse bass.', '{}'::text[], array['hardstyle', 'rawstyle']::text[], array['Hardstyle']::text[], array['hardstyle', 'rawstyle', 'euphoric hardstyle']::text[], 730),
  ('hard.breakcore', 'hard', 'Breakcore', 'Breakcore, digital hardcore and mashcore: chaotic amen breaks at hardcore tempos.', array['Breakcore']::text[], array['breakcore']::text[], array['Breakcore']::text[], array['breakcore', 'digital hardcore', 'mashcore']::text[], 740),
  ('electro.electro', 'electro', 'Electro', 'Electro: 808-driven broken-beat machine funk (Drexciya, Detroit / Miami electro).', array['Electro']::text[], array['electro']::text[], array['Electro']::text[], array['electro', 'electro funk', 'electrofunk', 'miami bass', 'detroit electro']::text[], 810),
  ('electro.ebm_industrial', 'electro', 'EBM / Industrial / Coldwave', 'EBM, industrial, coldwave, darkwave and minimal synth: dark, dancefloor-facing body music.', array['EBM', 'Industrial']::text[], array['ebm', 'industrial', 'darkwave', 'coldwave', 'minimalsynth']::text[], array['EBM', 'Industrial', 'Darkwave', 'Coldwave', 'Minimal Synth']::text[], array['ebm', 'industrial', 'coldwave', 'cold wave', 'darkwave', 'dark wave', 'body music', 'minimal synth', 'minimal wave', 'techno-industrial', 'industrial dance']::text[], 820),
  ('electro.postpunk_newwave', 'electro', 'Post-Punk / New Wave', 'Post-punk, new wave, synth-pop and goth nights.', array['New Wave', 'Post-Punk']::text[], array['postpunk', 'post-punk', 'newwave', 'new-wave', 'goth', 'synthpop']::text[], array['New Wave', 'Post-Punk', 'Synth-pop', 'Goth Rock']::text[], array['post-punk', 'post punk', 'postpunk', 'new wave', 'synth-pop', 'synthpop', 'synth pop', 'goth night', 'goth', 'deathrock']::text[], 830),
  ('leftfield.ambient', 'leftfield', 'Ambient / Drone', 'Ambient, drone and new age: beatless or near-beatless listening music.', array['Ambient', 'Drone']::text[], array['ambient', 'drone', 'newage']::text[], array['Ambient', 'Drone', 'Dark Ambient', 'New Age']::text[], array['ambient', 'drone', 'dark ambient', 'new age', 'deep listening', 'ambient set']::text[], 910),
  ('leftfield.downtempo', 'leftfield', 'Downtempo / Trip-Hop', 'Downtempo, trip-hop, chillout and lo-fi beats.', array['Downtempo']::text[], array['downtempo', 'triphop', 'trip-hop', 'chillout', 'lofi', 'lo-fi']::text[], array['Downtempo', 'Trip Hop', 'Chillout']::text[], array['downtempo', 'trip hop', 'trip-hop', 'triphop', 'chillout', 'chill out', 'lo-fi beats', 'lofi beats', 'slow & low']::text[], 920),
  ('leftfield.experimental', 'leftfield', 'Experimental / IDM', 'Experimental, IDM, noise, abstract and outsider electronics; krautrock and vaporwave land here too.', array['Experimental', 'IDM', 'Noise', 'Krautrock', 'Vaporwave']::text[], array['experimental', 'idm', 'noise', 'avantgarde', 'avant-garde', 'leftfield', 'electroacoustic', 'glitch']::text[], array['Experimental', 'Abstract', 'IDM', 'Noise', 'Leftfield', 'Krautrock', 'Vaporwave', 'Musique Concrète', 'Avantgarde', 'Glitch', 'Power Electronics']::text[], array['experimental', 'idm', 'braindance', 'noise', 'harsh noise', 'power electronics', 'krautrock', 'kosmische', 'vaporwave', 'avant-garde', 'avant garde', 'sound art', 'outsider dance', 'outsider electronics', 'leftfield', 'left-field']::text[], 930),
  ('hiphop.rap', 'hiphop', 'Hip-Hop / Rap', 'Hip-hop, rap and trap nights and showcases.', array['Hip-Hop']::text[], array['hiphop', 'hip-hop', 'hip_hop', 'rap', 'trap', 'boombap']::text[], array['Hip Hop', 'Trap', 'Boom Bap', 'Gangsta', 'Conscious']::text[], array['hip hop', 'hip-hop', 'hiphop', 'rap', 'trap', 'boom bap', 'boom-bap', 'rap night']::text[], 1010),
  ('hiphop.rnb', 'hiphop', 'R&B', 'R&B, neo-soul and slow jams.', array['R&B']::text[], array['rnb', 'r&b', 'rhythmandblues', 'neosoul']::text[], array['RnB/Swing', 'Contemporary R&B', 'Neo Soul']::text[], array['r&b', 'rnb', 'r and b', 'rhythm and blues', 'neo soul', 'neo-soul', 'slow jams']::text[], 1020),
  ('hiphop.drill', 'hiphop', 'Drill', 'Drill: Chicago, UK and Brooklyn drill.', array['Drill']::text[], array['drill', 'ukdrill', 'uk-drill']::text[], array['Drill', 'UK Drill']::text[], array['drill', 'uk drill', 'ny drill', 'brooklyn drill']::text[], 1030),
  ('latin.reggaeton', 'latin', 'Reggaeton', 'Reggaeton and perreo; generic "Latin" party tags land here.', array['Reggaeton']::text[], array['reggaeton', 'latin', 'latino', 'perreo', 'urbano']::text[], array['Reggaeton']::text[], array['reggaeton', 'reggaetón', 'perreo', 'perreo intenso', 'latin urban', 'urbano', 'latin night', 'noche latina']::text[], 1110),
  ('latin.dembow', 'latin', 'Dembow', 'Dominican dembow.', array['Dembow']::text[], array['dembow']::text[], array['Dembow']::text[], array['dembow']::text[], 1120),
  ('latin.neoperreo', 'latin', 'Neoperreo', 'Neoperreo: internet-era, queer-leaning experimental reggaeton.', array['Neo Perreo']::text[], array['neoperreo', 'neo-perreo']::text[], array['Neoperreo']::text[], array['neoperreo', 'neo perreo', 'neo-perreo']::text[], 1130),
  ('latin.baile_funk', 'latin', 'Baile Funk', 'Baile funk / funk carioca / Rio funk and its bruxaria and mandelão offshoots.', array['Baile Funk', 'Rio Funk']::text[], array['baile_funk', 'bailefunk', 'baile-funk', 'funkcarioca', 'brazilianfunk']::text[], array['Baile Funk', 'Funk Carioca']::text[], array['baile funk', 'funk carioca', 'rio funk', 'brazilian funk', 'funk brasileiro', 'bruxaria', 'mandelão', 'mandelao']::text[], 1140),
  ('latin.latin_bass', 'latin', 'Latin Bass / Cumbia Club', 'Latin bass, cumbia digital, moombahton and tribal guarachero club sounds.', array['Latin Bass']::text[], array['latinbass', 'latin-bass', 'cumbia', 'moombahton', 'tribalguarachero']::text[], array['Cumbia', 'Moombahton', 'Tribal Guarachero']::text[], array['latin bass', 'latin club', 'cumbia', 'cumbia digital', 'nu cumbia', 'nu-cumbia', 'moombahton', 'tribal guarachero', 'electro cumbia', 'electrocumbia']::text[], 1150),
  ('afro.afrobeats', 'afro', 'Afrobeats', 'Afrobeats, afropop, alté and afroswing: contemporary West African pop for the dancefloor. DICE''s bare "afrobeat" party tag lands here.', array['Afrobeats']::text[], array['afrobeats', 'afrobeat', 'afropop', 'alte', 'afroswing', 'naija', 'afrofusion']::text[], array['Afrobeats', 'Afropop']::text[], array['afrobeats', 'afro beats', 'afropop', 'afro-pop', 'alté', 'alte night', 'afroswing', 'naija', 'afro-fusion', 'afrofusion', 'afro fusion']::text[], 1210),
  ('afro.amapiano', 'afro', 'Amapiano', 'Amapiano and 3-step: log-drum basslines, South African piano house at 110-115 bpm.', array['Amapiano']::text[], array['amapiano', '3step', 'privateschool']::text[], array['Amapiano']::text[], array['amapiano', '3-step', '3 step', 'private school amapiano', 'bacardi house', 'sgija', 'log drum']::text[], 1220),
  ('afro.gqom_kuduro_singeli', 'afro', 'Gqom / Kuduro / Singeli', 'Gqom, kuduro, batida, kwaito, singeli: African club electronics from Durban, Luanda / Lisbon and Dar es Salaam.', array['Gqom', 'Kuduro', 'Kwaito', 'Singeli']::text[], array['gqom', 'kuduro', 'kwaito', 'singeli', 'batida', 'afroelectronic', 'afro_electronic']::text[], array['Gqom', 'Kuduro', 'Kwaito', 'Singeli', 'Batida']::text[], array['gqom', 'kuduro', 'kwaito', 'singeli', 'batida', 'afro-electronic', 'shangaan electro', 'tarraxo', 'tarraxinha']::text[], 1230),
  ('afro.afrobeat', 'afro', 'Afrobeat (Fela-style)', 'Afrobeat proper and highlife: Fela / Tony Allen lineage, usually live bands or 70s-focused DJ sets.', array['Afrobeat']::text[], '{}'::text[], array['Afrobeat', 'Highlife']::text[], array['afrobeat', 'fela', 'fela kuti', 'tony allen', 'highlife', 'afro-funk', 'afrofunk', 'afro funk']::text[], 1240),
  ('carib.dancehall', 'carib', 'Dancehall', 'Dancehall, bashment and ragga; DICE''s "afro_caribbean" party tag lands here.', array['Dancehall']::text[], array['dancehall', 'bashment', 'afro_caribbean', 'afrocaribbean', 'caribbean']::text[], array['Dancehall', 'Ragga']::text[], array['dancehall', 'bashment', 'ragga', 'caribbean night', 'caribbean party', 'dancehall night']::text[], 1310),
  ('carib.reggae_dub', 'carib', 'Reggae / Dub', 'Reggae, roots, dub and sound-system sessions. RA''s "Dub" tag lands here (dub techno has its own code).', array['Dub']::text[], array['reggae', 'dub', 'roots', 'rootsreggae', 'loversrock']::text[], array['Reggae', 'Dub', 'Roots Reggae', 'Lovers Rock', 'Rocksteady', 'Ska']::text[], array['reggae', 'roots reggae', 'dub reggae', 'lovers rock', 'rocksteady', 'ska', 'dub session', 'dub night', 'dubwise', 'steppers']::text[], 1320),
  ('carib.soca', 'carib', 'Soca', 'Soca, power soca, groovy soca and calypso; carnival fetes and j''ouvert.', '{}'::text[], array['soca', 'carnival', 'calypso']::text[], array['Soca', 'Calypso']::text[], array['soca', 'calypso', 'power soca', 'groovy soca', 'carnival fete', 'j''ouvert', 'jouvert', 'fete']::text[], 1330),
  ('ballroom.vogue', 'ballroom', 'Ballroom / Vogue', 'Ballroom scene: vogue beats, kiki balls, functions and the queer club music around them.', array['Ballroom']::text[], array['ballroom', 'vogue', 'voguing', 'kiki']::text[], array['Ballroom']::text[], array['vogue', 'voguing', 'vogue beats', 'kiki ball', 'kiki function', 'ballroom scene', 'ballroom function', 'ballroom beats', 'ha beats', 'mini ball', 'vogue night']::text[], 1410),
  ('disco.disco', 'disco', 'Disco / Funk / Boogie', 'Disco, funk, boogie and rare groove played as such (Danny Krivit, 718 Sessions) — not disco-house.', array['Disco', 'Funk / Soul']::text[], array['disco', 'funk', 'soul', 'boogie', 'funkandsoul', 'funk-soul', 'motown']::text[], array['Disco', 'Funk', 'Soul', 'Boogie']::text[], array['boogie', 'soul night', 'funk & soul', 'funk and soul', 'soul & funk', 'disco night', 'disco party', 'disco classics', 'rare groove', 'loft classics', 'all vinyl disco', 'disco & boogie', 'funk night']::text[], 1510),
  ('live.indie_electronic', 'live', 'Live / Indie Electronic', 'Live electronic acts, electronica, hyperpop, electroclash and indie-dance gigs; RA "Pop"/"Classical" land here as non-club signals.', array['Electronica', 'Pop', 'Classical']::text[], array['electronica', 'hyperpop', 'indieelectronic', 'indie_electronic', 'indie-electronic', 'synth', 'altpop', 'indie', 'pop', 'indietronica', 'electroclash']::text[], array['Electronica', 'Indie Pop', 'Electroclash', 'Chillwave', 'Hyperpop', 'Synthwave']::text[], array['electronica', 'indie electronic', 'indietronica', 'live electronic', 'live electronics', 'hyperpop', 'electroclash', 'chillwave', 'synthwave', 'art pop', 'alt pop', 'alt-pop', 'indie dance', 'indie sleaze']::text[], 1610),
  ('jazz.brokenbeat', 'jazz', 'Jazz / Broken Beat', 'Broken beat / bruk, nu-jazz, jazz-funk, spiritual jazz and jazz-dance nights.', array['Jazz', 'Broken Beat']::text[], array['jazz', 'brokenbeat', 'broken-beat', 'nujazz', 'acidjazz', 'progressivejazz', 'jazzfunk', 'spiritualjazz']::text[], array['Broken Beat', 'Future Jazz', 'Acid Jazz', 'Jazz-Funk', 'Jazzdance', 'Contemporary Jazz', 'Spiritual Jazz']::text[], array['broken beat', 'bruk', 'nu jazz', 'nu-jazz', 'acid jazz', 'jazz-funk', 'jazz funk', 'spiritual jazz', 'jazz dance', 'future jazz', 'live jazz', 'jazz night']::text[], 1710),
  ('jazz.balearic_global', 'jazz', 'Balearic / Global Grooves', 'Balearic, cosmic and global-grooves selecting: world records, sunset sessions, "anything goes as long as it sways".', array['Balearic']::text[], array['balearic', 'world', 'global', 'worldmusic', 'bollywood', 'globalbass']::text[], array['Balearic']::text[], array['balearic', 'balearic beat', 'global grooves', 'world grooves', 'global sounds', 'global bass', 'tropical', 'sunset session', 'sunset sessions']::text[], 1720),
  ('open.eclectic', 'open', 'Open Format / Eclectic', 'Deliberately mixed-genre parties: open format, all-vinyl anything-goes, genre-fluid crews.', '{}'::text[], array['openformat', 'open-format', 'eclectic', 'allgenres', 'mixed', 'multigenre']::text[], '{}'::text[], array['open format', 'open-format', 'all genres', 'all vinyl', 'across the board', 'eclectic', 'anything goes', 'genre-fluid', 'genre fluid', 'no genre', 'multi-genre', 'multigenre']::text[], 1810)
on conflict (code) do update set family = excluded.family, label = excluded.label, description = excluded.description,
  ra_names = excluded.ra_names, dice_tags = excluded.dice_tags, discogs_styles = excluded.discogs_styles, aliases = excluded.aliases, sort = excluded.sort;

insert into vibe (code, kind, label, glyph, description, sort) values
  ('dark_warehouse', 'space', 'Warehouse', '🏭', 'Industrial / warehouse room: concrete, low light, big system (Knockdown Center, Avant Gardner Great Hall, Basement).', 110),
  ('sweaty_basement', 'space', 'Basement', '🕳️', 'Small subterranean or basement room; low ceilings, close quarters.', 120),
  ('big_room_club', 'space', 'Big room', '🏟️', 'Purpose-built club or hall with 1,000+ capacity and a main-stage feel.', 130),
  ('intimate_room', 'space', 'Intimate', '🕯️', 'Under ~200 people: bars, back rooms, listening spaces.', 140),
  ('outdoor_yard', 'space', 'Outdoors', '🌳', 'Yard, garden, courtyard or ruins — at least part of the party is outside (Nowadays yard, Knockdown Ruins).', 150),
  ('rooftop', 'space', 'Rooftop', '🏙️', 'On a roof or terrace with skyline views.', 160),
  ('boat_party', 'space', 'Boat', '⛵', 'On a boat or yacht; fixed boarding time.', 170),
  ('art_space', 'space', 'Art space', '🎨', 'Gallery, studio or arts venue rather than a licensed nightclub.', 180),
  ('park_or_pier', 'space', 'Park / pier', '🌊', 'Public park, pier or beach event, usually daytime and free or cheap.', 190),
  ('pop_up_secret_location', 'space', 'Secret location', '📍', 'Address revealed to ticket holders only, or venue TBA.', 195),
  ('sunny_day_party', 'time', 'Day party', '☀️', 'Starts in the afternoon and ends by ~22:00 (Mister Sunday, Nowadays yard sessions).', 210),
  ('day_into_night', 'time', 'Day into night', '🌇', 'Starts in daylight and runs past 02:00 — a full arc from sun to closing.', 220),
  ('afters_marathon', 'time', 'Afters / marathon', '🌅', 'Starts after 02:00, or a 10h+ session that runs past sunrise.', 230),
  ('all_nighter', 'time', 'All night', '🌙', 'A night that runs 7h+ and closes at 05:00 or later.', 240),
  ('early_finish', 'time', 'Ends early', '🕐', 'Evening event that wraps by 01:00.', 250),
  ('weekly_residency', 'time', 'Weekly', '🔁', 'A recurring weekly party or residency (promoter prior).', 260),
  ('one_off_special', 'time', 'One-off', '✨', 'Anniversary, closing, opening or otherwise once-only occasion.', 270),
  ('one_dj_all_night', 'format', 'One DJ all night', '🎧', 'A single artist plays the whole session ("all night long" / "all day").', 310),
  ('long_sets', 'format', 'Long sets', '⏳', 'Extended sets (3h+ per act) rather than a stacked bill.', 320),
  ('b2b_heavy', 'format', 'B2B', '🤝', 'Multiple back-to-back pairings on the bill.', 330),
  ('live_act', 'format', 'Live', '🎛️', 'At least one live / hybrid performance on the lineup.', 340),
  ('listening_focus', 'format', 'Listening', '🔊', 'Listening-bar or hi-fi format: seated or low-key, sound over dancing.', 350),
  ('sound_system_focus', 'format', 'Sound system', '📢', 'The room''s system is the point — audiophile or sound-system culture (Nowadays, Public Records, Good Room).', 360),
  ('festival_scale_lineup', 'format', 'Festival scale', '🎪', '7+ acts or multiple stages / rooms.', 370),
  ('performance_or_cabaret', 'format', 'Performance', '💃', 'Drag, cabaret, burlesque or performance art alongside music.', 380),
  ('queer_party', 'crowd', 'Queer', '🏳️‍🌈', 'Queer-run or queer-centred party.', 410),
  ('latinx_party', 'crowd', 'Latinx', '💃🏽', 'Latinx-centred party: reggaeton, perreo, cumbia, Latin house.', 420),
  ('black_diaspora_party', 'crowd', 'Diaspora', '🌍', 'Party rooted in Black diaspora sounds: afrobeats, amapiano, dancehall, soca, ballroom.', 430),
  ('local_crews', 'crowd', 'Local crews', '🏠', 'Resident and local-collective driven bill.', 440),
  ('international_headliner', 'crowd', 'Touring headliner', '✈️', 'A touring international headliner tops the bill.', 450),
  ('mainstream_club', 'crowd', 'Mainstream', '🍾', 'Bottle-service / commercial club or EDM-scale production.', 460),
  ('underground', 'crowd', 'Underground', '🚇', 'Underground scene: DIY promoters, non-commercial rooms, word-of-mouth.', 470),
  ('free_rsvp', 'policy', 'Free / RSVP', '🎟️', 'Free entry or RSVP list.', 510),
  ('cheap_early', 'policy', 'Cheaper early', '⏰', 'Discounted entry before a stated time.', 520),
  ('pricey', 'policy', 'Pricey', '💸', 'Top ticket above $60.', 530),
  ('phone_free', 'policy', 'Phone-free', '📵', 'No photos / camera stickers / phone pouches on the floor.', 540),
  ('dress_code', 'policy', 'Dress code', '👗', 'A stated dress code or theme.', 550),
  ('18_plus', 'policy', '18+', '🔞', 'Minimum age 18.', 560),
  ('21_plus', 'policy', '21+', '🪪', 'Minimum age 21.', 570),
  ('all_ages', 'policy', 'All ages', '👨‍👩‍👧', 'All ages admitted (at least for part of the event).', 580),
  ('sober_friendly', 'policy', 'Sober-friendly', '🫖', 'Alcohol-free or explicitly sober-friendly.', 590),
  ('sold_out_risk', 'policy', 'Selling fast', '🔥', 'Sold out, off-sale, or high interest relative to capacity.', 595)
on conflict (code) do update set kind = excluded.kind, label = excluded.label, glyph = excluded.glyph, description = excluded.description, sort = excluded.sort;

------------------------------------------------------------------------------
-- 2. Artist genre profiles (filled by the artist-profile cron; the evidence bundle reads them when present)
------------------------------------------------------------------------------
create table if not exists artist_genre_profile (
  artist_id     uuid not null references artist(artist_id) on delete cascade,
  source        text not null check (source in ('discogs','musicbrainz','wikidata','llm','manual')),
  styles        jsonb not null default '{}',   -- raw source style counts, e.g. {"Deep House": 4, "Disco": 2}
  taxonomy      jsonb not null default '{}',   -- crosswalked weights, e.g. {"house.deep": 0.45, "house.disco": 0.25}
  release_count int,
  status        text not null default 'ok' check (status in ('ok','unknown','ambiguous','error')),
  fetched_at    timestamptz not null default now(),
  expires_at    timestamptz,                   -- null = never; the cron sets now() + 90 days
  primary key (artist_id, source)
);
create index if not exists artist_genre_profile_expiry_idx on artist_genre_profile (expires_at);

------------------------------------------------------------------------------
-- 3. Classification runs (one row per attempt, including rules-only and failed calls, for cost + audit)
------------------------------------------------------------------------------
create table if not exists classification_run (
  id                    bigserial primary key,
  event_id              uuid not null references event(event_id) on delete cascade,
  model                 text,                  -- null = rules-only pass
  prompt_version        text,
  rules_version         text,
  input                 jsonb,                 -- {"bundle": "...", "rules": {...}}
  output                jsonb,                 -- parsed classifier output; null when the call failed
  input_tokens          int not null default 0,
  cache_read_tokens     int not null default 0,
  cache_creation_tokens int not null default 0,
  output_tokens         int not null default 0,
  cost_usd              numeric(8,5) not null default 0,
  error                 text,
  created_at            timestamptz not null default now()
);
create index if not exists classification_run_event_idx on classification_run (event_id, created_at desc);
create index if not exists classification_run_created_idx on classification_run (created_at desc);

------------------------------------------------------------------------------
-- 4. Tag votes (community correction loop; user_id is a plain uuid — auth wiring is the feed unit's concern)
------------------------------------------------------------------------------
create table if not exists tag_vote (
  user_id        uuid not null,
  event_id       uuid not null references event(event_id) on delete cascade,
  kind           text not null check (kind in ('genre','vibe')),
  code           text not null,
  vote           smallint not null check (vote in (-1, 1)),
  suggested_code text,                          -- "not this, that": a taxonomy / vibe code the voter proposes instead
  created_at     timestamptz not null default now(),
  primary key (user_id, event_id, kind, code)
);
create index if not exists tag_vote_event_idx on tag_vote (event_id, kind, code);

------------------------------------------------------------------------------
-- 5. Ops view: what the evidence bundle sees for an event (debugging aid; the runner uses its own query)
------------------------------------------------------------------------------
create or replace view event_enrichment_input as
select e.event_id, e.title, e.night, e.starts_at, e.ends_at, e.has_time, e.status, e.age_min, e.genres, e.lineup, e.description,
       e.source_tags, e.input_hash, e.classified_at, e.classification_version, e.primary_genre, e.genre_codes, e.vibe_codes, e.needs_review,
       v.name as venue_name, v.space_types, v.outdoor, v.phone_policy, v.capacity, v.typical_genres, v.vibe_priors, v.underground_prior,
       (select jsonb_agg(jsonb_build_object('source', l.source_key, 'labels', l.genres))
          from listing l where l.event_id = e.event_id and l.gone_at is null and cardinality(l.genres) > 0) as source_genres,
       (select array_agg(distinct p) from listing l, unnest(l.promoters) p where l.event_id = e.event_id and l.gone_at is null) as promoters,
       (select bool_or(l.sold_out) from listing l where l.event_id = e.event_id and l.gone_at is null) as sold_out,
       (select min(l.price_min) from listing l where l.event_id = e.event_id and l.gone_at is null) as price_min,
       (select max(l.price_max) from listing l where l.event_id = e.event_id and l.gone_at is null) as price_max
from event e
left join venue v on v.venue_id = e.venue_id
where e.merged_into is null;

------------------------------------------------------------------------------
-- 6. RLS: enabled everywhere; anon may read the taxonomy and nothing else. service_role bypasses RLS.
--    Supabase roles do not exist on a plain local Postgres, so grants are guarded.
------------------------------------------------------------------------------
alter table genre                enable row level security;
alter table vibe                 enable row level security;
alter table artist_genre_profile enable row level security;
alter table classification_run   enable row level security;
alter table tag_vote             enable row level security;

drop policy if exists genre_public_read on genre;
create policy genre_public_read on genre for select using (true);
drop policy if exists vibe_public_read on vibe;
create policy vibe_public_read on vibe for select using (true);

do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('grant select on genre, vibe to %I', r);
      execute format('revoke all on artist_genre_profile, classification_run, tag_vote, event_enrichment_input from %I', r);
    end if;
  end loop;
end $$;
