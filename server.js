const express = require("express");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { Server } = require("socket.io");
const {
  validateBidTotal,
  bidWithAdjustment,
  getCardSuitForPlay,
  determineWinner,
  canPlayCard,
  getGameOutcome,
} = require("./game-rules");
const ai = require("./ai");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

const PORT = Number(process.env.PORT) || 3000;
const TRICK_PAUSE_MS = 3000;
const rooms = new Map();
const SUITS = ["♣", "♦", "♥", "♠"];
const SUIT_ORDER = { "♣": 0, "♦": 1, "♥": 2, "♠": 3 };
const RANK_ORDER = { "7": 7, "8": 8, "9": 9, "10": 10, "J": 11, "Q": 12, "K": 13, "A": 14 };
const CARD_VALUES = { "7": 7, "8": 8, "9": 9, "10": 10, "J": 11, "Q": 12, "K": 13, "A": 15, "JOKER": 20 };
const AI_NAMES = ["Nova", "Orbit", "Bolt", "Pixel", "Echo", "Juno", "Vega", "Blitz", "Comet", "Nimbus", "Rex", "Cinder"];

app.use(express.static(path.join(__dirname, "public")));

app.get("/rules", (req, res) => {
  const rulesPath = path.join(__dirname, "rules", "diamonds-rules.md");

  try {
    const markdown = fs.readFileSync(rulesPath, "utf8");
    res.type("html").send(renderMarkdownPage(markdown));
  } catch (error) {
    res.status(500).send("Unable to load the rules page.");
  }
});

app.use("/rules", express.static(path.join(__dirname, "rules")));

app.get("/health", (req, res) => {
  res.json({ ok: true, rooms: rooms.size });
});

