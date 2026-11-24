# Lab 9: BDD and E2E test automation

End-to-end tests for CampusHub using Gherkin acceptance criteria and Playwright.

## Files

| Path                              | Purpose                                                                  |
| --------------------------------- | ------------------------------------------------------------------------ |
| `e2e/scenarios/reservation.feature` | Gherkin acceptance criteria (booking, conflict, validation, cancel)    |
| `e2e/reservation.spec.ts`         | Playwright specs; each `test.step` is named after its Gherkin step       |
| `e2e/support/start-backend.ts`    | Starts the built API on an in-memory MongoDB with seeded resources       |
| `playwright.config.ts`            | Base URL, three browsers, and `webServer` entries for API and Vite       |

## How it works

- `webServer` runs `npm run build && node e2e/support/start-backend.ts` (API on :3000) and `npm run dev --prefix client` (Vite on :5173), so one command boots the whole stack.
- The API uses `mongodb-memory-server`, so tests never touch a real database. The launcher also exposes a test-only `POST http://127.0.0.1:3100/reset` that wipes reservations and re-seeds resources; every test calls it first, so tests are independent.
- Locators are user-facing (`getByRole`, `getByLabel`, `getByText`). The app's existing ARIA structure (labelled sections, `article` cards named by heading, `role="alert"` errors, `role="status"` notices) was enough; no markup changes were needed.
- Tests run serially (`workers: 1`) because they share one database.

## Running

```powershell
npm install -D @playwright/test
npx playwright install
npm run e2e              # all browsers, headless
npx playwright test --project=chromium
npm run e2e:ui           # UI mode
npm run e2e:typecheck
```

Stop any locally running backend on port 3000 first; the E2E backend must own that port.
