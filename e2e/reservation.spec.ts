/**
 * CampusHub end-to-end tests (Lab 9).
 *
 * Implements e2e/scenarios/reservation.feature. Each `test.step` is named
 * after the Gherkin step it automates, so reports read like the scenarios.
 *
 * Locators are user-facing (roles, labels, visible text) rather than CSS or
 * XPath, so they keep working when styling or markup changes.
 */
import { expect, test } from "@playwright/test";
import type { APIRequestContext, Locator, Page } from "@playwright/test";

import type {
  CreateReservationRequest,
  Reservation,
  Resource,
} from "../shared/api.js";

const API_PATH = "/api/v1";
/** Test-only endpoint from e2e/support/start-backend.ts. */
const RESET_URL = "http://127.0.0.1:3100/reset";

const CURRENT_STUDENT = "student-001";
const OTHER_STUDENT = "student-002";

const CONFLICT_MESSAGE =
  "This resource is already reserved for the selected time window.";

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

interface TimeSlot {
  start: Date;
  end: Date;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** Format a Date as the `YYYY-MM-DDTHH:mm` value of a datetime-local input. */
function toDateTimeLocal(date: Date): string {
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

/** A slot `daysAhead` days from now, starting on the hour, in local time. */
function slot(daysAhead: number, startHour: number, durationHours = 1): TimeSlot {
  const start = new Date();
  start.setDate(start.getDate() + daysAhead);
  start.setHours(startHour, 0, 0, 0);
  const end = new Date(start);
  end.setHours(startHour + durationHours);
  return { start, end };
}

// ---------------------------------------------------------------------------
// API helpers (test setup and verification only; the journeys use the UI)
// ---------------------------------------------------------------------------

async function findResourceId(
  request: APIRequestContext,
  name: string,
): Promise<string> {
  const response = await request.get(`${API_PATH}/resources`);
  expect(response.ok()).toBeTruthy();
  const resources = (await response.json()) as Resource[];
  const resource = resources.find((r: Resource): boolean => r.name === name);
  if (resource === undefined) {
    throw new Error(`Seeded resource not found: ${name}`);
  }
  return resource.id;
}

async function reserveViaApi(
  request: APIRequestContext,
  resourceName: string,
  userId: string,
  { start, end }: TimeSlot,
): Promise<void> {
  const payload: CreateReservationRequest = {
    resourceId: await findResourceId(request, resourceName),
    userId,
    startTime: start.toISOString(),
    endTime: end.toISOString(),
  };
  const response = await request.post(`${API_PATH}/reservations`, {
    data: payload,
  });
  expect(response.ok()).toBeTruthy();
}

async function reservationsFor(
  request: APIRequestContext,
  userId: string,
): Promise<Reservation[]> {
  const response = await request.get(`${API_PATH}/reservations/user/${userId}`);
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as Reservation[];
}

// ---------------------------------------------------------------------------
// Page helpers (one per reusable Gherkin step)
// ---------------------------------------------------------------------------

function resourceCard(page: Page, name: string): Locator {
  return page.getByRole("article", { name });
}

function myBookings(page: Page): Locator {
  return page.getByRole("region", { name: "My Bookings" });
}

function bookingFor(page: Page, resourceName: string): Locator {
  return myBookings(page)
    .getByRole("listitem")
    .filter({ has: page.getByRole("heading", { name: resourceName }) });
}

async function openHomePage(page: Page): Promise<void> {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { level: 1, name: "CampusHub" }),
  ).toBeVisible();
  // Wait for the directory to finish loading before interacting with it.
  await expect(resourceCard(page, "Study Room 302")).toBeVisible();
}

