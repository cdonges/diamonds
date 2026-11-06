// AI decision making for Diamonds, at three skill levels.
//
//   easy   - rough guesses and frequent random plays
//   medium - estimates its hand, then plays to win tricks until it has its bid
//            and to lose tricks after that
//   hard   - looks ahead: for each choice (bid, discard, adjustment, card) it
//            deals the unseen cards at random many times, plays the hand out
//            and picks the choice most likely to land exactly on its bid. It
//            remembers the cards played and which suits players are out of,
//            and values its point card by its chance of making the bid
//
// The AI only ever sees what a human in its seat could see: its own hand, its
// own point card, the bids, the tricks won and the cards played so far.

const { determineWinner, getCardSuitForPlay, canPlayCard, TRUMP_SUIT } = require("./game-rules");

const LEVELS = ["easy", "medium", "hard"];
const DEFAULT_LEVEL = "medium";
const SUITS = ["♣", "♦", "♥", "♠"];
const RANKS = ["7", "8", "9", "10", "J", "Q", "K", "A"];
const RANK_VALUE = { "7": 7, "8": 8, "9": 9, "10": 10, "J": 11, "Q": 12, "K": 13, "A": 14 };
const POINT_VALUE = { "7": 7, "8": 8, "9": 9, "10": 10, "J": 11, "Q": 12, "K": 13, "A": 15, "JOKER": 20 };

function normalizeLevel(level) {
  return LEVELS.includes(level) ? level : DEFAULT_LEVEL;
}

