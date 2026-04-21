# sneaker-scraper

Small TypeScript API that scrapes sneaker products from Ochsner Sport and saves them to PostgreSQL.

## What it does

- Starts an Express server on port `3000`
- Opens the Ochsner Sport sneaker listing page with Puppeteer
- Reads the first 10 product tiles
- Extracts `brand`, `model`, `price`, `oldPrice`, and `url`
- Saves `brand`, `model`, and `price` into a PostgreSQL table
- Returns the scraped items as JSON from `GET /scrape`

## Requirements

- Node.js and npm
- PostgreSQL

## Install

```bash
npm install
```

## Environment variables

1. Copy the example file:

```bash
cp .env.example .env
```

2. Edit `.env` with your local PostgreSQL values.

The app loads `.env` automatically on startup. If `PORT` or `DB_PORT` is invalid, or if a required value is blank, the server exits with a clear configuration error.

Default local values used when a variable is not set:

- `PORT=3000`
- `DB_HOST=localhost`
- `DB_PORT=5432`
- `DB_NAME=sneaker_db`
- `DB_USER=postgres`
- `DB_PASSWORD=` (blank is allowed for local setups that do not use a password)

## Scripts

```bash
npm run dev
npm run build
npm run start
npm run typecheck
npm test
```

## Run in development

```bash
npm run dev
```

Example with `.env`:

```bash
cp .env.example .env
npm run dev
```

The server starts at:

```text
http://localhost:3000
```

Trigger the scraper at:

```text
http://localhost:3000/scrape
```

## Build and run

```bash
npm run build
npm run start
```

Example with explicit overrides:

```bash
PORT=4000 DB_NAME=sneaker_db npm run dev
PORT=4000 DB_NAME=sneaker_db npm run start
```

## API response

Successful requests return JSON with:

- `message`
- `saved_count`
- `data`

## Database

On startup, the app creates this table if it does not exist:

- `sneakers`

Stored columns:

- `id`
- `brand`
- `model`
- `price`
- `scrape_date`

## Notes

- The scraper is hardcoded to Ochsner Sport.
- Repeated `/scrape` calls can insert duplicate rows.
- `oldPrice` and `url` are returned in the API response but are not stored in the database.
