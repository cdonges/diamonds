const test = require('node:test');
const assert = require('node:assert/strict');
const ai = require('../ai');
const { canPlayCard } = require('../game-rules');

const SUITS = ['♣', '♦', '♥', '♠'];
const RANKS = ['7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const VALUES = { 7: 7, 8: 8, 9: 9, 10: 10, J: 11, Q: 12, K: 13, A: 15 };

function shuffledDeck(random) {
  const deck = [];
  for (const suit of SUITS) for (const rank of RANKS) deck.push({ code: rank + suit, rank, suit, value: VALUES[rank] });
  deck.push({ code: 'JOKER', rank: 'JOKER', suit: 'JOKER', value: 20 });
  for (let i = deck.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

// Small deterministic random generator so the tests are repeatable.
function seeded(seed) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

test('unknown or missing levels default to medium', () => {
  assert.equal(ai.DEFAULT_LEVEL, 'medium');
  assert.equal(ai.normalizeLevel(undefined), 'medium');
  assert.equal(ai.normalizeLevel('genius'), 'medium');
  assert.equal(ai.normalizeLevel('hard'), 'hard');
});

test('every level bids 0-10 and discards a card from its hand', () => {
  const random = seeded(7);
  for (const level of ai.LEVELS) {
    for (let round = 0; round < 5; round += 1) {
      const deck = shuffledDeck(random);
      const hand = deck.slice(0, 11);
      const view = { seat: 0, hand: hand.slice(0, 10), bids: {}, playerCount: 3, leaderSeat: 1, unseen: ai.unseenCards(hand.slice(0, 10)) };
      const bid = ai.chooseBid(level, view, random);
      assert.ok(Number.isInteger(bid) && bid >= 0 && bid <= 10, `${level} bid ${bid}`);

      const discardView = { ...view, hand, bids: { 0: bid }, unseen: ai.unseenCards(hand) };
      const discard = ai.chooseDiscard(level, discardView, random);
      assert.ok(hand.includes(discard), `${level} discarded a card it does not hold`);

      const delta = ai.chooseBidAdjustment(level, { ...discardView, hand: hand.filter((card) => card !== discard) }, random);
      assert.ok([-1, 0, 1].includes(delta), `${level} adjustment ${delta}`);
    }
  }
});

test('every level only makes legal plays, with a valid joker suit and ace mode', () => {
  const random = seeded(42);
  for (const level of ai.LEVELS) {
    for (let round = 0; round < 10; round += 1) {
      const deck = shuffledDeck(random);
      const hand = deck.slice(0, 6);
      const led = deck[6].code === 'JOKER' ? deck[7] : deck[6];
      const trick = [{ playerSeat: 2, card: led }];
      const view = {
        seat: 0, hand, trick, leadSuit: led.suit, bid: 2, tricksWon: 1, bids: { 0: 2, 1: 3, 2: 4 },
        allTricksWon: { 0: 1, 1: 1, 2: 2 }, playerCount: 3, playersAfter: 1, history: [],
        unseen: ai.unseenCards([...hand, led]).slice(0, 12), samples: 8,
      };
      const choice = ai.choosePlay(level, view, random);
      assert.ok(hand.includes(choice.card), `${level} played a card it does not hold`);
      assert.ok(canPlayCard(hand, choice.card, led.suit), `${level} failed to follow suit`);
      if (choice.card.code === 'JOKER') {
        assert.ok(SUITS.includes(choice.selection.jokerSuit));
        assert.ok(['high', 'low'].includes(choice.selection.jokerMode));
      }
      if (choice.card.rank === 'A') {
        assert.ok(['high', 'low'].includes(choice.selection.aceMode));
      }
    }
  }
});

test('medium and hard take a trick they need when they can win it last to play', () => {
  const hand = [
    { code: 'K♠', rank: 'K', suit: '♠', value: 13 },
    { code: '7♠', rank: '7', suit: '♠', value: 7 },
  ];
  const trick = [
    { playerSeat: 1, card: { code: '9♠', rank: '9', suit: '♠', value: 9 } },
    { playerSeat: 2, card: { code: 'Q♠', rank: 'Q', suit: '♠', value: 12 } },
  ];
  for (const level of ['medium', 'hard']) {
    const view = {
      seat: 0, hand, trick, leadSuit: '♠', bid: 1, tricksWon: 0, bids: { 0: 1, 1: 0, 2: 1 },
      allTricksWon: { 0: 0, 1: 0, 2: 1 }, playerCount: 3, playersAfter: 0, history: [],
      unseen: ai.unseenCards([...hand, ...trick.map((entry) => entry.card)]), samples: 10,
    };
    assert.equal(ai.choosePlay(level, view, seeded(1)).card.code, 'K♠', level);
  }
});

test('medium and hard duck a trick they do not want when last to play', () => {
  const hand = [
    { code: 'K♠', rank: 'K', suit: '♠', value: 13 },
    { code: '7♠', rank: '7', suit: '♠', value: 7 },
  ];
  const trick = [
    { playerSeat: 1, card: { code: '9♠', rank: '9', suit: '♠', value: 9 } },
    { playerSeat: 2, card: { code: '8♠', rank: '8', suit: '♠', value: 8 } },
  ];
  for (const level of ['medium', 'hard']) {
    const view = {
      seat: 0, hand, trick, leadSuit: '♠', bid: 0, tricksWon: 0, bids: { 0: 0, 1: 2, 2: 1 },
      allTricksWon: { 0: 0, 1: 1, 2: 1 }, playerCount: 3, playersAfter: 0, history: [],
      unseen: ai.unseenCards([...hand, ...trick.map((entry) => entry.card)]), samples: 10,
    };
    assert.equal(ai.choosePlay(level, view, seeded(1)).card.code, '7♠', level);
  }
});
