import express, { Request, Response } from 'express';
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import puppeteer from 'puppeteer';
import { Pool } from 'pg';

function loadEnvFile(): void {
    const envFilePath = path.resolve(process.cwd(), '.env');

    if (!existsSync(envFilePath)) {
        return;
    }

    const lines = readFileSync(envFilePath, 'utf8').split(/\r?\n/);

    for (const [index, line] of lines.entries()) {
        const trimmedLine = line.trim();

        if (!trimmedLine || trimmedLine.startsWith('#')) {
            continue;
        }

        const separatorIndex = trimmedLine.indexOf('=');

        if (separatorIndex === -1) {
            throw new Error(`Invalid .env line ${index + 1}. Expected KEY=VALUE.`);
        }

        const key = trimmedLine.slice(0, separatorIndex).trim();
        let value = trimmedLine.slice(separatorIndex + 1).trim();

        if (!key) {
            throw new Error(`Invalid .env line ${index + 1}. Variable name is missing.`);
        }

        if (
            (value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))
        ) {
            value = value.slice(1, -1);
        }

        if (process.env[key] === undefined) {
            process.env[key] = value;
        }
    }
}

function getStringEnv(name: string, defaultValue?: string): string {
    const rawValue = process.env[name];

    if (rawValue !== undefined) {
        const trimmedValue = rawValue.trim();

        if (trimmedValue) {
            return trimmedValue;
        }

        throw new Error(`Environment variable ${name} cannot be empty.`);
    }

    if (defaultValue !== undefined) {
        return defaultValue;
    }

    throw new Error(`Missing required environment variable: ${name}`);
}

function getNumberEnv(name: string, defaultValue: number): number {
    const rawValue = process.env[name];

    if (rawValue === undefined) {
        return defaultValue;
    }

    const trimmedValue = rawValue.trim();

    if (!trimmedValue) {
        throw new Error(`Environment variable ${name} cannot be empty.`);
    }

    const parsedValue = Number(trimmedValue);

    if (!Number.isInteger(parsedValue) || parsedValue <= 0) {
        throw new Error(
            `Environment variable ${name} must be a positive integer. Received: "${trimmedValue}"`
        );
    }

    return parsedValue;
}

function getOptionalStringEnv(name: string, defaultValue = ''): string {
    const rawValue = process.env[name];

    if (rawValue === undefined) {
        return defaultValue;
    }

    return rawValue.trim();
}

interface AppConfig {
    port: number;
    dbHost: string;
    dbPort: number;
    dbName: string;
    dbUser: string;
    dbPassword: string;
}

const config: AppConfig = (() => {
    try {
        loadEnvFile();

        return {
            port: getNumberEnv('PORT', 3000),
            dbHost: getStringEnv('DB_HOST', 'localhost'),
            dbPort: getNumberEnv('DB_PORT', 5432),
            dbName: getStringEnv('DB_NAME', 'sneaker_db'),
            dbUser: getStringEnv('DB_USER', 'postgres'),
            dbPassword: getOptionalStringEnv('DB_PASSWORD'),
        };
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown configuration error.';
        console.error(`Configuration error: ${message}`);
        process.exit(1);
    }
})();

const app = express();

interface Sneaker {
    brand: string;
    model: string;
    price: string;
    oldPrice?: string;
    url: string;
}

// 1. Initialize Postgres Connection Pool
const pool = new Pool({
    host: config.dbHost,
    database: config.dbName,
    port: config.dbPort,
    user: config.dbUser,
    password: config.dbPassword,
});

// Function to initialize the database table
async function initDB() {
    const createTableQuery = `
        CREATE TABLE IF NOT EXISTS sneakers (
                                                id SERIAL PRIMARY KEY,
                                                brand VARCHAR(255),
            model VARCHAR(255),
            price VARCHAR(50),
            scrape_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
    `;
    try {
        await pool.query(createTableQuery);
        console.log("Postgres database initialized successfully.");
    } catch (err) {
        console.error("Error creating table:", err);
    }
}

// Run the initialization
initDB();

// 2. Create the Scraping Endpoint
app.get('/scrape', async (req: Request, res: Response): Promise<void> => {
    console.log('Starting scraper. Launching browser...');

    let browser: any;

    try {
        browser = await puppeteer.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
        });

        const page = await browser.newPage();

        await page.setViewport({ width: 1366, height: 2000 });
        await page.setUserAgent(
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
        );

        page.setDefaultNavigationTimeout(60000);
        page.setDefaultTimeout(12000);

        await page.goto(
            'https://www.ochsnersport.ch/de/shop/herren-schuhe-sneakers-alle-sneakermarken-00044952-c.html',
            {
                waitUntil: 'load',
                timeout: 60000,
            }
        );

        await page.waitForSelector('section[data-id^="product-tile"]', {
            timeout: 60000,
        });

        // We only need the first 10 cards, so no scrolling is required.
        // Just make sure at least 10 tiles are rendered (fall back to whatever is available).
        await page
            .waitForFunction(
                () =>
                    document.querySelectorAll('section[data-id^="product-tile"]').length >= 10,
                { timeout: 15000 }
            )
            .catch(() => {
                console.warn('Fewer than 10 tiles found, continuing with what is available.');
            });

        const sneakers: Sneaker[] = await page.evaluate(() => {
            const toText = (el: Element | null): string =>
                (el as HTMLElement | null)?.innerText.trim() || '';

            const productNodes = Array.from(
                document.querySelectorAll('section[data-id^="product-tile"]')
            ).slice(0, 10); // take only the first 10

            const seen = new Set<string>();

            return productNodes
                .map((card) => {
                    const linkEl = card.querySelector('a[data-name="link"]') as HTMLAnchorElement | null;

                    const brand = toText(card.querySelector('[data-id="brand-name"]')) || 'Brand not found';
                    const model = toText(card.querySelector('[data-id="product-name"]')) || 'Model not found';

                    const priceEl =
                        card.querySelector('[data-id="selling-price"]') ||
                        card.querySelector('[data-id="price"]');

                    const oldPriceEl = card.querySelector('[data-id="cross-price"]');

                    return {
                        brand,
                        model,
                        price: toText(priceEl) || 'Price not found',
                        oldPrice: toText(oldPriceEl) || undefined,
                        url: linkEl?.href || '',
                    };
                })
                .filter(item => {
                    const key = `${item.brand}|${item.model}|${item.price}|${item.url}`;
                    if (seen.has(key)) return false;
                    seen.add(key);
                    return true;
                });
        });

        // 4. Save the scraped data to Postgres
        const insertQuery = 'INSERT INTO sneakers (brand, model, price) VALUES ($1, $2, $3)';

        for (const sneaker of sneakers) {
            await pool.query(insertQuery, [sneaker.brand, sneaker.model, sneaker.price]);
        }

        console.log(`Successfully scraped and saved ${sneakers.length} sneakers to Postgres!`);
        res.json({
            message: 'Success!',
            saved_count: sneakers.length,
            data: sneakers
        });

    } catch (error) {
        console.error('Scraping failed:', error);
        res.status(500).json({ error: 'Failed to scrape the website.' });
    } finally {
        if (browser) {
            await browser.close();
        }
    }
});

// Start the server
app.listen(config.port, () => {
    console.log(`Server is running at http://localhost:${config.port}`);
    console.log(`To trigger the scraper, visit http://localhost:${config.port}/scrape`);
});
