const socket = io();

const ui = {
  roomList: document.getElementById("room-list"),
  roomView: document.getElementById("room-view"),
  lobbyView: document.getElementById("lobby-view"),
  gameView: document.getElementById("game-view"),
  seatList: document.getElementById("seat-list"),
  roomNameLabel: document.getElementById("room-name-label"),
  roomCode: document.getElementById("room-code"),
  scoreboard: document.getElementById("scoreboard"),
  statusStrip: document.getElementById("status-strip"),
  bidPanel: document.getElementById("bid-panel"),
  trickBoard: document.getElementById("trick-board"),
  handCards: document.getElementById("hand-cards"),
  toast: document.getElementById("toast"),
  createForm: document.getElementById("create-room-form"),
  toggleReady: document.getElementById("toggle-ready"),
  leaveRoom: document.getElementById("leave-room"),
  startGame: document.getElementById("start-game"),
  jokerModal: document.getElementById("joker-modal"),
  jokerTitle: document.getElementById("joker-title"),
  jokerSuitRow: document.getElementById("joker-suit-row"),
  jokerSuit: document.getElementById("joker-suit"),
  jokerCancel: document.getElementById("joker-cancel"),
  jokerHigh: document.getElementById("joker-high"),
  jokerLow: document.getElementById("joker-low"),
};

const state = {
  room: null,
  game: null,
  mySeat: null,
  pendingJoker: null,
};

ui.jokerCancel.addEventListener("click", () => {
  hideJokerDialog();
});

function playPendingCard(mode) {
  if (!state.pendingJoker || !state.room) {
    hideJokerDialog();
    return;
  }

  const { cardCode } = state.pendingJoker;
  const payload = { roomId: state.room.id, cardCode };
  if (cardCode === "JOKER") {
    payload.jokerSuit = ui.jokerSuit.value;
    payload.jokerMode = mode;
  } else {
    payload.aceMode = mode;
  }
  socket.emit("game:play-card", payload);
  hideJokerDialog();
}

ui.jokerHigh.addEventListener("click", () => playPendingCard("high"));
ui.jokerLow.addEventListener("click", () => playPendingCard("low"));

ui.createForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const roomName = document.getElementById("room-name").value.trim() || "Friendly Game";
  const playerName = document.getElementById("player-name").value.trim() || "Player 1";
  const aiCount = Number(document.getElementById("ai-count").value || 0);
  const aiLevels = [0, 1].map((index) => document.getElementById(`ai-level-${index}`).value);

  socket.emit("room:create", { roomName, playerName, aiCount, aiLevels });
});

// Only show a skill picker for each AI opponent actually being added.
function updateAiLevelPickers() {
  const aiCount = Number(document.getElementById("ai-count").value || 0);
  document.querySelectorAll(".ai-level").forEach((label) => {
    label.classList.toggle("hidden", Number(label.dataset.aiIndex) >= aiCount);
  });
}

document.getElementById("ai-count").addEventListener("change", updateAiLevelPickers);
updateAiLevelPickers();

const AI_LEVEL_LABELS = { easy: "Easy", medium: "Medium", hard: "Hard" };

function aiBadge(player) {
  if (!player.isAi || !player.aiLevel) return "";
  const level = AI_LEVEL_LABELS[player.aiLevel] ? player.aiLevel : "medium";
  return `<span class="ai-badge ${level}">${AI_LEVEL_LABELS[level]}</span>`;
}

ui.leaveRoom.addEventListener("click", () => {
  if (!state.room) return;
  socket.emit("room:leave", { roomId: state.room.id });
  state.room = null;
  state.game = null;
  state.mySeat = null;
  showLobby();
});

ui.toggleReady.addEventListener("click", () => {
  if (!state.room) return;
  const me = state.room.players.find((player) => player.id === socket.id);
  socket.emit("room:ready", { roomId: state.room.id, ready: !(me && me.ready) });
});

ui.startGame.addEventListener("click", () => {
  if (!state.room) return;
  socket.emit("room:start", { roomId: state.room.id });
});

socket.on("lobby:rooms", (rooms) => {
  renderRoomList(rooms);
});

socket.on("room:joined", ({ roomId, seat }) => {
  state.mySeat = seat;
  showRoom();
  socket.emit("lobby:list");
  socket.emit("room:ready", { roomId, ready: false });
});

socket.on("room:state", (room) => {
  state.room = room;
  renderRoomState(room);
  if (room.state === "playing" || room.state === "finished") {
    showGame();
  } else {
    showRoom();
  }
});

socket.on("game:state", (game) => {
  state.game = game;
  renderGame(game);
  showGame();
});

socket.on("toast", ({ type, message }) => {
  showToast(message, type || "info");
});

