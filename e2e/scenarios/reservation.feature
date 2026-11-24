Feature: Campus Resource Reservation Engine
  As a student
  I want to reserve campus resources for a specific time window
  So that I can use a room, equipment, or lab without double-booking

  Background:
    Given the CampusHub database contains the seeded campus resources
    And a student is on the CampusHub home page

  # --- Required flows ---------------------------------------------------------

  Scenario: Student successfully reserves an available study room
    When they filter resources by type "Room"
    And they select "Study Room 302"
    And they submit a reservation for tomorrow from "10:00 AM" to "11:00 AM"
    Then they should see a success message "Booked Study Room 302" with status "Pending"
    And the reservation should appear in their "My Bookings" list

  Scenario: Student receives conflict alert on double-booking
    Given a resource "3D Printer A" is already reserved by another student tomorrow from "2:00 PM" to "3:00 PM"
    When they select "3D Printer A"
    And they submit a reservation for tomorrow from "2:00 PM" to "3:00 PM"
    Then the system should display a conflict alert "This resource is already reserved for the selected time window."
    And the reservation request should not be created

  # --- Additional coverage ----------------------------------------------------

  Scenario: Student cannot submit an incomplete or inverted time window
    When they select "Computer Lab A"
    And they submit the booking form without entering any times
    Then they should see the validation error "Enter a valid start date and time."
    And they should see the validation error "Enter a valid end date and time."
    When they submit a reservation for tomorrow from "11:00 AM" to "10:00 AM"
    Then they should see the validation error "End time must be after the start time."
    And the reservation request should not be created

  Scenario: Student cancels an existing reservation
    Given they have reserved "Study Room 101" in three days from "9:00 AM" to "10:00 AM"
    When they cancel the reservation for "Study Room 101"
    Then they should see the notice "Cancelled your reservation for Study Room 101"
    And the reservation should no longer appear in their "My Bookings" list
