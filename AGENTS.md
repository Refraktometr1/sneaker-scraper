# AGENTS.md

## Project Overview
- **Project:** `sneaker-scraper` — a small Express API that scrapes sneaker products from Ochsner Sport and stores them in PostgreSQL
- **Target user:** developers
- **My skill level:** intermediate
- **Stack:** TypeScript, Node.js, Express, Puppeteer, PostgreSQL

## Commands
- **Install:** `npm install`
- **Dev:** `npm run dev`
- **Build:** `npm run build`
- **Start:** `npm run start`
- **Typecheck:** `npm run typecheck`
- **Test:** `npm test`
- **Lint:** not configured

## Project Behavior
- Server startup must wait for successful database initialization
- If database initialization fails, the API must not start listening

## Do
- Read existing code before modifying anything
- Match existing patterns, naming, and style
- Handle errors gracefully — no silent failures
- Keep changes small and scoped to what was asked
- Run dev/build after changes to verify nothing broke
- Ask clarifying questions before guessing when the code does not make the intent clear

## Don't
- Install new dependencies without asking
- Delete or overwrite files without confirming
- Hardcode secrets, API keys, or credentials
- Rewrite working code unless explicitly asked
- Push, deploy, or force-push without permission
- Make changes outside the scope of the request

## When Stuck
- If a task is large, break it into steps and confirm the plan first
- If you can't fix an error in 2 attempts, stop and explain the issue

## Testing
- Run existing tests after any change
- Add at least one test for new features
- Never skip or delete tests to make things pass

## Git
- Small, focused commits with descriptive messages
- Never force push

## Response Style
- always respond with clear and concise messages
- use plain English when explaining to the user
- avoid long sentences, complex words, or long paragraphs