function renderRoomList(rooms) {
  if (!rooms.length) {
    ui.roomList.innerHTML = '<div class="room-item"><div><strong>No tables yet</strong><small>Open a new room to get started.</small></div></div>';
    return;
  }

  ui.roomList.innerHTML = rooms
    .map(
      (room) => `
        <div class="room-item">
          <div>
            <strong>${escapeHtml(room.name)}</strong>
            <small>${room.playerCount}/${room.maxPlayers} players · Host: ${escapeHtml(room.host)}</small>
          </div>
          <button class="secondary" data-room-id="${room.id}">Join</button>
        </div>
      `
    )
    .join("");

  ui.roomList.querySelectorAll("button[data-room-id]").forEach((button) => {
    button.addEventListener("click", () => {
      const playerName = document.getElementById("player-name").value.trim() || "Player";
      socket.emit("room:join", { roomId: button.dataset.roomId, playerName });
    });
  });
}

function renderRoomState(room) {
  ui.roomNameLabel.textContent = room.name;
  ui.roomCode.textContent = room.id.toUpperCase();

  const seatCards = [];
  const occupied = new Map(room.players.map((player) => [player.seat, player]));

  for (let seat = 0; seat < room.maxPlayers; seat += 1) {
    const player = occupied.get(seat);
    if (player) {
      seatCards.push(`
        <div class="seat-card ${player.isAi ? "ai" : ""}">
          <span class="pill">${player.isAi ? "AI" : "Player"}</span>
          <div>
            <div class="seat-name">${escapeHtml(player.name)}${aiBadge(player)}</div>
            <small>${player.ready ? "Ready" : "Waiting"}</small>
          </div>
        </div>
      `);
    } else {
      seatCards.push('<div class="seat-card empty"><span class="pill">Open</span><div>Waiting for a player</div></div>');
    }
  }

  ui.seatList.innerHTML = seatCards.join("");

  const me = room.players.find((player) => player.id === socket.id);
  if (me) {
    ui.toggleReady.textContent = me.ready ? "Mark not ready" : "Ready up";
  }
}

