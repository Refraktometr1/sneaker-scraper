# sneaker-scraper

Small TypeScript API that scrapes sneaker products from Ochsner Sport and saves them to PostgreSQL.

## What it does

- Starts an Express server on port `3000`
- Opens the Ochsner Sport sneaker listing page with Puppeteer
- Reads the first 10 product tiles
- Extracts `brand`, `model`, `price`, `oldPrice`, and `url`
- Saves `brand`, `model`, and `price` into a local PostgreSQL table
- Returns the scraped items as JSON from `GET /scrape`

## Requirements

- Node.js and npm
- PostgreSQL running locally on port `5432`
- A database named `sneaker_db`

The app currently connects with:

- host: `localhost`
- port: `5432`
- database: `sneaker_db`

## Install

```bash
npm install
```

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
