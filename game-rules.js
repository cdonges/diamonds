const TRUMP_SUIT = "♦";
const WIN_SCORE = 100;
const LOSE_SCORE = -100;

// Trick-taking strength. Ranks keep their usual order; the ace may be played
// high (above the king) or low (below the 7); the joker may be played as the
// highest or lowest card in the pack.
const PLAY_RANK = { "7": 7, "8": 8, "9": 9, "10": 10, "J": 11, "Q": 12, "K": 13 };
const ACE_HIGH = 14;
const ACE_LOW = 6;
const JOKER_HIGH = 15;
const JOKER_LOW = 5;

function validateBidTotal(bids) {
  const total = Object.values(bids || {}).reduce((sum, raw) => {
    const value = Number(raw) || 0;
    return sum + value;
  }, 0);

  return total !== 10;
}

function bidWithAdjustment(bids, seat, delta) {
  const current = Number(bids?.[seat] ?? 0) || 0;
  const nextBid = clampBid(current + (Number(delta) || 0));
  const next = { ...(bids || {}), [seat]: nextBid };
  return validateBidTotal(next);
}

function clampBid(value) {
  return Math.min(10, Math.max(0, Number(value) || 0));
}

function getCardSuitForPlay(card) {
  if (!card) return null;
  if (card.code === "JOKER") {
    return card.selectedSuit || null;
  }
  return card.suit || null;
}

function getCardValueForPlay(card) {
  if (!card) return 0;
  if (card.code === "JOKER") {
    return card.selectedMode === "low" ? JOKER_LOW : JOKER_HIGH;
  }
  if (card.rank === "A") {
    return card.selectedMode === "low" ? ACE_LOW : ACE_HIGH;
  }
  return PLAY_RANK[card.rank] || 0;
}

// Returns true when `candidate` beats the current best card of the trick.
function beats(candidate, best, ledSuit) {
  const candidateSuit = getCardSuitForPlay(candidate);
  const bestSuit = getCardSuitForPlay(best);

  if (candidateSuit === bestSuit) {
    return getCardValueForPlay(candidate) > getCardValueForPlay(best);
  }
  if (candidateSuit === TRUMP_SUIT) return true;
  if (bestSuit === TRUMP_SUIT) return false;
  // Neither is a trump and the suits differ: only the led suit can win.
  return candidateSuit === ledSuit && bestSuit !== ledSuit;
}

function determineWinner(trick, ledSuit) {
  let best = trick[0];
  for (let index = 1; index < trick.length; index += 1) {
    if (beats(trick[index].card, best.card, ledSuit)) {
      best = trick[index];
    }
  }
  return best;
}

// Players must follow the led suit if they can. The joker may always be
// played (its suit is chosen when played), and an unplayed joker does not
// count as holding the led suit.
function canPlayCard(hand, card, leadSuit) {
  if (!leadSuit || card.code === "JOKER") return true;
  if (card.suit === leadSuit) return true;
  return !hand.some((entry) => entry.code !== "JOKER" && entry.suit === leadSuit);
}

// Returns null while the game continues, otherwise { winners: [seat...], reason }.
function getGameOutcome(players) {
  const reachedWin = players.some((player) => player.score >= WIN_SCORE);
  const reachedLoss = players.some((player) => player.score <= LOSE_SCORE);
  if (!reachedWin && !reachedLoss) return null;

  const best = Math.max(...players.map((player) => player.score));
  return {
    winners: players.filter((player) => player.score === best).map((player) => player.seat),
    reason: reachedWin ? "win" : "loss",
  };
}

module.exports = {
  TRUMP_SUIT,
  validateBidTotal,
  bidWithAdjustment,
  clampBid,
  getCardSuitForPlay,
  getCardValueForPlay,
  determineWinner,
  canPlayCard,
  getGameOutcome,
};
