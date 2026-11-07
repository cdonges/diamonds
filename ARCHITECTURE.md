# Diamonds Architecture

## Overview

This project is a small real-time multiplayer card game built with Node.js, Express, and Socket.IO. The server keeps the authoritative game state for each table, and the browser client renders that state and sends user actions back to the server.

The main pieces are:

- `src/server.js` — authoritative server state, room lifecycle, Socket.IO event handlers, and game rules orchestration
- `src/game-rules.js` — card-play validation, trick resolution, and scoring logic
- `src/ai.js` — AI bidding and play decisions
- `src/public/app.js` — browser client logic for lobby, room UI, and game board
- `src/public/index.html` — static page shell for the lobby and game views
- `tests/*.test.js` — automated checks for game logic and server-side invariants

## Runtime model

### Express web server

The app serves static front-end assets from `src/public` and exposes a minimal HTTP API:

- `/` — main game client
- `/rules` — rules page rendered from the markdown rules document
- `/health` — returns a lightweight status payload with room count

### Socket.IO real-time layer

The server creates a single `io` instance and listens for socket events such as:

- `room:create`
- `room:join`
- `room:ready`
- `room:start`
- `room:leave`
- `game:bid`
- `game:take-kitty`
- `game:discard-card`
- `game:adjust-bid`
- `game:play-card`

The browser client emits those actions and receives updates like:

- `lobby:rooms`
- `room:state`
- `game:state`
- `toast`

This design keeps gameplay authoritative on the server, which avoids client-side cheating and keeps all players in sync.

## Room lifecycle

Rooms are stored in a server-side `Map` keyed by room id.

Each room contains:

- `id` — unique table identifier
- `name` — display name
- `state` — `lobby`, `playing`, `finished`
- `maxPlayers` — currently fixed at 3 for Diamonds
- `hostSocketId` — socket id of the room host
- `players` — player entries for each seat
- `game` — active game state object, or `null` when idle
- `lastActivity` — timestamp used for idle cleanup

### Player model

Each player record includes:

- `id` — socket id or AI id
- `name`
- `seat`
- `isAi`
- `ready`
- `hand`
- `score`
- `pointCard`
- `kittyCard`

Human players and AI players are both stored in the same room model; the difference is that AI players never emit real client input and instead execute through the server-driven `triggerAiFlow()` logic.

## Game flow

A table starts in `lobby` and moves to `playing` when the host starts a game with exactly three players.

The server then initializes a game object with fields such as:

- `phase` — `bidding`, `discarding`, `bid-adjustment`, `playing`, `trick-end`, `round-end`, `game-over`
- `dealerSeat`
- `leaderSeat`
- `currentBidder`
- `currentTurn`
- `hands`
- `kitty`
- `bids`
- `roundTricks`
- `statusText`

The server orchestrates turns and transitions in a single place, which keeps the rules consistent across human and AI actions.

## AI system

AI behavior is isolated in `src/ai.js`.

The server calls `triggerAiFlow(room)` whenever the current turn or phase requires an AI response. The AI module exposes policy functions such as:

- bid selection
- discard choices
- valid bid adjustment choices
- play-card decisions

The server decides when AI actions are allowed to run and ensures they only fire while the game state still matches the expected turn and phase.

## Inactivity cleanup

The server tracks each room’s most recent activity with `lastActivity` and runs a periodic prune loop.

Behavior:

- any room older than 10 minutes is considered inactive
- the server emits a close signal for the room
- timers associated with the game are cleared
- the room is removed from the `rooms` map
- the lobby list is refreshed

This prevents abandoned tables from lingering forever in memory and keeps the lobby clean.

## Game rule separation

The server is intentionally thin around rule evaluation. Core rules live in `src/game-rules.js`, which handles:

- bid validation
- adjustment validation
- trick winner selection
- legal-card checks
- outcome checks for end-of-game thresholds

This separation keeps the gameplay logic testable without the socket layer and makes the domain logic reusable by both humans and AI.

## Front-end architecture

The browser side is a client-only view layer built around DOM rendering and Socket.IO events.

### State shape

The client tracks:

- current room
- current game state
- local seat id
- active views for lobby and room

### Rendering model

The browser updates the UI by listening to socket events and re-rendering room and game sections, including:

- room list
- table seats
- hand cards
- bids and scores
- trick progress
- action buttons based on the current turn

The frontend does not enforce game rules; it simply reflects the server’s authoritative state and emits the player’s desired move.

## Key design principles

1. Single source of truth: the server owns room and game state.
2. Clear separation: rules logic is separate from server I/O and UI rendering.
3. Deterministic room lifecycle: rooms are created, mutated, and destroyed in one place.
4. AI as server-side simulation: no client-side AI logic or trust assumptions.
5. Simple deployment: static assets plus a single Node process.

## Typical request flow

1. User opens the app.
2. Browser connects to the Socket.IO server.
3. User creates or joins a room.
4. Host starts the table when all seats are ready.
5. Server initializes the game state and emits `game:state` to the room.
6. Human or AI actions trigger server handlers.
7. Server updates the canonical room state and broadcasts the new game snapshot.
8. The client re-renders to reflect the updated state.
9. Periodic cleanup removes stale rooms after inactivity.

## Files worth knowing

- [src/server.js](src/server.js)
- [src/game-rules.js](src/game-rules.js)
- [src/ai.js](src/ai.js)
- [src/public/app.js](src/public/app.js)
- [tests/game-rules.test.js](tests/game-rules.test.js)

## Summary

This project uses a classic server-authoritative multiplayer pattern: the browser is a thin client, the server owns the rules and state, and the AI sits alongside the real players as another source of actions. That structure keeps the game consistent, testable, and easy to extend.
