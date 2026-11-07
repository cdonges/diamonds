const test = require('node:test');
const assert = require('node:assert/strict');
const { validateBidTotal, bidWithAdjustment } = require('../src/game-rules');

test('final bid total cannot equal ten', () => {
  assert.equal(validateBidTotal({ 0: 3, 1: 3, 2: 4 }), false);
  assert.equal(validateBidTotal({ 0: 3, 1: 3, 2: 2 }), true);
});

test('bid adjustments must preserve the total rule', () => {
  assert.equal(bidWithAdjustment({ 0: 3, 1: 2, 2: 4 }, 2, 1), false);
  assert.equal(bidWithAdjustment({ 0: 3, 1: 3, 2: 2 }, 0, 1), true);
});

const { determineWinner, canPlayCard, getGameOutcome } = require('../src/game-rules');

const card = (rank, suit, extra = {}) => ({ code: `${rank}${suit}`, rank, suit, ...extra });
const joker = (selectedSuit, selectedMode) => ({ code: 'JOKER', rank: 'JOKER', suit: 'JOKER', selectedSuit, selectedMode });
const trick = (...cards) => cards.map((c, playerSeat) => ({ playerSeat, card: c }));

test('a diamond beats a higher card of the led suit', () => {
  const t = trick(card('A', '♠', { selectedMode: 'high' }), card('7', '♦'), card('K', '♠'));
  assert.equal(determineWinner(t, '♠').playerSeat, 1);
});

test('highest diamond wins when several are played', () => {
  const t = trick(card('9', '♣'), card('7', '♦'), card('Q', '♦'));
  assert.equal(determineWinner(t, '♣').playerSeat, 2);
});

test('off-suit non-trump cards cannot win', () => {
  const t = trick(card('7', '♥'), card('A', '♠', { selectedMode: 'high' }), card('8', '♥'));
  assert.equal(determineWinner(t, '♥').playerSeat, 2);
});

test('ace can be played high or low', () => {
  assert.equal(determineWinner(trick(card('K', '♥'), card('A', '♥', { selectedMode: 'high' })), '♥').playerSeat, 1);
  assert.equal(determineWinner(trick(card('7', '♥'), card('A', '♥', { selectedMode: 'low' })), '♥').playerSeat, 0);
});

test('joker is the highest or lowest card in its chosen suit', () => {
  assert.equal(determineWinner(trick(card('A', '♥', { selectedMode: 'high' }), joker('♥', 'high')), '♥').playerSeat, 1);
  assert.equal(determineWinner(trick(card('A', '♥', { selectedMode: 'low' }), joker('♥', 'low')), '♥').playerSeat, 0);
  assert.equal(determineWinner(trick(card('A', '♠', { selectedMode: 'high' }), joker('♦', 'low')), '♠').playerSeat, 1);
});

test('must follow suit, but an unplayed joker does not count as the led suit', () => {
  const hand = [card('8', '♠'), card('9', '♥')];
  assert.equal(canPlayCard(hand, hand[1], '♠'), false);
  assert.equal(canPlayCard(hand, hand[0], '♠'), true);
  const jokerHand = [{ code: 'JOKER', rank: 'JOKER', suit: 'JOKER' }, card('9', '♥')];
  assert.equal(canPlayCard(jokerHand, jokerHand[1], '♠'), true);
  assert.equal(canPlayCard(jokerHand, jokerHand[0], '♠'), true);
});

test('game ends at 100 or -100 and highest score wins', () => {
  assert.equal(getGameOutcome([{ seat: 0, score: 99 }, { seat: 1, score: -99 }]), null);
  assert.deepEqual(getGameOutcome([{ seat: 0, score: 104 }, { seat: 1, score: 20 }]).winners, [0]);
  const loss = getGameOutcome([{ seat: 0, score: -100 }, { seat: 1, score: 40 }, { seat: 2, score: 60 }]);
  assert.deepEqual(loss.winners, [2]);
  assert.equal(loss.reason, 'loss');
});

const { shouldCloseRoom, INACTIVITY_TIMEOUT_MS } = require('../src/server.js');

test('tables close after ten minutes of inactivity', () => {
  const now = Date.now();
  assert.equal(shouldCloseRoom({ lastActivity: now - INACTIVITY_TIMEOUT_MS - 1 }, now), true);
  assert.equal(shouldCloseRoom({ lastActivity: now - (INACTIVITY_TIMEOUT_MS - 1000) }, now), false);
});