io.on("connection", (socket) => {
  socket.emit("lobby:rooms", getLobbyRooms());

  socket.on("lobby:list", () => {
    socket.emit("lobby:rooms", getLobbyRooms());
  });

  socket.on("room:create", ({ roomName, playerName, aiCount = 0, aiLevels = [] }) => {
    const safeRoomName = sanitizeText(roomName, "New Table", 32);
    const safePlayerName = sanitizeText(playerName, "Player", 20);
    const maxPlayers = 3;
    const aiLimit = Math.max(0, Math.min(maxPlayers - 1, Number(aiCount) || 0));

    const room = createRoom(safeRoomName, maxPlayers);
    const host = addPlayerToRoom(room, socket.id, safePlayerName, false, 0);
    room.hostSocketId = socket.id;

    for (let index = 0; index < aiLimit; index += 1) {
      const aiSeat = room.players.length;
      const aiPlayer = addPlayerToRoom(room, `ai-${room.id}-${index + 1}`, createAiName(), true, aiSeat);
      aiPlayer.aiLevel = ai.normalizeLevel(Array.isArray(aiLevels) ? aiLevels[index] : undefined);
    }

    socket.join(room.id);
    socket.emit("room:joined", { roomId: room.id, playerId: socket.id, seat: host.seat });
    emitRoomState(room);
    emitLobbyList();
  });

  socket.on("room:join", ({ roomId, playerName }) => {
    const room = rooms.get(roomId);
    if (!room) {
      socket.emit("toast", { type: "error", message: "Room not found." });
      return;
    }

    if (room.state !== "lobby") {
      socket.emit("toast", { type: "error", message: "This table is already in progress." });
      return;
    }

    const safeName = sanitizeText(playerName, "Player", 20);
    const seat = findOpenSeat(room);
    if (seat === null) {
      socket.emit("toast", { type: "error", message: "This room is full." });
      return;
    }

    socket.join(room.id);
    const player = addPlayerToRoom(room, socket.id, safeName, false, seat);
    socket.emit("room:joined", { roomId: room.id, playerId: socket.id, seat: player.seat });
    emitRoomState(room);
    emitLobbyList();
  });

  socket.on("room:ready", ({ roomId, ready }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    const player = room.players.find((entry) => entry.id === socket.id);
    if (!player) return;

    player.ready = Boolean(ready);
    emitRoomState(room);
  });

  socket.on("room:start", ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) return;

    const isHost = room.hostSocketId === socket.id;
    if (!isHost) {
      socket.emit("toast", { type: "error", message: "Only the host can start the game." });
      return;
    }

    if (room.players.length !== 3) {
      socket.emit("toast", { type: "error", message: "Diamonds needs exactly three players to start." });
      return;
    }

    startGame(room);
  });

  socket.on("room:leave", ({ roomId }) => {
    leaveRoom(socket, roomId);
  });

  socket.on("game:bid", ({ roomId, bid }) => {
    const room = rooms.get(roomId);
    if (!room || !room.game || room.game.phase !== "bidding") return;

    const player = room.players.find((entry) => entry.id === socket.id);
    if (!player) return;
    if (player.seat !== room.game.currentBidder) {
      socket.emit("toast", { type: "error", message: "It is not your turn to bid." });
      return;
    }

    const safeBid = clamp(Number(bid) || 0, 0, 10);
    const nextBids = { ...room.game.bids, [player.seat]: safeBid };
    const isFinalBid = Object.keys(nextBids).length === room.players.length;
    if (isFinalBid && !validateBidTotal(nextBids)) {
      socket.emit("toast", { type: "error", message: "The final bid total cannot equal 10." });
      return;
    }

    room.game.bids[player.seat] = safeBid;
    room.game.currentBidder = getNextSeat(room, player.seat);
    room.game.statusText = `${player.name} bids ${safeBid}.`;

    if (Object.keys(room.game.bids).length === room.players.length) {
      beginDiscardPhase(room);
      return;
    }

    emitGameState(room);
    triggerAiFlow(room);
  });

  socket.on("game:take-kitty", ({ roomId, kittyIndex }) => {
    const room = rooms.get(roomId);
    if (!room || !room.game || room.game.phase !== "discarding") return;

    const player = room.players.find((entry) => entry.id === socket.id);
    if (!player) return;
    if (player.seat !== room.game.currentTurn) {
      socket.emit("toast", { type: "error", message: "It is not your turn to take a kitty card." });
      return;
    }

    takeKittyCard(room, player, kittyIndex);
  });

  socket.on("game:discard-card", ({ roomId, cardCode }) => {
    const room = rooms.get(roomId);
    if (!room || !room.game || room.game.phase !== "discarding") return;

    const player = room.players.find((entry) => entry.id === socket.id);
    if (!player) return;
    if (player.seat !== room.game.currentTurn) {
      socket.emit("toast", { type: "error", message: "It is not your turn to discard." });
      return;
    }

    discardCard(room, player, cardCode);
  });

  socket.on("game:adjust-bid", ({ roomId, delta }) => {
    const room = rooms.get(roomId);
    if (!room || !room.game || room.game.phase !== "bid-adjustment") return;

    const player = room.players.find((entry) => entry.id === socket.id);
    if (!player) return;
    if (player.seat !== room.game.currentBidder) {
      socket.emit("toast", { type: "error", message: "It is not your turn to adjust your bid." });
      return;
    }

    const adjustment = clamp(Number(delta) || 0, -1, 1);
    if (!bidWithAdjustment(room.game.bids, player.seat, adjustment)) {
      socket.emit("toast", { type: "error", message: "That adjustment would make the total 10." });
      return;
    }

    const currentBid = Number(room.game.bids[player.seat] ?? 0) || 0;
    const nextBid = clamp(currentBid + adjustment, 0, 10);
    room.game.bids[player.seat] = nextBid;
    room.game.statusText = `${player.name} ${adjustment > 0 ? "raises" : adjustment < 0 ? "lowers" : "keeps"} the bid to ${nextBid}.`;
    room.game.adjustmentCount = (room.game.adjustmentCount || 0) + 1;

    if (room.game.adjustmentCount >= room.players.length) {
      room.game.phase = "playing";
      room.game.statusText = "Bidding complete. Play begins.";
      room.game.currentTurn = room.game.leaderSeat;
      room.game.leadingSuit = null;
      room.game.trick = [];
      emitGameState(room);
      triggerAiFlow(room);
      return;
    }

    room.game.currentBidder = getNextSeat(room, player.seat);
    emitGameState(room);
    triggerAiFlow(room);
  });

  socket.on("game:play-card", ({ roomId, cardCode, jokerSuit, jokerMode, aceMode }) => {
    const room = rooms.get(roomId);
    if (!room || !room.game || room.game.phase !== "playing") return;

    const player = room.players.find((entry) => entry.id === socket.id);
    if (!player) return;
    if (room.game.currentTurn !== player.seat) {
      socket.emit("toast", { type: "error", message: "It is not your turn." });
      return;
    }

    playCard(room, player, cardCode, { jokerSuit, jokerMode, aceMode });
  });

  socket.on("disconnect", () => {
    leaveRoom(socket);
  });
});

