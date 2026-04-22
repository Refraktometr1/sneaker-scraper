# sneaker-scraper

Small TypeScript API that scrapes sneaker products from Ochsner Sport and saves them to PostgreSQL.

## Overview

This project:

- starts an Express server on port `3000`
- opens the Ochsner Sport sneaker listing page with Puppeteer
- reads the first 10 product results
- extracts `brand`, `model`, `price`, `oldPrice`, and `url`
- saves `brand`, `model`, and `price` into PostgreSQL
- returns the scraped items as JSON from `GET /scrape`

## Tech stack

- TypeScript
- Node.js
- Express
- Puppeteer
- PostgreSQL

## Requirements

- Node.js
- npm
- PostgreSQL

## Install

```bash
npm install
```

## Environment variables

Copy the example file and adjust it for your local database:

```bash
cp .env.example .env
```

The app loads `.env` automatically on startup. If `PORT` or `DB_PORT` is invalid, or if a required value is blank, the server exits with a clear configuration error.

Default local values used when a variable is not set:

- `PORT=3000`
- `DB_HOST=localhost`
- `DB_PORT=5432`
- `DB_NAME=sneaker_db`
- `DB_USER=postgres`
- `DB_PASSWORD=` (blank is allowed for local setups that do not use a password)

### Required runtime values

The app expects these environment variables at runtime:

- `PORT`
- `DB_HOST`
- `DB_PORT`
- `DB_NAME`
- `DB_USER`
- `DB_PASSWORD`

### GitHub and future deploy secrets

This repository does not deploy automatically yet. When CD is added later, keep runtime values in the hosting platform secret store and mirror only deployment-related secrets in GitHub when needed.

Expected future secret groups:

- application runtime values for the deploy target
- deployment credentials or platform API tokens
- optional GitHub environment secrets for `staging` and `production`

Do not commit `.env` or any real credentials.

## Scripts

```bash
npm run dev
npm run build
npm run start
npm run typecheck
npm test
```

`npm test` currently runs `npm run typecheck`.

## Local development

Start the app in development mode:

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

Example with explicit overrides:

```bash
PORT=4000 DB_NAME=sneaker_db npm run dev
```

## Build and run

```bash
npm run build
npm run start
```

## CI

GitHub Actions CI should run on pushes and pull requests for `main` and `develop`.

Current CI checks:

- `npm ci`
- `npm run typecheck`
- `npm run build`

## Branch strategy

This repo is set up for:

- `develop` as the main integration branch
- `main` as the release branch
- feature branches created from `develop`
- releases promoted with pull requests from `develop` to `main`

## API response

Successful requests return JSON with:

- `message`
- `saved_count`
- `data`

## Database

On startup, the app creates the `sneakers` table if it does not exist.

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
