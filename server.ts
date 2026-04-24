import express, { Request, Response } from 'express';
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import puppeteer from 'puppeteer';
import { Pool, PoolClient } from 'pg';

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

interface SneakerResponse {
    brand: string;
    model: string;
    price: string;
    oldPrice?: string;
    url: string;
}

interface ScrapedSneaker extends SneakerResponse {
    productCode?: string;
}

const OCHSNER_SNEAKERS_URL =
    'https://www.ochsnersport.ch/de/shop/herren-schuhe-sneakers-alle-sneakermarken-00044952-c.html';
const MIN_SEARCH_RESULTS = 10;
const MAX_SNEAKERS_TO_SAVE = 10;

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
            product_code VARCHAR(255),
            scrape_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    `;
    const addProductCodeColumnQuery = `
        ALTER TABLE sneakers
        ADD COLUMN IF NOT EXISTS product_code VARCHAR(255);
    `;
    const deleteLegacyDuplicateRowsQuery = `
        WITH ranked_sneakers AS (
            SELECT
                id,
                ROW_NUMBER() OVER (
                    PARTITION BY brand, model, price
                    ORDER BY id
                ) AS row_number
            FROM sneakers
            WHERE product_code IS NULL
        )
        DELETE FROM sneakers
        WHERE id IN (
            SELECT id
            FROM ranked_sneakers
            WHERE row_number > 1
        );
    `;
    const createProductCodeIndexQuery = `
        CREATE UNIQUE INDEX IF NOT EXISTS sneakers_product_code_key
        ON sneakers (product_code);
    `;
    let client: PoolClient | undefined;

    try {
        client = await pool.connect();
        await client.query('BEGIN');
        await client.query(createTableQuery);
        await client.query(addProductCodeColumnQuery);

        const deleteResult = await client.query(deleteLegacyDuplicateRowsQuery);
        await client.query(createProductCodeIndexQuery);
        await client.query('COMMIT');

        const removedDuplicateCount = deleteResult.rowCount ?? 0;

        if (removedDuplicateCount > 0) {
            console.log(`Removed ${removedDuplicateCount} legacy duplicate sneaker rows.`);
        }

        console.log('Postgres database initialized successfully.');
    } catch (err) {
        if (client) {
            await client.query('ROLLBACK').catch((rollbackError) => {
                console.error('Error rolling back database initialization:', rollbackError);
            });
        }
        console.error('Error initializing database:', err);
    } finally {
        client?.release();
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

        await page.goto(OCHSNER_SNEAKERS_URL, {
            waitUntil: 'networkidle2',
            timeout: 60000,
        });

        console.log('Waiting for Nuxt search data to be available...');
        await page
            .waitForFunction(
                (minimumSearchResults: number) => {
                    const state = (window as Window & { $nuxt?: any }).$nuxt?.$store?.state;
                    const searchResults = state?.search?.results?.[1];
                    const searchPageProducts = state?.products?.products?.searchPage;

                    return (
                        Array.isArray(searchResults) &&
                        searchResults.length >= minimumSearchResults &&
                        typeof searchPageProducts === 'object' &&
                        searchPageProducts !== null &&
                        Object.keys(searchPageProducts).length > 0
                    );
                },
                { timeout: 15000 },
                MIN_SEARCH_RESULTS
            )
            .catch(() => {
                console.warn(
                    `Timed out waiting for ${MIN_SEARCH_RESULTS} search results in Nuxt state. Continuing with what is available.`
                );
            });

        const sneakers: ScrapedSneaker[] = await page.evaluate((maxSneakers: number) => {
            const state = (window as Window & { $nuxt?: any }).$nuxt?.$store?.state;
            const searchResults = state?.search?.results?.[1] ?? [];
            const searchPageProducts = state?.products?.products?.searchPage ?? {};
            const seen = new Set<string>();

            return searchResults
                .slice(0, maxSneakers)
                .map((result: { productCode?: string }) => {
                    const product = result.productCode ? searchPageProducts[result.productCode] : null;

                    if (!product) {
                        return null;
                    }

                    return {
                        productCode: result.productCode,
                        brand: product.brand?.name || 'Brand not found',
                        model: product.name || 'Model not found',
                        price: product.price?.selling?.formattedValue || 'Price not found',
                        oldPrice: product.price?.cross?.formattedValue || undefined,
                        url: product.url
                            ? new URL(product.url, window.location.origin).href
                            : '',
                    };
                })
                .filter((item: ScrapedSneaker | null): item is ScrapedSneaker => item !== null)
                .filter((item: ScrapedSneaker) => {
                    const key =
                        item.productCode || `${item.brand}|${item.model}|${item.price}|${item.url}`;

                    if (seen.has(key)) {
                        return false;
                    }

                    seen.add(key);
                    return true;
                });
        }, MAX_SNEAKERS_TO_SAVE);

        const responseData: SneakerResponse[] = sneakers.map(
            ({ productCode: _productCode, ...responseSneaker }) => responseSneaker
        );

        // 4. Save the scraped data to Postgres
        const insertQuery = `
            INSERT INTO sneakers (brand, model, price, product_code)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (product_code) DO NOTHING
        `;
        let savedCount = 0;

        for (const sneaker of sneakers) {
            if (!sneaker.productCode) {
                console.warn(
                    `Skipping sneaker without productCode: ${sneaker.brand} ${sneaker.model}`
                );
                continue;
            }

            const insertResult = await pool.query(insertQuery, [
                sneaker.brand,
                sneaker.model,
                sneaker.price,
                sneaker.productCode,
            ]);

            savedCount += insertResult.rowCount ?? 0;
        }

        console.log(`Successfully scraped and saved ${savedCount} sneakers to Postgres!`);
        res.json({
            message: 'Success!',
            saved_count: savedCount,
            data: responseData
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