function createRoom(name, maxPlayers) {
  const roomId = `room-${Math.random().toString(36).slice(2, 8)}`;
  const room = {
    id: roomId,
    name,
    state: "lobby",
    maxPlayers,
    hostSocketId: null,
    players: [],
    game: null,
    aiTimer: null,
  };

  rooms.set(roomId, room);
  return room;
}

function addPlayerToRoom(room, socketId, playerName, isAi, seat) {
  const existing = room.players.find((player) => player.id === socketId);
  if (existing) {
    return existing;
  }

  const player = {
    id: socketId,
    name: playerName,
    seat,
    isAi,
    ready: false,
    connected: true,
    hand: [],
    score: 0,
    pointCard: null,
    kittyCard: null,
  };

  room.players.push(player);
  room.players.sort((a, b) => a.seat - b.seat);
  return player;
}

function findOpenSeat(room) {
  const occupied = new Set(room.players.map((player) => player.seat));
  for (let seat = 0; seat < room.maxPlayers; seat += 1) {
    if (!occupied.has(seat)) {
      return seat;
    }
  }
  return null;
}

function sanitizeText(input, fallback, maxLength) {
  const value = typeof input === "string" ? input.trim() : "";
  const safe = value || fallback;
  return safe.slice(0, maxLength);
}

function createAiName() {
  const seed = AI_NAMES[Math.floor(Math.random() * AI_NAMES.length)] || "Bot";
  return `${seed} 🤖`;
}

function getLobbyRooms() {
  return Array.from(rooms.values())
    .filter((room) => room.state === "lobby")
    .map((room) => ({
      id: room.id,
      name: room.name,
      playerCount: room.players.length,
      maxPlayers: room.maxPlayers,
      host: room.players[0] ? room.players[0].name : "Host",
    }));
}

function emitLobbyList() {
  io.emit("lobby:rooms", getLobbyRooms());
}

