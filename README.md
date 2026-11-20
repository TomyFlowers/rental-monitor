# Rental monitor

Checks rental listings on Imovirtual and Casa Sapo every hour, reads Idealista
and OLX alert emails, scores each one
against your criteria, and sends the good ones to a private Telegram bot.

- **Great matches** (score 75+) arrive at once, with up to 4 photos and
  ⭐ Favorite / 🚫 Ignore / 🔗 Open buttons.
- **Decent matches** (40-74) arrive in a digest at 19:00, together with price
  changes, removals and the current top picks.
- **Quiet hours** 23:00-08:00: checks continue, messages wait until 08:00.
- Price drops, listings that start matching after a change, and listings that
  go offline are all reported.
- If a site starts failing or changes its layout, the bot tells you.

Everything above is a setting in `config/config.yaml`.

## Setup

### 1. Create the bot

1. In Telegram, open **@BotFather**, send `/newbot`, follow the prompts, and
   copy the token it gives you.
2. Open **@userinfobot** and note your numeric user ID. Anyone else who should
   get alerts does the same.
3. Each person opens the new bot and presses **Start** (a bot cannot message
   someone who has not done this).

### 2. Configure

```bash
cp .env.example .env      # then edit .env: paste the token and the user IDs
```

`.env` is git-ignored. Keep the token out of chat and out of `config.yaml`.

Review `config/config.yaml`: the search URLs, rent caps and weights are
already set to what we agreed.

### 3. Run on the NAS

Copy this folder to the NAS, then over SSH (or as a Compose project in the
NAS Docker app):

```bash
docker compose up -d --build
docker compose logs -f          # watch the first check
```

The image is plain Node 22 with no native modules, so it builds the same on
the DH4300 Plus (ARM64) as on a PC. If the container cannot write to `data/`
or `logs/`, set `PUID`/`PGID` in `.env` to the owner of those folders.

To run without Docker: `pnpm install && pnpm build && pnpm start` (Node 22+).

### 4. Check the adapters against the live sites

Do this once, before trusting the alerts:

```bash
docker compose run --rm rental-monitor node dist/cli/probe.js imovirtual
docker compose run --rm rental-monitor node dist/cli/probe.js olx
```

Each prints the listings it read from the first results page, with the price,
typology, municipality and score. You want to see `mode: structured` and a
table that matches what the site shows. `mode: html` means the site's embedded
data was not found and the less detailed fallback was used. Add `--save` to
keep the raw page in `data/probe/`, or pass a listing URL to test one page.

Then send `/check` to the bot. The first check seeds the database (it reads
more pages than usual and sends no instant alerts); the best of what it finds
shows up in `/top` and in the 19:00 digest.

## Bot commands

| Command | What it does |
|---|---|
| `/status` | Running or paused, counts, last result per site, next check |
| `/rate` | Shows the best match you have not rated yet with ⭐ Favorite / 🚫 Ignore / ⏭ Skip; each press brings the next one. Skipped ones return on the next `/rate` |
| `/top` | Ten best current matches |
| `/favorites` | Listings you starred, as one list |
| `/contacted` | Favourites you have contacted, longest-waiting first, with the latest note |
| `/ignored` | Listings you ignored |
| `/show_12` | Every line in a list, `/top` and the digest ends with a tappable `/show_<number>`. It opens that listing as a card with its buttons, which is where you change it |
| `/note 12 text` | Adds a note to listing 12. Replying to a listing card with plain text does the same |
| `/add <link> [notes]` | Scores a listing you found yourself. Imovirtual and OLX links are read from the site. For anything else (Facebook), type the facts after the link: `/add https://facebook.com/... T2 900€ Gaia mobilado com garagem` |
| *(a message with a link)* | Same as `/add`. The link can be anywhere in the message, and the text around it is read for details (see below) |
| `/check` | Check all sites now |
| `/pause`, `/resume` | Stop and restart checks and messages |

### Tracking contacts

A favourite's card has a **📞 Contacted** button. After that it offers
**📅 Visit booked**, then **👀 Visited** (seen it, not decided yet), with
**🚫 Closed** available at every step (closed moves it to ignored, e.g. when
the flat turns out to be rented). Each step can be undone from the same card,
and `/favorites` groups listings by how far along they are.
Contacted listings keep reporting price changes and removals, and the 19:00
digest lists any that have had no update (stage change or note) for
`notifications.contactNudgeDays` days (3 by default, 0 turns it off).

Favourites, ignores, stages and notes are shared by everyone on the allow list. An ignored
listing never produces another message.

## Sources

| Site | How | Notes |
|---|---|---|
| Imovirtual | Reads the results pages and listing pages | |
| Casa Sapo | Reads the results pages | Facts come from the result card (price, typology, area, location, description excerpt) |
| Idealista | Alert emails, and links you send | Refuses automated requests, so it is never contacted. Links you send are filed under their Idealista number, with details read from the text sent with them |
| OLX | Alert emails | Refuses automated requests |
| Facebook | By hand | Paste the post link plus the facts into the bot |

