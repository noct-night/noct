# NOCT

A nightlife and electronic music listings prototype for New York. One feed across every ticketing
platform, so you stop checking RA, Dice and venue Instagrams separately.

**NOCT is a working name.** Nothing is attached to it yet.

## Run it

It's a single static HTML file with no build step and no dependencies.

```
open index.html
```

Or serve it locally if you prefer:

```
python3 -m http.server 8000
# then open http://localhost:8000
```

Designed mobile first, 440px wide. On a desktop browser it centres itself so you can preview it,
but judge it in a phone-sized window or on your phone.

## What's here

**Image view** is the default. Swipe or use the arrow keys to move through the night one event at
a time. Minimal text, meant for deciding whether you want to be somewhere.

**List view** is the utility view. Time, name, genre, venue, price, platform, going count.

**Location and date** live in the header and are the first thing you touch. The date control has
presets and a calendar. Location filters by borough.

**Event page** leads with tickets, showing every platform selling that event side by side with the
price gap called out. Then details, running order, and a guest list.

**Venue page** has a Google Maps link, Instagram, RA venue page, photos, an Instagram grid, and
everything on there this weekend.

**Profile and going.** Sign in with an Instagram handle, mark yourself going, see who else is.
Visibility is reciprocal: you see the people who chose to be visible to you, and nothing more.
The default is Count only, which means you add to a number and nobody sees your handle.

## What's real and what isn't

**Real.** All eleven events are live listings for Fri 28 to Sun 30 August 2026, pulled from
Resident Advisor with working ra.co links. Genres, door times, prices, sold-out status, ages and
set times come from RA event pages, Dice, Eventbrite and venue calendars. Nowadays and BASEMENT
have confirmed addresses.

**Derived, and labelled as such in the app.** Some genres are assembled from per-artist tags or
venue press rather than tagged by RA. The event page shows where each genre came from.

**Placeholder.** Every image is a CSS texture standing in for photography. Going counts and guest
lists are simulated. Neighbourhoods for Signal, H0L0, MoMA PS1, Knockdown Center and Good Room are
from general knowledge, not verified. Venue Instagram links are searches, not handles, except
Nowadays.

## Known issues

- No persistence. Sign-in, saved and going all reset on reload.
- Hover-to-preview has no touch equivalent.
- The going count reads 0 for every event in a real build. Cold start is unsolved.
- Only covers one weekend and one city.

## Open decisions

**Where the data comes from at scale.** RA served a clean page. Dice blocked automated access with
bot detection. Both restrict this in their terms. The realistic options are a licensed feed, an
affiliate arrangement where they want the traffic, or going venue-direct and pulling calendars from
the rooms that matter. The last is slowest and the only one nobody can switch off. Needs a lawyer.

**Guest list default.** Currently Count only. A public list of who is at which club at which hour,
tied to real Instagram handles, has real safety implications. Mutual-only may be the right default
instead. Worth arguing about before launch.

**What "going" means.** Right now it's an intent signal, not a ticket. Venues will eventually ask
what the number represents.

**Image sourcing.** This direction lives or dies on one strong image per event. Promoter flyers are
inconsistent. Options are a house photography style, a fixed duotone treatment over whatever comes
in, or shooting venues rather than events and reusing the venue image.

## Feedback

Open an issue, or leave comments on the relevant line.