function renderGame(game) {
  const players = game.players || [];
  ui.scoreboard.innerHTML = players
    .map((player) => `
      <div class="score-box ${player.seat === state.mySeat ? "active" : ""}">
        <span>${escapeHtml(player.name)}${aiBadge(player)} ${player.seat === state.mySeat ? "(You)" : ""}</span>
        <strong>${player.score}</strong>
        <small>Cards: ${player.handCount} · Bid: ${player.bid !== null && player.bid !== undefined ? player.bid : "--"}</small>
        <small class="tricks-line">Tricks: <b>${player.tricksWon ?? 0}</b></small>
      </div>
    `)
    .join("");

  ui.statusStrip.textContent = game.statusText || "Playing";

  const isMyBidTurn = (game.phase === "bidding" || game.phase === "bid-adjustment") && game.currentBidder === state.mySeat;
  if (game.phase === "bidding") {
    const bidderName = players.find((player) => player.seat === game.currentBidder)?.name || "Player";
    const bidderLabel = isMyBidTurn ? "Your bid" : `${escapeHtml(bidderName)} is bidding`;
    const bidButtons = Array.from({ length: 11 }, (_, index) => `
      <button
        class="bid-button"
        data-bid="${index}"
        ${isMyBidTurn ? "" : "disabled"}
      >${index}</button>
    `).join("");

    ui.bidPanel.innerHTML = `
      <div class="bid-controls">
        <span class="muted">${escapeHtml(bidderLabel)}</span>
        ${bidButtons}
      </div>
    `;

    ui.bidPanel.querySelectorAll("button[data-bid]").forEach((button) => {
      button.addEventListener("click", () => {
        if (!state.room) return;
        socket.emit("game:bid", { roomId: state.room.id, bid: Number(button.dataset.bid) });
      });
    });
  } else if (game.phase === "discarding") {
    const discardPlayerName = players.find((player) => player.seat === game.currentTurn)?.name || "Player";
    const isMyDiscardTurn = game.currentTurn === state.mySeat;
    const me = players.find((player) => player.seat === state.mySeat);
    const myKittyCard = me?.kittyCard || null;
    const myPointCard = me?.pointCard || null;
    const canTakeKitty = isMyDiscardTurn && !myKittyCard;
    const canDiscard = isMyDiscardTurn && Boolean(myKittyCard) && !myPointCard;
    const discardButtons = (game.hand || []).map((cardCode) => `
      <button
        class="card-button"
        data-discard="${cardCode}"
        ${canDiscard ? "" : "disabled"}
        title="Discard ${cardCode} as your point card"
      >${cardCode}${cardCode === myKittyCard ? "<small> (kitty)</small>" : ""}</button>
    `).join("");
    const kittyButtons = Array.from({ length: game.kittyCount || 0 }, (_, index) => `
      <button
        class="card-button empty"
        data-kitty="${index}"
        ${canTakeKitty ? "" : "disabled"}
        title="Take this face-down kitty card"
      >?</button>
    `).join("");
    const kittyChoice = myKittyCard
      ? `<div class="card-button">${escapeHtml(myKittyCard)}</div>`
      : `<div class="discard-grid">${kittyButtons}</div>`;
    const pointChoice = myPointCard
      ? `<div class="discard-choice"><small>Your point card</small><div class="card-button">${escapeHtml(myPointCard)}</div></div>`
      : `<div class="discard-choice"><small>Discard (becomes your point card)</small><div class="discard-grid">${discardButtons}</div></div>`;
    const prompt = !isMyDiscardTurn
      ? `${escapeHtml(discardPlayerName)} is privately selecting a kitty card and discarding one card from hand.`
      : myKittyCard
        ? "Discard any card, including the kitty card you just took. The card you discard is your point card."
        : "Take one of the face-down kitty cards into your hand.";

    ui.bidPanel.innerHTML = `
      <div class="bid-controls discard-phase">
        <span class="muted">${prompt}</span>
        <div class="discard-pair">
          <div class="discard-choice">
            <small>Kitty card</small>
            ${kittyChoice}
          </div>
          ${pointChoice}
        </div>
      </div>
    `;

    ui.bidPanel.querySelectorAll("button[data-discard]").forEach((button) => {
      button.addEventListener("click", () => {
        if (!state.room) return;
        socket.emit("game:discard-card", { roomId: state.room.id, cardCode: button.dataset.discard });
      });
    });

    ui.bidPanel.querySelectorAll("button[data-kitty]").forEach((button) => {
      button.addEventListener("click", () => {
        if (!state.room) return;
        socket.emit("game:take-kitty", { roomId: state.room.id, kittyIndex: Number(button.dataset.kitty) });
      });
    });
  } else if (game.phase === "bid-adjustment") {
    const bidderName = players.find((player) => player.seat === game.currentBidder)?.name || "Player";
    const bidderLabel = isMyBidTurn ? "Adjust your bid" : `${escapeHtml(bidderName)} is adjusting their bid`;
    const adjustmentButtons = [
      { label: "-1", delta: -1 },
      { label: "0", delta: 0 },
      { label: "+1", delta: 1 },
    ].map(({ label, delta }) => `
      <button
        class="bid-button"
        data-adjust="${delta}"
        ${isMyBidTurn ? "" : "disabled"}
      >${label}</button>
    `).join("");

    ui.bidPanel.innerHTML = `
      <div class="bid-controls">
        <span class="muted">${escapeHtml(bidderLabel)}</span>
        ${adjustmentButtons}
      </div>
    `;

    ui.bidPanel.querySelectorAll("button[data-adjust]").forEach((button) => {
      button.addEventListener("click", () => {
        if (!state.room) return;
        socket.emit("game:adjust-bid", { roomId: state.room.id, delta: Number(button.dataset.adjust) });
      });
    });
  } else if (game.phase === "game-over") {
    const winnerNames = (game.winners || [])
      .map((seat) => players.find((player) => player.seat === seat)?.name || "Player")
      .map(escapeHtml)
      .join(" and ");
    ui.bidPanel.innerHTML = `
      <div class="bid-controls">
        <strong>Game over — ${winnerNames} ${(game.winners || []).length > 1 ? "win" : "wins"}!</strong>
        <span class="muted">Leave the room to start a new table.</span>
      </div>
    `;
  } else {
    ui.bidPanel.innerHTML = "";
  }

  if ((game.phase === "round-end" || game.phase === "game-over") && game.lastWinningCard) {
    const winnerCard = game.lastWinningCard;
    const suit = winnerCard.cardSuit || (winnerCard.cardCode === "JOKER" ? "♠" : winnerCard.cardCode.slice(-1));
    const rank = winnerCard.cardCode === "JOKER" ? (winnerCard.cardMode === "low" ? "LOW" : "HIGH") : winnerCard.cardCode.replace(/[♣♦♥♠]/g, "");
    const isRed = suit === "♥" || suit === "♦" || suit === "JOKER";
    ui.trickBoard.innerHTML = `
      <div class="trick-card highlight">
        <span class="meta">Winning card</span>
        <div class="card-button ${isRed ? "red" : ""} highlight" data-rank="${rank}" data-suit="${escapeHtml(suit)}" style="width: 54px; height: 72px; display: inline-flex; margin: 0 auto;">
          <span class="card-center" data-suit="${escapeHtml(suit)}"></span>
        </div>
        <small>${escapeHtml(winnerCard.playerName)} played ${escapeHtml(winnerCard.cardCode)}${winnerCard.cardCode === "JOKER" && winnerCard.cardMode ? ` (${winnerCard.cardMode} ${winnerCard.cardSuit})` : winnerCard.cardMode ? ` (${winnerCard.cardMode})` : ""}</small>
      </div>
    `;
  } else {
    const trickCards = (game.trick || []).map((entry) => {
      const suit = entry.cardSuit || (entry.cardCode === "JOKER" ? "♠" : entry.cardCode.slice(-1));
      const rank = entry.cardCode === "JOKER" ? (entry.cardMode === "low" ? "LOW" : "HIGH") : entry.cardCode.replace(/[♣♦♥♠]/g, "");
      const isRed = suit === "♥" || suit === "♦" || suit === "JOKER";
      const isWinner = game.phase === "trick-end" && entry.seat === game.trickWinnerSeat;
      return `
        <div class="trick-card ${isWinner ? "highlight" : ""}">
          <span class="meta">${escapeHtml(entry.playerName || "Player")}${isWinner ? " · wins" : ""}</span>
          <div class="card-button ${isRed ? "red" : ""} ${isWinner ? "highlight" : ""}" data-rank="${rank}" data-suit="${escapeHtml(suit)}" style="width: 54px; height: 72px; display: inline-flex; margin: 0 auto;">
            <span class="card-center" data-suit="${escapeHtml(suit)}"></span>
          </div>
        </div>
      `;
    });

    ui.trickBoard.innerHTML = trickCards.length ? trickCards.join("") : '<div class="trick-card"><span class="meta">No cards</span><div>Waiting</div></div>';
  }

  const myHand = game.hand || [];
  const isHumanTurn = game.currentTurn === state.mySeat && game.phase === "playing";

  ui.handCards.innerHTML = myHand.length
    ? myHand.map((cardCode) => {
        const suit = cardCode === "JOKER" ? "JOKER" : cardCode.slice(-1);
        const rank = cardCode === "JOKER" ? "JOKER" : cardCode.replace(/[♣♦♥♠]/g, "");
        const isRed = suit === "♥" || suit === "♦" || suit === "JOKER";
        return `
          <button
            class="card-button ${isRed ? "red" : ""}"
            data-code="${cardCode}"
            data-rank="${rank}"
            data-suit="${escapeHtml(suit)}"
            ${isHumanTurn ? "" : "disabled"}
            title="Play ${cardCode}"
          >
            <span class="card-center" data-suit="${escapeHtml(suit)}"></span>
          </button>
        `;
      }).join("")
    : '<div class="status-strip">No cards left.</div>';

  ui.handCards.querySelectorAll("button[data-code]").forEach((button) => {
    button.addEventListener("click", () => {
      if (!state.room) return;
      if (button.dataset.code === "JOKER" || button.dataset.rank === "A") {
        showJokerDialog(button.dataset.code);
        return;
      }
      socket.emit("game:play-card", { roomId: state.room.id, cardCode: button.dataset.code });
    });
  });
}

