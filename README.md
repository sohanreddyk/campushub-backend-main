# CampusHub: A Campus Resource Reservation System

CS 5500 Semester Project

## Abstract

CampusHub is a web-based system for reserving shared campus resources, such as study rooms, equipment, and laboratories. It comprises a RESTful backend implemented with Express 5 and Mongoose 9, and a single-page frontend implemented with React 19 and Vite. Both components are written in TypeScript and share a common set of API type declarations, so that the contract between client and server is checked statically. The system enforces temporal conflict detection on reservations and exposes a documented HTTP interface specified in OpenAPI. This document describes the repository organization, the environment required to reproduce the system, the API specification, and the verification procedures used to evaluate it.

Project conventions for contributors, including AI coding assistants, are documented in `CLAUDE.md`.

## 1. System Overview

### 1.1 Repository Organization

| Path      | Component | Description                                                                                                                                                              |
| --------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/`    | Backend   | Express 5 and Mongoose 9 (TypeScript), served on port 3000. Domain errors are defined in `services/errors.ts` and handled centrally in `middleware/errorHandler.ts`.    |
| `client/` | Frontend  | React 19, TypeScript, and Vite, served on port 5173. Data access and form logic reside in `src/hooks/` (`useResources`, `useCreateReservation`, `useUserReservations`, `useBookingForm`). |
| `shared/` | Contract  | API types used by both backend and client (`api.d.ts`; declarations only).                                                                                              |
| `docs/`   | Records   | The OpenAPI contract (`openapi.yaml`) together with steering, verification, and refactoring records.                                                                     |

### 1.2 Client-Server Communication

The client issues requests to the relative path `/api/v1/...`. During development, the Vite dev server proxies all `/api` requests to `http://localhost:3000` (configured in `client/vite.config.ts`). The browser therefore communicates only with `localhost:5173`, and the backend requires no CORS configuration. The backend must be running for the interface to load data. If it is unavailable, the interface displays a connection error with a retry control.

### 1.3 Scope and Assumptions

The system does not implement authentication. The interface creates and lists reservations on behalf of a default demonstration user, `student-001`. A different user may be simulated by creating the git-ignored file `client/.env.local` containing the following line, and then restarting `npm run dev`:

```
VITE_CAMPUSHUB_USER_ID=u1
```

## 2. Experimental Environment

### 2.1 Prerequisites

- **Node.js 24** (developed with 24.19.0 and npm 12)
- **Docker Desktop**, used to host the MongoDB 8 container
- Windows PowerShell (the commands below use PowerShell syntax; other shells work with equivalent commands)

### 2.2 Installation

```powershell
# From the repository root
npm install
cd client
npm install
cd ..

# Create the MongoDB container (skip if campushub-mongo already exists)
docker run -d --name campushub-mongo -p 27017:27017 mongo:8
```

### 2.3 Data Initialization

A newly created database contains no resources to reserve, and no seed script is provided. Sample resources may be inserted with `mongosh` inside the container:

```powershell
docker exec campushub-mongo mongosh campushub --quiet --eval 'db.resources.insertMany([{name:"Study Room 101",type:"ROOM",location:"Library - First Floor",isAvailable:true},{name:"Projector 201",type:"EQUIPMENT",location:"Media Services",isAvailable:true},{name:"Computer Lab A",type:"LAB",location:"Engineering Building",isAvailable:true}])'
```

### 2.4 Execution

Two terminals are required.

```powershell
# Terminal 1: database and backend (repository root)
docker start campushub-mongo
$env:MONGODB_URI = "mongodb://localhost:27017/campushub"
npm run build; if ($?) { npm start }      # http://localhost:3000/api/v1
```

```powershell
# Terminal 2: frontend
cd client
npm run dev                                # open http://localhost:5173
```

The environment variable `MONGODB_URI` is mandatory. If it is not set in the terminal that launches the backend, the process terminates with a `MissingEnvError`.

## 3. API Specification

The base URL is `http://localhost:3000/api/v1`. The complete contract is given in `docs/openapi.yaml`.

| Method | Path                         | Purpose                                                              |
| ------ | ---------------------------- | -------------------------------------------------------------------- |
| GET    | `/resources?type=`           | List resources, optionally filtered by type (`ROOM`, `EQUIPMENT`, `LAB`) |
| POST   | `/reservations`              | Create a reservation; responds with 409 on a time conflict           |
| GET    | `/reservations/user/:userId` | Retrieve a user's non-cancelled reservations                         |
| PATCH  | `/reservations/:id/cancel`   | Cancel a reservation (idempotent)                                    |

## 4. Verification

### 4.1 Automated Checks

```powershell
# Backend (repository root); typecheck also covers shared/api.d.ts
npm run typecheck
npm run build

# Frontend
cd client
npm run typecheck
npm run lint
npm run build
```

### 4.2 Proxy Smoke Test

With both servers running, the following read-only requests confirm that the development proxy forwards requests correctly:

```powershell
curl.exe -i "http://localhost:5173/api/v1/resources?type=ROOM"
curl.exe -i "http://localhost:5173/api/v1/reservations/user/student-001"
```

### 4.3 Manual Acceptance Procedure

The following scenarios are verified manually in the browser:

1. Load the resource directory and switch between type filters.
2. Submit the booking form empty, and with an end time earlier than the start time, and confirm that validation errors are shown.
3. Book a slot and confirm that it appears under My Bookings with the correct local times.
4. Book the same slot again and confirm that the 409 conflict message is displayed.
5. Cancel a booking and confirm that the list refreshes.
6. Stop the backend and confirm that the error message appears and that the retry control restores normal operation.

### 4.4 Recorded Results

The Lab 5 results, distinguishing automated from manual checks, are recorded in `docs/lab5-verification.md`. The Lab 6 context optimization, refactoring, and verification are recorded in [`docs/lab6-refactoring.md`](docs/lab6-refactoring.md).

## 5. Limitations

- Authentication is not implemented; all requests are attributed to a demonstration user.
- No seed script is provided, so resources must be inserted manually (Section 2.3).
- Backend linting is not yet configured (no root `eslint.config.*`), so `npm run lint` is available only in `client/`.
