# Diamonds Online

A lightweight browser-based version of the Diamonds card game with a lobby, human players, and AI opponents. The server is built with Node.js and Socket.IO and runs in Docker.

## Features

- Create or join a table in a lobby
- Play against AI or other human players
- Real-time turn-based trick-taking gameplay
- Simple room management and reconnect-friendly game state
- Dockerized backend deployment

## Run locally

```bash
npm install
npm start
```

Then open http://localhost:3000

## Run with Docker (local build)

```bash
docker compose up --build
```

Then open http://localhost:3100

## Run with the published GHCR image

1. Replace the placeholder image in [docker-compose.ghcr.yml](docker-compose.ghcr.yml) with your actual GHCR repo, for example:

   ```yaml
   image: ghcr.io/cdonges/diamonds:latest
   ```

2. Start the container:

   ```bash
   docker compose -f docker-compose.ghcr.yml up -d
   ```

3. Open http://localhost:3100

## GitHub Actions

This repository includes a workflow in [.github/workflows/docker-ghcr.yml](.github/workflows/docker-ghcr.yml) that builds the Docker image and pushes it to GitHub Container Registry when:

- code is pushed to `main`
- a version tag like `v1.2.3` is created
- the workflow is triggered manually from GitHub Actions

## Controls

1. Create a room and choose the number of AI opponents.
2. Invite friends with the room code or join the public room list.
3. Start the match once the lobby is ready.
4. Click a card in your hand to play it when it is your turn.

## Rules

The project includes a local copy of the rules in [rules/diamonds-rules.md](rules/diamonds-rules.md).

## License

This project is released under the [CC0 1.0 Universal license](LICENSE).

## Notes

This is a browser-playable prototype based on the classic trick-taking feel of Diamonds. It is designed to be easy to run and extend.