function emitRoomState(room) {
  if (!room) return;

  const payload = {
    id: room.id,
    name: room.name,
    state: room.state,
    maxPlayers: room.maxPlayers,
    players: room.players.map((player) => ({
      id: player.id,
      name: player.name,
      seat: player.seat,
      isAi: player.isAi,
      aiLevel: player.isAi ? player.aiLevel || ai.DEFAULT_LEVEL : null,
      ready: player.ready,
      score: player.score,
      handCount: player.hand.length,
    })),
  };

  io.to(room.id).emit("room:state", payload);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function renderMarkdownPage(markdown) {
  const bodyHtml = markdownToHtml(markdown);

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Diamonds Rules</title>
    <link rel="stylesheet" href="/styles.css" />
  </head>
  <body class="rules-page">
    <div class="app-shell">
      <header class="topbar">
        <div>
          <p class="eyebrow">How to play</p>
          <h1>Diamonds Rules</h1>
        </div>
        <div class="topbar-actions">
          <a class="rules-link" href="/">Back to the table</a>
        </div>
      </header>

      <main class="main-grid">
        <section class="panel rules-content">
          ${bodyHtml}
        </section>
      </main>
    </div>
  </body>
</html>`;
}

function markdownToHtml(markdown) {
  const lines = markdown.split(/\r?\n/);
  const html = [];
  let paragraph = [];
  let listItems = [];

  const flushParagraph = () => {
    if (paragraph.length) {
      html.push(`<p>${formatInline(paragraph.join(" "))}</p>`);
      paragraph = [];
    }
  };

  const flushList = () => {
    if (listItems.length) {
      html.push(`<ul>${listItems.map((item) => `<li>${item}</li>`).join("")}</ul>`);
      listItems = [];
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (!line) {
      flushParagraph();
      flushList();
      continue;
    }

    const headingMatch = line.match(/^(#{1,3})\s+(.*)$/);
    if (headingMatch) {
      flushParagraph();
      flushList();
      const level = headingMatch[1].length;
      const text = formatInline(headingMatch[2]);
      html.push(`<h${level}>${text}</h${level}>`);
      continue;
    }

    if (line.startsWith("- ")) {
      flushParagraph();
      listItems.push(formatInline(line.slice(2).trim()));
      continue;
    }

    flushList();
    paragraph.push(line);
  }

  flushParagraph();
  flushList();

  return html.join("\n");
}

function formatInline(text) {
  let output = escapeHtml(text);
  output = output.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  output = output.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noreferrer">$1</a>');
  output = output.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  output = output.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  return output;
}

function startGame(room) {
  room.state = "playing";
  const seats = room.players.map((player) => player.seat);
  const firstDealer = seats[Math.floor(Math.random() * seats.length)];
  room.game = {
    phase: "bidding",
    dealerSeat: firstDealer,
    leaderSeat: null,
    currentBidder: null,
    currentTurn: null,
    trick: [],
    leadingSuit: null,
    kitty: [],
    bids: {},
    roundSummary: [],
    roundTricks: {},
    statusText: "Bidding begins. Each bidder estimates the number of tricks they can win.",
    hands: Array.from({ length: 3 }, () => []),
    board: [],
    roundNumber: 1,
    lastWinningCard: null,
    pauseTimer: null,
  };

  room.players.forEach((player) => {
    player.score = 0;
    player.ready = true;
  });

  beginHand(room, true);
}

function beginHand(room, isFirstHand = false) {
  if (!room.game) return;

  const deck = shuffle(createDeck());
  const players = room.players.slice().sort((a, b) => a.seat - b.seat);
  const kitty = [];

  // The turn to deal passes clockwise after each hand. Bidding and play both
  // begin with the player to the dealer's left.
  if (!isFirstHand) {
    room.game.dealerSeat = getNextSeat(room, room.game.dealerSeat);
  }
  const firstToAct = getNextSeat(room, room.game.dealerSeat);

  room.game.phase = "bidding";
  room.game.leaderSeat = firstToAct;
  room.game.currentBidder = firstToAct;
  room.game.currentTurn = firstToAct;
  room.game.trick = [];
  room.game.leadingSuit = null;
  room.game.bids = {};
  room.game.roundSummary = [];
  room.game.roundTricks = {};
  room.game.kitty = [];
  room.game.lastWinningCard = null;
  room.game.adjustmentCount = 0;
  room.game.discardCount = 0;
  const dealerName = room.players.find((player) => player.seat === room.game.dealerSeat)?.name || "Dealer";
  room.game.statusText = `${dealerName} deals. Bidding begins. Each bidder estimates the number of tricks they can win.`;
  room.game.hands = Array.from({ length: 3 }, () => []);
  room.game.board = [];
  room.game.playedCards = [];

  let index = 0;
  for (let count = 0; count < 10; count += 1) {
    for (let playerIndex = 0; playerIndex < players.length; playerIndex += 1) {
      room.game.hands[playerIndex].push(deck[index]);
      index += 1;
    }
  }

  for (let kittyIndex = 0; kittyIndex < 3; kittyIndex += 1) {
    kitty.push(deck[index]);
    index += 1;
  }

  room.game.kitty = kitty;

  room.players.forEach((player) => {
    const seat = player.seat;
    player.hand = sortCards(room.game.hands[seat]);
    player.pointCard = null;
    player.kittyCard = null;
    if (isFirstHand) {
      player.score = 0;
    }
    player.ready = true;
  });

  emitRoomState(room);
  emitGameState(room);
  triggerAiFlow(room);
}

function triggerAiFlow(room) {
  if (!room.game) return;
  const game = room.game;

  if (game.phase === "bidding") {
    const currentPlayer = room.players.find((player) => player.seat === game.currentBidder && player.isAi);
    if (currentPlayer) {
      setTimeout(() => {
        if (room.game !== game || game.phase !== "bidding" || game.currentBidder !== currentPlayer.seat) return;
        const preferred = ai.chooseBid(currentPlayer.aiLevel, getAiView(room, currentPlayer));
        const safeBid = chooseSafeBid(room, currentPlayer, preferred);
        game.bids[currentPlayer.seat] = safeBid;
        game.currentBidder = getNextSeat(room, currentPlayer.seat);
        game.statusText = `${currentPlayer.name} bids ${safeBid}.`;

        if (Object.keys(game.bids).length === room.players.length) {
          beginDiscardPhase(room);
          return;
        }

        emitGameState(room);
        triggerAiFlow(room);
      }, 600);
    }
  }

  if (game.phase === "discarding") {
    const currentPlayer = room.players.find((player) => player.seat === game.currentTurn && player.isAi);
    if (currentPlayer) {
      setTimeout(() => {
        if (room.game !== game || game.phase !== "discarding" || game.currentTurn !== currentPlayer.seat) return;
        if (!currentPlayer.kittyCard) {
          takeKittyCard(room, currentPlayer, Math.floor(Math.random() * game.kitty.length));
        }
        const card = ai.chooseDiscard(currentPlayer.aiLevel, getAiView(room, currentPlayer));
        if (card) {
          discardCard(room, currentPlayer, card.code);
        }
      }, 700);
    }
  }

  if (game.phase === "bid-adjustment") {
    const currentPlayer = room.players.find((player) => player.seat === game.currentBidder && player.isAi);
    if (currentPlayer) {
      setTimeout(() => {
        if (room.game !== game || game.phase !== "bid-adjustment" || game.currentBidder !== currentPlayer.seat) return;
        const preferred = ai.chooseBidAdjustment(currentPlayer.aiLevel, getAiView(room, currentPlayer));
        adjustBid(room, currentPlayer, chooseValidAdjustment(room, currentPlayer, preferred));
      }, 600);
    }
  }

  if (game.phase === "playing") {
    const aiTurn = room.players.find((player) => player.isAi && player.seat === game.currentTurn);
    if (aiTurn) {
      setTimeout(() => {
        if (room.game !== game || game.phase !== "playing" || game.currentTurn !== aiTurn.seat) return;
        const choice = ai.choosePlay(aiTurn.aiLevel, getAiView(room, aiTurn));
        if (choice) {
          playCard(room, aiTurn, choice.card.code, choice.selection);
        }
      }, 700);
    }
  }
}

// Everything an AI may know: its own cards and point card, plus public info.
function getAiView(room, player) {
  const game = room.game;
  const ownKnown = [...player.hand, player.pointCard, player.kittyCard];
  return {
    seat: player.seat,
    hand: player.hand,
    bids: { ...game.bids },
    bid: game.bids[player.seat] ?? 0,
    tricksWon: game.roundTricks?.[player.seat] ?? 0,
    allTricksWon: { ...(game.roundTricks || {}) },
    history: game.playedCards || [],
    trick: game.trick,
    leadSuit: game.leadingSuit,
    playerCount: room.players.length,
    playersAfter: room.players.length - game.trick.length - 1,
    unseen: ai.unseenCards([...ownKnown, ...(game.playedCards || []).map((play) => play.card)]),
  };
}

function chooseSafeBid(room, player, preferredBid) {
  const seatCount = room.players.length;
  const candidates = [];

  for (let bid = 0; bid <= 10; bid += 1) {
    const nextBids = { ...room.game.bids, [player.seat]: bid };
    if (Object.keys(nextBids).length === seatCount && !validateBidTotal(nextBids)) {
      continue;
    }
    candidates.push({ bid, score: Math.abs(bid - preferredBid) });
  }

  if (!candidates.length) {
    return clamp(preferredBid, 0, 10);
  }

  candidates.sort((left, right) => left.score - right.score || left.bid - right.bid);
  return candidates[0].bid;
}

// The AI's preferred change, or the nearest one that keeps the total off 10.
function chooseValidAdjustment(room, player, preferred) {
  const order = [preferred, 0, -1, 1].filter((delta, index, list) => list.indexOf(delta) === index);
  for (const delta of order) {
    if (bidWithAdjustment(room.game.bids, player.seat, delta)) {
      return delta;
    }
  }
  return 0;
}

function beginDiscardPhase(room) {
  room.game.phase = "discarding";
  room.game.discardCount = 0;
  room.game.currentTurn = getNextSeat(room, room.game.dealerSeat);
  room.game.statusText = "Each player privately takes one kitty card and then discards one card from hand.";

  room.players.forEach((player) => {
    player.pointCard = null;
    player.kittyCard = null;
  });

  emitGameState(room);
  triggerAiFlow(room);
}

function beginBidAdjustment(room) {
  room.game.phase = "bid-adjustment";
  room.game.adjustmentCount = 0;
  room.game.currentBidder = getNextSeat(room, room.game.dealerSeat);
  room.game.statusText = "After discarding, each player may raise, lower, or keep their bid.";
  emitGameState(room);
  triggerAiFlow(room);
}

function sendToast(player, message) {
  const socket = io.sockets.sockets.get(player.id);
  if (socket) {
    socket.emit("toast", { type: "error", message });
  }
}

// The kitty is face down: the player picks a position, not a known card, and
// only they learn which card it was. The card goes into their hand; the player
// then discards any card (possibly this one) and that discard is the point card.
function takeKittyCard(room, player, kittyIndex) {
  if (player.kittyCard) {
    sendToast(player, "You have already taken a kitty card.");
    return;
  }

  const index = Number(kittyIndex);
  if (!Number.isInteger(index) || index < 0 || index >= room.game.kitty.length) {
    sendToast(player, "Choose one of the kitty cards.");
    return;
  }

  const [card] = room.game.kitty.splice(index, 1);
  player.kittyCard = card;
  player.hand = sortCards([...player.hand, card]);
  room.game.statusText = `${player.name} has taken a kitty card and is choosing a discard.`;
  emitGameState(room);
}

function discardCard(room, player, cardCode) {
  if (!player.kittyCard) {
    sendToast(player, "Take a kitty card before discarding.");
    return;
  }

  const handIndex = player.hand.findIndex((entry) => entry.code === cardCode);
  if (handIndex === -1) {
    sendToast(player, "You do not have that card in hand.");
    return;
  }

  // The discarded card (which may be the kitty card) is the point card.
  const [discarded] = player.hand.splice(handIndex, 1);
  player.pointCard = discarded;

  room.game.statusText = `${player.name} has taken a private kitty card and discarded one card.`;
  room.game.discardCount = (room.game.discardCount || 0) + 1;

  if (room.game.discardCount >= room.players.length) {
    beginBidAdjustment(room);
    return;
  }

  room.game.currentTurn = getNextSeat(room, player.seat);
  emitGameState(room);
  triggerAiFlow(room);
}

function adjustBid(room, player, delta) {
  const currentBid = Number(room.game.bids[player.seat] ?? 0) || 0;
  const nextBid = clamp(currentBid + delta, 0, 10);
  const nextBids = { ...room.game.bids, [player.seat]: nextBid };

  if (!validateBidTotal(nextBids)) {
    const socket = io.sockets.sockets.get(player.id);
    if (socket) {
      socket.emit("toast", { type: "error", message: "That bid would make the total 10." });
    }
    return;
  }

  room.game.bids[player.seat] = nextBid;
  room.game.adjustmentCount = (room.game.adjustmentCount || 0) + 1;
  room.game.statusText = `${player.name} ${delta > 0 ? "raises" : delta < 0 ? "lowers" : "keeps"} the bid to ${nextBid}.`;

  if (room.game.adjustmentCount >= room.players.length) {
    room.game.phase = "playing";
    room.game.statusText = "Bidding complete. Play begins.";
    room.game.currentTurn = room.game.leaderSeat;
    room.game.leadingSuit = null;
    room.game.trick = [];
    emitGameState(room);
    triggerAiFlow(room);
    return;
  }

  room.game.currentBidder = getNextSeat(room, player.seat);
  emitGameState(room);
  triggerAiFlow(room);
}

function emitGameState(room) {
  if (!room || !room.game) return;

  const players = room.players.slice().sort((a, b) => a.seat - b.seat);
  const payload = {
    roomId: room.id,
    roomName: room.name,
    phase: room.game.phase,
    currentTurn: room.game.currentTurn,
    currentBidder: room.game.currentBidder,
    leadingSuit: room.game.leadingSuit,
    trickWinnerSeat: room.game.trickWinnerSeat ?? null,
    statusText: room.game.statusText,
    kittyCount: room.game.kitty.length,
    dealerSeat: room.game.dealerSeat,
    winners: room.game.winners || null,
    trick: room.game.trick.map((entry) => ({
      seat: entry.playerSeat,
      cardCode: entry.card.code,
      cardSuit: getCardSuitForPlay(entry.card),
      cardMode: entry.card.selectedMode || null,
      playerName: room.players.find((p) => p.seat === entry.playerSeat)?.name || "",
    })),
    roundSummary: room.game.roundSummary || [],
    lastWinningCard: room.game.lastWinningCard ? {
      ...room.game.lastWinningCard,
    } : null,
    players: players.map((player) => ({
      id: player.id,
      name: player.name,
      seat: player.seat,
      isAi: player.isAi,
      aiLevel: player.isAi ? player.aiLevel || ai.DEFAULT_LEVEL : null,
      score: player.score,
      bid: room.game.bids[player.seat] ?? null,
      handCount: player.hand.length,
      pointCard: player.pointCard?.code || null,
      kittyCard: null,
      tricksWon: room.game.roundTricks?.[player.seat] ?? 0,
    })),
    mySeat: null,
    hand: [],
  };

  for (const player of players) {
    const socket = io.sockets.sockets.get(player.id);
    if (!socket) continue;

    const myPayload = {
      ...payload,
      mySeat: player.seat,
      hand: sortCards(player.hand).map((card) => card.code),
      players: payload.players.map((entry) => ({
        ...entry,
        pointCard: entry.id === player.id ? player.pointCard?.code || null : null,
        kittyCard: entry.id === player.id ? player.kittyCard?.code || null : null,
      })),
    };

    socket.emit("game:state", myPayload);
  }
}

function playCard(room, player, cardCode, selection = {}) {
  if (!room.game) return;

  const card = player.hand.find((entry) => entry.code === cardCode);
  if (!card) return;

  const handIndex = player.hand.findIndex((entry) => entry.code === card.code);
  if (handIndex === -1) return;

  const leadSuit = room.game.leadingSuit;
  const isJoker = card.code === "JOKER";
  const isAce = card.rank === "A";
  const selectedSuit = isJoker ? (selection.jokerSuit && SUITS.includes(selection.jokerSuit) ? selection.jokerSuit : null) : card.suit;
  let selectedMode = null;
  if (isJoker) selectedMode = selection.jokerMode === "low" ? "low" : "high";
  if (isAce) selectedMode = selection.aceMode === "low" ? "low" : "high";

  if (isJoker && !selectedSuit) {
    sendToast(player, "Choose the joker suit and whether it is high or low.");
    return;
  }

  if (!canPlayCard(player.hand, card, leadSuit)) {
    sendToast(player, "You must follow the lead suit if you can.");
    return;
  }

  const [playedCard] = player.hand.splice(handIndex, 1);
  if (isJoker) {
    playedCard.selectedSuit = selectedSuit;
  }
  playedCard.selectedMode = selectedMode;
  room.game.trick.push({ playerSeat: player.seat, card: playedCard });
  room.game.playedCards = room.game.playedCards || [];
  room.game.playedCards.push({ seat: player.seat, card: playedCard, leadSuit: room.game.leadingSuit });

  if (!room.game.leadingSuit) {
    room.game.leadingSuit = getCardSuitForPlay(playedCard);
  }

  const nextSeat = getNextSeat(room, room.game.currentTurn);
  room.game.statusText = `${player.name} plays ${describeCard(playedCard)}.`;

  if (room.game.trick.length === room.players.length) {
    const winner = determineWinner(room.game.trick, room.game.leadingSuit);
    const winnerPlayer = room.players.find((entry) => entry.seat === winner.playerSeat);
    room.game.roundTricks = room.game.roundTricks || {};
    room.game.roundTricks[winner.playerSeat] = (room.game.roundTricks[winner.playerSeat] || 0) + 1;
    room.game.currentTurn = winner.playerSeat;
    room.game.lastWinningCard = {
      cardCode: winner.card.code,
      cardSuit: getCardSuitForPlay(winner.card),
      cardMode: winner.card.selectedMode || null,
      playerName: winnerPlayer.name,
      playerSeat: winner.playerSeat,
    };
    room.game.statusText = `${winnerPlayer.name} wins the trick with ${describeCard(winner.card)}.`;
    room.game.board.push({ winnerSeat: winnerPlayer.seat, card: winner.card, playerName: winnerPlayer.name });

    // Leave the finished trick on the table for a moment so everyone can see
    // what was played and who won it.
    room.game.phase = "trick-end";
    room.game.trickWinnerSeat = winner.playerSeat;
    emitGameState(room);

    const game = room.game;
    clearTimeout(game.pauseTimer);
    game.pauseTimer = setTimeout(() => {
      if (room.game !== game || game.phase !== "trick-end") return;
      finishTrick(room);
    }, TRICK_PAUSE_MS);
    return;
  }

  room.game.currentTurn = nextSeat;
  emitGameState(room);
  triggerAiFlow(room);
}

function finishTrick(room) {
  room.game.trick = [];
  room.game.leadingSuit = null;
  room.game.trickWinnerSeat = null;

  if (room.players.every((entry) => entry.hand.length === 0)) {
    room.game.roundSummary = room.players.map((entry) => {
      const actual = room.game.roundTricks[entry.seat] || 0;
      const bid = room.game.bids[entry.seat] ?? 0;
      const pointValue = entry.pointCard?.value || 0;
      const delta = actual === bid ? pointValue : -pointValue;
      entry.score += delta;
      return {
        name: entry.name,
        seat: entry.seat,
        bid,
        actual,
        pointCard: entry.pointCard?.code || null,
        delta,
        total: entry.score,
      };
    });

    const outcome = getGameOutcome(room.players);
    if (outcome) {
      const names = outcome.winners
        .map((seat) => room.players.find((entry) => entry.seat === seat)?.name || "Player")
        .join(" and ");
      room.game.phase = "game-over";
      room.game.winners = outcome.winners;
      room.state = "finished";
      room.game.statusText = outcome.reason === "win"
        ? `Game over! ${names} reached 100 and ${outcome.winners.length > 1 ? "win" : "wins"}.`
        : `Game over! A player reached -100; ${names} ${outcome.winners.length > 1 ? "win" : "wins"} with the highest score.`;
      clearTimeout(room.game.pauseTimer);
      emitRoomState(room);
      emitGameState(room);
      return;
    }

    room.game.phase = "round-end";
    room.game.statusText = "Hand complete. Scores updated.";
    emitGameState(room);

    clearTimeout(room.game.pauseTimer);
    room.game.pauseTimer = setTimeout(() => {
      if (!room.game || room.game.phase !== "round-end") return;
      room.game.roundNumber += 1;
      beginHand(room, false);
    }, 2500);
    return;
  }

  room.game.phase = "playing";
  emitGameState(room);
  triggerAiFlow(room);
}

function describeCard(card) {
  if (card.code === "JOKER") return `JOKER (${card.selectedMode} ${card.selectedSuit})`;
  if (card.rank === "A") return `${card.code} (${card.selectedMode})`;
  return card.code;
}

function createDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of Object.keys(RANK_ORDER)) {
      deck.push({
        code: `${rank}${suit}`,
        rank,
        suit,
        value: CARD_VALUES[rank],
      });
    }
  }

  deck.push({
    code: "JOKER",
    rank: "JOKER",
    suit: "JOKER",
    value: CARD_VALUES.JOKER,
  });

  return deck;
}

function shuffle(items) {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const j = Math.floor(Math.random() * (index + 1));
    [result[index], result[j]] = [result[j], result[index]];
  }
  return result;
}

function sortCards(cards) {
  return [...cards].sort((left, right) => {
    const suitDelta = SUIT_ORDER[left.suit] - SUIT_ORDER[right.suit];
    if (suitDelta !== 0) return suitDelta;
    if (left.rank === "JOKER") return 1;
    if (right.rank === "JOKER") return -1;
    return RANK_ORDER[left.rank] - RANK_ORDER[right.rank];
  });
}

function getNextSeat(room, seat) {
  const seats = room.players.map((player) => player.seat).sort((a, b) => a - b);
  const index = seats.indexOf(seat);
  return seats[(index + 1) % seats.length];
}

function leaveRoom(socket, roomId) {
  let targetRoom = null;

  if (roomId) {
    targetRoom = rooms.get(roomId);
  } else {
    for (const room of rooms.values()) {
      const found = room.players.find((player) => player.id === socket.id);
      if (found) {
        targetRoom = room;
        break;
      }
    }
  }

  if (!targetRoom) return;

  targetRoom.players = targetRoom.players.filter((player) => player.id !== socket.id);
  if (targetRoom.players.length === 0) {
    rooms.delete(targetRoom.id);
    emitLobbyList();
    return;
  }

  if (targetRoom.hostSocketId === socket.id) {
    targetRoom.hostSocketId = targetRoom.players[0]?.id || null;
  }

  targetRoom.players.forEach((player, index) => {
    player.seat = index;
    player.hand = [];
    player.score = 0;
    player.ready = false;
  });

  targetRoom.state = "lobby";
  targetRoom.game = null;
  emitRoomState(targetRoom);
  emitLobbyList();
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

server.listen(PORT, () => {
  console.log(`Diamonds server running on http://localhost:${PORT}`);
});