function showJokerDialog(cardCode) {
  const isJoker = cardCode === "JOKER";
  state.pendingJoker = { cardCode };
  ui.jokerTitle.textContent = isJoker ? "Play the joker high or low?" : `Play ${cardCode} high or low?`;
  ui.jokerSuitRow.classList.toggle("hidden", !isJoker);
  ui.jokerSuit.value = "♠";
  ui.jokerModal.classList.remove("hidden");
}

function hideJokerDialog() {
  state.pendingJoker = null;
  ui.jokerModal.classList.add("hidden");
}

function showLobby() {
  ui.lobbyView.classList.remove("hidden");
  ui.roomView.classList.add("hidden");
  ui.gameView.classList.add("hidden");
}

function showRoom() {
  ui.lobbyView.classList.add("hidden");
  ui.roomView.classList.remove("hidden");
  ui.gameView.classList.add("hidden");
}

function showGame() {
  ui.lobbyView.classList.add("hidden");
  ui.roomView.classList.add("hidden");
  ui.gameView.classList.remove("hidden");
}

function showToast(message, type = "info") {
  ui.toast.textContent = message;
  ui.toast.className = `toast ${type}`;
  ui.toast.classList.remove("hidden");

  clearTimeout(showToast.timeoutId);
  showToast.timeoutId = setTimeout(() => {
    ui.toast.classList.add("hidden");
  }, 2400);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

showLobby();
socket.emit("lobby:list");