async function filterByType(page: Page, label: string): Promise<void> {
  const filter = page.getByRole("group", { name: "Filter by type" });
  await filter.getByRole("button", { name: label, exact: true }).click();
  await expect(
    filter.getByRole("button", { name: label, exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
}

async function selectResource(page: Page, name: string): Promise<void> {
  const card = resourceCard(page, name);
  await card.getByRole("button", { name: "Select for booking" }).click();
  await expect(card.getByRole("button", { name: "Selected" })).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Book a resource" }),
  ).toContainText(name);
}

async function fillTimeWindow(
  page: Page,
  { start, end }: TimeSlot,
): Promise<void> {
  await page.getByLabel("Start time").fill(toDateTimeLocal(start));
  await page.getByLabel("End time").fill(toDateTimeLocal(end));
}

async function submitBooking(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Book resource" }).click();
}

async function submitReservation(page: Page, window: TimeSlot): Promise<void> {
  await fillTimeWindow(page, window);
  await submitBooking(page);
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

test.describe("Feature: Campus Resource Reservation Engine", () => {
  test.beforeEach(async ({ request, page }) => {
    // Background: the database contains the seeded campus resources.
    const reset = await request.post(RESET_URL);
    expect(reset.status()).toBe(204);

    // Background: a student is on the CampusHub home page.
    await openHomePage(page);
  });

  test("Scenario: Student successfully reserves an available study room", async ({
    page,
  }) => {
    const window = slot(1, 10);

    await test.step('When they filter resources by type "Room"', async () => {
      await expect(resourceCard(page, "Projector 201")).toBeVisible();
      await filterByType(page, "Room");
      await expect(resourceCard(page, "Projector 201")).toBeHidden();
      await expect(resourceCard(page, "Study Room 302")).toBeVisible();
    });

    await test.step('And they select "Study Room 302"', async () => {
      await selectResource(page, "Study Room 302");
    });

    await test.step("And they submit a reservation for tomorrow at 10:00 AM", async () => {
      await submitReservation(page, window);
    });

    await test.step('Then they should see a "Booked Study Room 302" success message', async () => {
      const success = page
        .getByRole("status")
        .filter({ hasText: "Booked Study Room 302" });
      await expect(success).toBeVisible();
      await expect(success).toContainText("Status: Pending");
    });

    await test.step('And the reservation should appear in their "My Bookings" list', async () => {
      const booking = bookingFor(page, "Study Room 302");
      await expect(booking).toHaveCount(1);
      await expect(booking).toContainText("Pending");
    });
  });

  test("Scenario: Student receives conflict alert on double-booking", async ({
    page,
    request,
  }) => {
    const window = slot(1, 14);

    await test.step('Given "3D Printer A" is already reserved by another student tomorrow at 2:00 PM', async () => {
      await reserveViaApi(request, "3D Printer A", OTHER_STUDENT, window);
    });

    await test.step('When they select "3D Printer A"', async () => {
      await selectResource(page, "3D Printer A");
    });

    await test.step("And they submit a reservation for tomorrow at 2:00 PM", async () => {
      await submitReservation(page, window);
    });

    await test.step("Then the system should display a conflict alert", async () => {
      await expect(page.getByRole("alert")).toHaveText(CONFLICT_MESSAGE);
    });

    await test.step("And the reservation request should not be created", async () => {
      await expect(
        myBookings(page).getByText("You have no active bookings"),
      ).toBeVisible();
      await expect(bookingFor(page, "3D Printer A")).toHaveCount(0);
      expect(await reservationsFor(request, CURRENT_STUDENT)).toHaveLength(0);
    });
  });

  test("Scenario: Student cannot submit an incomplete or inverted time window", async ({
    page,
    request,
  }) => {
    await test.step('When they select "Computer Lab A"', async () => {
      await selectResource(page, "Computer Lab A");
    });

    await test.step("And they submit the booking form without entering any times", async () => {
      await submitBooking(page);
    });

    await test.step("Then they should see the missing start and end errors", async () => {
      await expect(
        page.getByText("Enter a valid start date and time."),
      ).toBeVisible();
      await expect(
        page.getByText("Enter a valid end date and time."),
      ).toBeVisible();
    });

    await test.step('When they submit a reservation for tomorrow from 11:00 AM to 10:00 AM', async () => {
      const tenAm = slot(1, 10);
      const elevenAm = slot(1, 11);
      await submitReservation(page, { start: elevenAm.start, end: tenAm.start });
    });

    await test.step("Then they should see the inverted-window error", async () => {
      await expect(
        page.getByText("End time must be after the start time."),
      ).toBeVisible();
    });

    await test.step("And the reservation request should not be created", async () => {
      expect(await reservationsFor(request, CURRENT_STUDENT)).toHaveLength(0);
    });
  });

  test("Scenario: Student cancels an existing reservation", async ({
    page,
  }) => {
    await test.step('Given they have reserved "Study Room 101" in three days at 9:00 AM', async () => {
      await selectResource(page, "Study Room 101");
      await submitReservation(page, slot(3, 9));
      await expect(bookingFor(page, "Study Room 101")).toHaveCount(1);
    });

    await test.step('When they cancel the reservation for "Study Room 101"', async () => {
      await page
        .getByRole("button", {
          name: /^Cancel reservation for Study Room 101/,
        })
        .click();
    });

    await test.step('Then they should see the notice "Cancelled your reservation for Study Room 101"', async () => {
      await expect(
        page
          .getByRole("status")
          .filter({ hasText: "Cancelled your reservation for Study Room 101" }),
      ).toBeVisible();
    });

    await test.step('And the reservation should no longer appear in their "My Bookings" list', async () => {
      await expect(bookingFor(page, "Study Room 101")).toHaveCount(0);
      await expect(
        myBookings(page).getByText("You have no active bookings"),
      ).toBeVisible();
    });
  });
});