function randomOf(items, random) {
  return items[Math.floor(random() * items.length)];
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function pointValue(card) {
  return card.value ?? POINT_VALUE[card.rank] ?? 0;
}

// ---------------------------------------------------------------------------
// Hand evaluation
// ---------------------------------------------------------------------------

// Rough number of tricks a hand should take.
function handStrength(hand, level = DEFAULT_LEVEL) {
  const bySuit = { "♣": [], "♦": [], "♥": [], "♠": [] };
  let estimate = 0;

  for (const card of hand) {
    if (card.code === "JOKER") {
      estimate += 1; // played high as a diamond it cannot lose
    } else {
      bySuit[card.suit].push(card);
    }
  }

  const trumps = bySuit[TRUMP_SUIT];
  const trumpValue = { A: 1, K: 0.9, Q: 0.7, J: 0.5, "10": 0.4 };
  for (const card of trumps) {
    estimate += trumpValue[card.rank] ?? 0.3;
  }
  if (trumps.length > 3) {
    estimate += (trumps.length - 3) * 0.3;
  }

  let ruffBonus = 0;
  for (const suit of SUITS) {
    if (suit === TRUMP_SUIT) continue;
    const cards = bySuit[suit];
    const length = cards.length;
    for (const card of cards) {
      if (card.rank === "A") estimate += length <= 5 ? 0.85 : 0.6;
      else if (card.rank === "K") estimate += length >= 2 ? 0.55 : 0.2;
      else if (card.rank === "Q") estimate += length >= 3 ? 0.3 : 0.1;
    }
    if (level === "hard" && trumps.length >= 2) {
      if (length === 0) ruffBonus += 0.6;
      else if (length === 1) ruffBonus += 0.3;
    }
  }

  return estimate + Math.min(ruffBonus, trumps.length * 0.5);
}

// Hard players shade their estimate when the other bids already claim most of
// the tricks (or leave a lot unclaimed).
function tableAdjustedStrength(view, level) {
  let estimate = handStrength(view.hand, level);
  if (level !== "hard") return estimate;

  const otherBids = Object.entries(view.bids || {})
    .filter(([seat]) => Number(seat) !== view.seat)
    .map(([, bid]) => Number(bid) || 0);
  if (!otherBids.length) return estimate;

  const unbidPlayers = Math.max(0, (view.playerCount || 3) - 1 - otherBids.length);
  const expectedOthers = otherBids.reduce((sum, bid) => sum + bid, 0) + unbidPlayers * 3.3;
  const pressure = expectedOthers + estimate - 10;
  estimate -= clamp(pressure * 0.25, -1, 1);
  return Math.max(0, estimate);
}

// ---------------------------------------------------------------------------
// Bidding
// ---------------------------------------------------------------------------

// view: { hand, bids, seat, playerCount }
function chooseBid(level, view, random = Math.random) {
  level = normalizeLevel(level);
  if (level === "hard" && view.unseen) {
    const estimate = Math.round(tableAdjustedStrength(view, level));
    const candidates = [];
    for (let bid = Math.max(0, estimate - 2); bid <= Math.min(10, estimate + 2); bid += 1) candidates.push(bid);
    return Number(bestBid(makeChances(view, view.hand, candidates, random)));
  }
  let estimate = tableAdjustedStrength(view, level);
  if (level === "easy") {
    estimate += (random() - 0.5) * 3;
  }
  return clamp(Math.round(estimate), 0, 10);
}

// Returns the preferred change to the bid: -1, 0 or +1.
// view: { hand, bids, seat, playerCount }
function chooseBidAdjustment(level, view, random = Math.random) {
  level = normalizeLevel(level);
  if (level === "easy") {
    return randomOf([-1, 0, 1], random);
  }
  const bid = Number(view.bids?.[view.seat] ?? 0) || 0;
  if (level === "hard" && view.unseen) {
    const options = [bid - 1, bid, bid + 1].filter((value) => value >= 0 && value <= 10);
    return Number(bestBid(makeChances(view, view.hand, options, random))) - bid;
  }
  const estimate = tableAdjustedStrength(view, level);
  return clamp(Math.round(estimate - bid), -1, 1);
}

// ---------------------------------------------------------------------------
// Discarding (the discarded card is the point card)
// ---------------------------------------------------------------------------

// view: { hand (including the kitty card), bids, seat, playerCount }
function chooseDiscard(level, view, random = Math.random) {
  level = normalizeLevel(level);
  const hand = view.hand;
  if (!hand.length) return null;
  if (level === "easy") {
    return randomOf(hand, random);
  }

  const bid = Number(view.bids?.[view.seat] ?? 0) || 0;
  let best = null;
  let bestScore = -Infinity;

  if (level === "hard" && view.unseen) {
    // The bid can still move by one after discarding. Expected score for a
    // discard = point value x (chance of making the best reachable bid x 2 - 1).
    const reachable = [bid - 1, bid, bid + 1].filter((value) => value >= 0 && value <= 10);
    for (const card of hand) {
      const rest = hand.filter((entry) => entry !== card);
      const chances = makeChances({ ...view, unseen: view.unseen.filter((entry) => entry.code !== card.code) }, rest, reachable, random, 24);
      const chance = Math.max(...Object.values(chances));
      const score = pointValue(card) * (2 * chance - 1);
      if (score > bestScore) {
        bestScore = score;
        best = card;
      }
    }
    return best;
  }

  for (const card of hand) {
    const rest = hand.filter((entry) => entry !== card);
    const estimate = tableAdjustedStrength({ ...view, hand: rest }, level);

    let score;
    if (level === "medium") {
      // Keep the hand that best fits the bid; prefer a cheap point card.
      score = -Math.abs(estimate - bid) - pointValue(card) * 0.01;
    } else {
      // The bid can still move by one, so aim for the closest reachable bid,
      // then weigh the point card's value by the chance of making it.
      const target = clamp(Math.round(estimate), bid - 1, bid + 1);
      const miss = Math.abs(estimate - target);
      const chance = clamp(0.7 - miss * 0.35, 0.1, 0.85);
      score = pointValue(card) * (2 * chance - 1);
    }

    if (score > bestScore) {
      bestScore = score;
      best = card;
    }
  }

  return best;
}

// ---------------------------------------------------------------------------
// Card play
// ---------------------------------------------------------------------------

// Every legal way to play each legal card (aces high/low, joker in any suit).
function playOptions(hand, leadSuit) {
  const options = [];
  for (const card of hand) {
    if (!canPlayCard(hand, card, leadSuit)) continue;
    if (card.code === "JOKER") {
      for (const suit of SUITS) {
        for (const mode of ["high", "low"]) {
          options.push({ card, selection: { jokerSuit: suit, jokerMode: mode } });
        }
      }
    } else if (card.rank === "A") {
      options.push({ card, selection: { aceMode: "high" } });
      options.push({ card, selection: { aceMode: "low" } });
    } else {
      options.push({ card, selection: {} });
    }
  }
  return options;
}

function asPlayed(option) {
  const { card, selection } = option;
  if (card.code === "JOKER") {
    return { ...card, selectedSuit: selection.jokerSuit, selectedMode: selection.jokerMode };
  }
  if (card.rank === "A") {
    return { ...card, selectedMode: selection.aceMode };
  }
  return card;
}

// How much a card is worth keeping: a rough measure of its trick-taking power.
function cardCost(card) {
  if (card.code === "JOKER") return 30;
  return RANK_VALUE[card.rank] + (card.suit === TRUMP_SUIT ? 10 : 0);
}

function winsTrickNow(option, view) {
  const played = asPlayed(option);
  const trick = [...view.trick, { playerSeat: view.seat, card: played }];
  const leadSuit = view.leadSuit || getCardSuitForPlay(played);
  return determineWinner(trick, leadSuit).playerSeat === view.seat;
}

function lowestBy(options, fn) {
  return options.reduce((best, option) => (fn(option) < fn(best) ? option : best));
}

function highestBy(options, fn) {
  return options.reduce((best, option) => (fn(option) > fn(best) ? option : best));
}

const cost = (option) => cardCost(option.card);
const keepJoker = (options) => {
  const withoutJoker = options.filter((option) => option.card.code !== "JOKER");
  return withoutJoker.length ? withoutJoker : options;
};

function playMedium(options, view, wantToWin) {
  const leading = view.trick.length === 0;
  const winners = options.filter((option) => winsTrickNow(option, view));
  const losers = options.filter((option) => !winsTrickNow(option, view));

  if (wantToWin) {
    if (leading) return highestBy(options, (o) => cost(o) + (o.selection.jokerMode === "high" && o.selection.jokerSuit === TRUMP_SUIT ? 1 : 0));
    if (winners.length) return lowestBy(winners, cost);
    return lowestBy(keepJoker(options), cost);
  }

  if (leading) return lowestBy(keepJoker(options), (o) => cost(o) + (o.selection.aceMode === "high" ? 1 : 0));
  if (losers.length) return highestBy(keepJoker(losers), cost);
  return highestBy(options, cost);
}

// --- Hard: look-ahead search ----------------------------------------------
//
// For each possible play, deal the unseen cards to the other players at random
// (respecting suits they have shown they are out of), play the rest of the hand
// out with medium-level play for everyone, and count how often this player ends
// on exactly its bid. The play with the best record is chosen.

const DEFAULT_SAMPLES = 60;
const PRE_PLAY_SAMPLES = 40;

function shuffled(items, random) {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [result[index], result[swap]] = [result[swap], result[index]];
  }
  return result;
}

