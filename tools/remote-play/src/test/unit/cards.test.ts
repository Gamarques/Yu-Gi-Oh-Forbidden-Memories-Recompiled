import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { deckProblem, loadArena, parseCatalog, resolveDeck, splitCsvLine } from "../../server/cards.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const catalog = path.resolve(root, "../../notes/card-catalog.csv");

test("CSV fields with quotes and commas", () => {
  assert.deepEqual(splitCsvLine('449,"30,000-Year White Turtle",Aqua'), ["449", "30,000-Year White Turtle", "Aqua"]);
  assert.deepEqual(splitCsvLine('1,"say ""hi""",'), ["1", 'say "hi"', ""]);
});

test("the catalog parses", () => {
  const cards = parseCatalog(
    'id,name,type,attribute,level,guardian_star_1,guardian_star_2,attack,defense,password,starchip_cost\n' +
      "1,Blue-eyes White Dragon,Dragon,Light,8,Sun,Mars,3000,2500,89631139,999999\n" +
      "337,Raigeki,Magic,Magic,0,,,0,0,12580477,9999\n" +
      "999,Not a card,Dragon,Light,1,,,1,1,0,0\n",
  );
  assert.equal(cards.length, 2);
  assert.deepEqual(cards[0], {
    id: 1, name: "Blue-eyes White Dragon", type: "Dragon", attribute: "Light", level: 8,
    stars: ["Sun", "Mars"], attack: 3000, defense: 2500, monster: true,
  });
  assert.equal(cards[1]!.monster, false);
});

test("the deck rules and the premade decks", async () => {
  const arena = await loadArena(catalog, path.join(root, "decks"), (line) => assert.fail(line));
  assert.equal(arena.cards.length, 722);
  assert.equal(arena.cards.find((card) => card.id === 449)!.name, "30,000-Year White Turtle");
  assert.ok(arena.decks.length >= 4);
  for (const deck of arena.decks) assert.equal(deckProblem(deck.cards, arena.byId), null, deck.name);

  const forty = Array.from({ length: 40 }, (_, i) => 1 + Math.floor(i / 3));
  assert.equal(deckProblem(forty, arena.byId), null);
  assert.match(deckProblem(forty.slice(1), arena.byId)!, /40 cards/);
  assert.match(deckProblem([...forty.slice(1), 2], arena.byId)!, /at most 3/);
  assert.match(deckProblem([...forty.slice(1), 723], arena.byId)!, /not one of the game's cards/);
  // Each Exodia piece once (17 to 21).
  const exodia = [17, 17, ...forty.slice(2)];
  assert.match(deckProblem(exodia, arena.byId)!, /one copy only/);
  assert.equal(deckProblem("1,2,3", arena.byId), "A deck is 40 cards.");

  const byName = new Map(arena.cards.map((card) => [card.name.toLowerCase(), card]));
  assert.throws(() => resolveDeck({ name: "x", cards: { "No such card": 40 } }, byName, arena.byId), /no card named/);
  assert.throws(() => resolveDeck({ name: "x", cards: { "Dark Hole": 40 } }, byName, arena.byId), /at most 3/);
});
