# Rental monitor

Checks rental listings on Imovirtual and OLX every hour, scores each one
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
already set to what we agreed. **Please confirm the hospital coordinates**
under `commute.destination` on a map; they are approximate.

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
| `/top` | Ten best current matches |
| `/favorites` | Listings you starred |
| `/add <link> [notes]` | Scores a listing you found yourself. Imovirtual and OLX links are read from the site. For anything else (Facebook), type the facts after the link: `/add https://facebook.com/... T2 900€ Gaia mobilado com garagem` |
| `/check` | Check all sites now |
| `/pause`, `/resume` | Stop and restart checks and messages |

Favourites and ignores are shared by everyone on the allow list. An ignored
listing never produces another message.

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
pnpm test          # 89 tests: text extraction, scoring, parsers, full pipeline
pnpm typecheck
pnpm dev           # run from source (needs .env)
```

## Not in this version

- Idealista, Casa Sapo, SUPERCASA adapters.
- Facebook Marketplace/groups monitoring (use `/add`).
- Public-transport commute time.
- Merging the same flat posted separately on two sites. (OLX ads that link
  to Imovirtual are already merged.)