// Suits each player is known to be out of: they failed to follow when it was led.
function knownVoids(history) {
  const voids = {};
  for (const play of history || []) {
    if (!play.leadSuit) continue;
    const suit = getCardSuitForPlay(play.card);
    if (play.card.code !== "JOKER" && suit !== play.leadSuit) {
      (voids[play.seat] ||= new Set()).add(play.leadSuit);
    }
  }
  return voids;
}

function seatsInOrder(view) {
  return Array.from({ length: view.playerCount }, (_, index) => index);
}

function nextSeat(seat, playerCount) {
  return (seat + 1) % playerCount;
}

// Deal the unseen cards to the other players for one simulated layout.
function sampleHands(view, voids, random) {
  const handSize = view.hand.length;
  const playedThisTrick = new Set(view.trick.map((entry) => entry.playerSeat));
  const others = seatsInOrder(view).filter((seat) => seat !== view.seat);

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const pool = shuffled(view.unseen, random);
    const hands = { [view.seat]: view.hand };
    let ok = true;

    for (const seat of others) {
      const size = playedThisTrick.has(seat) ? handSize - 1 : handSize;
      const blocked = attempt < 19 ? voids[seat] : null;
      const hand = [];
      for (let index = 0; index < pool.length && hand.length < size; ) {
        const card = pool[index];
        if (blocked && card.code !== "JOKER" && blocked.has(card.suit)) {
          index += 1;
          continue;
        }
        hand.push(card);
        pool.splice(index, 1);
      }
      if (hand.length < size) {
        ok = false;
        break;
      }
      hands[seat] = hand;
    }
    if (ok) return hands;
  }
  return null;
}

// Play the rest of the hand with medium-level play; returns tricks won per seat.
// state: { playerCount, bids, allTricksWon, trick, leadSuit, seat (to play next) }
function rollout(state, hands, firstPlay = null) {
  const view = state;
  const tricksWon = { ...(state.allTricksWon || {}) };
  const remaining = {};
  for (const [seat, hand] of Object.entries(hands)) remaining[seat] = [...hand];

  let trick = [...(state.trick || [])];
  let leadSuit = state.leadSuit || null;
  let seat = state.seat;
  let forced = firstPlay;

  while (remaining[seat] && remaining[seat].length) {
    const hand = remaining[seat];
    let option = forced;
    forced = null;
    if (!option) {
      const options = playOptions(hand, leadSuit);
      const need = (Number(view.bids?.[seat]) || 0) - (tricksWon[seat] || 0);
      option = playMedium(options, { seat, trick, leadSuit }, need > 0);
    }

    const played = asPlayed(option);
    remaining[seat] = hand.filter((card) => card !== option.card);
    trick = [...trick, { playerSeat: seat, card: played }];
    if (!leadSuit) leadSuit = getCardSuitForPlay(played);

    if (trick.length === view.playerCount) {
      const winner = determineWinner(trick, leadSuit).playerSeat;
      tricksWon[winner] = (tricksWon[winner] || 0) + 1;
      trick = [];
      leadSuit = null;
      seat = winner;
    } else {
      seat = nextSeat(seat, view.playerCount);
    }
  }
  return tricksWon;
}