### Adding listings by hand (Idealista, Facebook)

Send the link to the bot together with the listing's text. Any of these work:

- **Copy from the page**: select the title, location, price and the features
  list, copy, and paste it into the chat along with the link.
- **Share button**: share the listing from the site's app to Telegram. The
  link can be anywhere in the message.
- **Type it**: `T2 950€ Mafamude, Vila Nova de Gaia mobilado com garagem`.
- **A screenshot** with the link as its caption becomes the listing's photo.

Sending the same link again adds to what is known (new price, more
features) instead of creating a second entry, so a bare link can be filled in
later. The card's ⚠️ line shows what is still missing.

Listings added by hand cannot be checked for price changes or removal.

### Setting up alert emails (Idealista, OLX)

1. Create a mailbox used only for this (a new Gmail works). For Gmail, turn
   on 2-step verification and create an **app password**.
2. On each site, register with that address, run your search, save it, and
   turn on email alerts for new listings (choose the most frequent option).
3. In `.env`, set `EMAIL_USER` and `EMAIL_PASSWORD`. In `config.yaml`, set
   `email.enabled: true`.
4. Once an alert has arrived, check what the monitor makes of it:

   ```bash
   sudo docker compose run --rm rental-monitor node dist/cli/probe.js email
   ```

   It lists each unread message, how many links it holds and which listings
   were recognised, and leaves the messages unread. Add `--save` to keep the
   raw emails in `data/probe/`.

Listings from email carry only what the email says (usually title, price and
a photo), so more of their values are flagged unknown. They cannot be checked
for removal. Mail from senders not listed in `email.senders` is never opened
or marked read.

## How listings are judged

**Hard requirements** reject a listing: municipality (Porto, Vila Nova de
Gaia), typology (T1-T3), rent cap per typology (T1 1000, T2 1150, T3 1300),
short-term rentals, rooms/shared flats.

**Unknown values** never reject by themselves. If a listing does not state its
price, typology or municipality it is kept and the alert carries a ⚠️ line.
Set `criteria.unknown.<field>: exclude` to change that per field.

**Score (0-100)** is the weighted sum of soft preferences:

| Preference | Weight | Full marks | Zero |
|---|---|---|---|
| Drive to ULS Gaia/Espinho | 25 | 30 min or less | 50 min |
| Rent | 20 | €1,000 or less | €1,300 |
| Contract / registration | 15 | stated as available | stated as refused |
| Typology | 10 | T2 | (T1, T3 get half) |
| Furnished | 10 | yes | no (partial gets half) |
| Garage | 8 | yes | no |
| Outdoor space | 7 | yes | no |
| Move-in date | 5 | 15 Dec - 15 Feb | 60 days outside |

A preference the listing says nothing about earns half its weight and is
listed on the ⚠️ line. Rejected listings are still scored and are announced
if a later change (such as a price drop) makes them qualify.

Driving time comes from OSRM (free-flow time x 1.3 for traffic). When a
listing has no coordinates, its parish is geocoded and the alert says the time
is "from area centre". Public transport time is not included.

## Operations

- **Logs**: `logs/rental-monitor.<date>.log`, one file per day, 14 kept.
- **Database**: `data/rental-monitor.sqlite`. Copy the `data/` folder to back
  up. Delete it to start from scratch.
- **Changing settings**: edit `config/config.yaml`, then
  `docker compose restart`. A mistake stops the container with a message
  naming the bad field (`docker compose logs`).
- **Updating the code**: `docker compose up -d --build`.
- **Refusals and rate limits**: when a site answers 403 or 429 it is not
  retried. It is rested for 2 hours, doubling on each repeat up to 12 (or
  longer if the site names a wait), you get one message, and `/status` shows
  when it will be tried again. Each container start runs a check right away,
  so avoid restarting repeatedly.
- **Requests made**: per site, 1-3 results pages per search per hour plus up
  to 40 listing pages, one request at a time with 2.5-6 s between them.
  `http.robotsTxt` is `warn` (logs if a path is disallowed); set `enforce` to
  skip such paths.

## Adding a website

1. Create `src/sources/<site>/` with a class implementing `SourceAdapter`
   (`src/sources/types.ts`): `search`, `details`, `matches`, `stub`.
2. Add it to `src/sources/registry.ts`.
3. Add a block under `sources:` in `config.yaml` with its search URLs.

Scoring, storage, change detection and notifications need no changes.

## Development

```bash
pnpm install
pnpm test          # 126 tests: text extraction, scoring, parsers, bot, full pipeline
pnpm typecheck
pnpm dev           # run from source (needs .env)
```

## Not in this version

- SUPERCASA adapter.
- Automated Facebook Marketplace/groups monitoring (paste links instead).
- Public-transport commute time.
- Merging the same flat posted separately on two sites. (OLX ads that link
  to Imovirtual are already merged.)