// Ace and joker variants that can never differ are pruned to keep the search fast.
function distinctOptions(options, view) {
  const seen = new Set();
  return options.filter((option) => {
    const { card, selection } = option;
    if (card.code !== "JOKER") return true;
    const suit = selection.jokerSuit;
    // Any off-suit, non-trump joker behaves the same way.
    const kind = suit === TRUMP_SUIT || suit === view.leadSuit || !view.leadSuit ? suit : "off";
    const key = `${kind}-${selection.jokerMode}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Deal the cards this player cannot see to the others for a whole hand (before
// any card is played). Every other player ends up with as many cards as we do.
function samplePrePlayHands(view, hand, random) {
  const pool = shuffled(view.unseen, random);
  const hands = { [view.seat]: hand };
  for (const seat of seatsInOrder(view)) {
    if (seat === view.seat) continue;
    hands[seat] = pool.splice(0, 10);
  }
  return hands;
}

// Chance of taking exactly `myBid` tricks with `hand`, over simulated deals.
// Other players' bids are used when known and otherwise estimated.
function makeChances(view, hand, myBids, random, samples = PRE_PLAY_SAMPLES) {
  const made = Object.fromEntries(myBids.map((bid) => [bid, 0]));
  const leader = view.leaderSeat ?? nextSeat(view.seat, view.playerCount);

  for (let index = 0; index < samples; index += 1) {
    const hands = samplePrePlayHands(view, hand, random);
    const bids = {};
    for (const seat of seatsInOrder(view)) {
      if (seat === view.seat) continue;
      bids[seat] = view.bids?.[seat] ?? clamp(Math.round(handStrength(hands[seat], "medium")), 0, 10);
    }
    for (const myBid of myBids) {
      const tricks = rollout({ playerCount: view.playerCount, bids: { ...bids, [view.seat]: myBid }, seat: leader }, hands)[view.seat] || 0;
      if (tricks === myBid) made[myBid] += 1;
    }
  }

  return Object.fromEntries(myBids.map((bid) => [bid, made[bid] / samples]));
}

function bestBid(chances) {
  return Object.entries(chances).reduce((best, entry) => (entry[1] > best[1] ? entry : best))[0];
}

function playHard(options, view, wantToWin, random) {
  const candidates = distinctOptions(options, view);
  if (candidates.length === 1 || !view.unseen) return candidates[0] || playMedium(options, view, wantToWin);

  const samples = view.samples || DEFAULT_SAMPLES;
  const voids = knownVoids(view.history);
  const bid = Number(view.bid) || 0;
  const deals = [];
  for (let index = 0; index < samples; index += 1) {
    const hands = sampleHands(view, voids, random);
    if (hands) deals.push(hands);
  }
  if (!deals.length) return playMedium(options, view, wantToWin);

  let best = null;
  let bestScore = -Infinity;
  for (const option of candidates) {
    let made = 0;
    let closeness = 0;
    for (const hands of deals) {
      const tricks = rollout(view, hands, option)[view.seat] || 0;
      if (tricks === bid) made += 1;
      closeness -= Math.abs(tricks - bid);
    }
    // Making the bid is what counts; closeness and keeping strong cards break ties.
    const score = made * 1000 + closeness - cardCost(option.card) * 0.01;
    if (score > bestScore) {
      bestScore = score;
      best = option;
    }
  }
  return best;
}

// view: { hand, seat, trick, leadSuit, bid, tricksWon, playersAfter, playerCount, unseen }
// Returns { card, selection } ready for playCard.
function choosePlay(level, view, random = Math.random) {
  level = normalizeLevel(level);
  const options = playOptions(view.hand, view.leadSuit);
  if (!options.length) return null;

  const need = (Number(view.bid) || 0) - (Number(view.tricksWon) || 0);
  const wantToWin = need > 0;

  if (level === "easy") {
    // Half the time it plays sensibly, the rest of the time at random.
    return random() < 0.5 ? randomOf(options, random) : playMedium(options, view, wantToWin);
  }
  if (level === "hard") {
    return playHard(options, view, wantToWin, random);
  }
  return playMedium(options, view, wantToWin);
}

// Every card in the pack, for working out which cards are still unseen.
function fullDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ code: `${rank}${suit}`, rank, suit, value: POINT_VALUE[rank] });
    }
  }
  deck.push({ code: "JOKER", rank: "JOKER", suit: "JOKER", value: POINT_VALUE.JOKER });
  return deck;
}

function unseenCards(known) {
  const knownCodes = new Set(known.filter(Boolean).map((card) => card.code));
  return fullDeck().filter((card) => !knownCodes.has(card.code));
}

module.exports = {
  LEVELS,
  DEFAULT_LEVEL,
  normalizeLevel,
  handStrength,
  chooseBid,
  chooseBidAdjustment,
  chooseDiscard,
  choosePlay,
  unseenCards,
};
