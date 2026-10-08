// Duel Arena on a page (notes/duel-arena.md): pick a premade deck or build
// one from every card of the game, then send it for this page's side. Both
// pages mount the same panel: the host's plays as player 1, the guest's as
// player 2. Decks people build are kept in this browser (localStorage).
import {
  ARENA_COPIES_MAX,
  ARENA_DECK_SIZE,
  deckCode,
  parseDeckCode,
  type ArenaCard,
  type PremadeDeck,
} from "../shared/arena.js";
import type { ArenaChoice, ArenaStatus } from "../shared/messages.js";

const SAVED_KEY = "duel-arena-decks";
const RESULTS_SHOWN = 60;

export interface ArenaPanel {
  update(status: ArenaStatus): void;
  error(message: string): void;
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  properties: Partial<HTMLElementTagNameMap[K]> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), properties);
  node.append(...children);
  return node;
}

function savedDecks(): Record<string, number[]> {
  try {
    const value = JSON.parse(localStorage.getItem(SAVED_KEY) ?? "{}") as unknown;
    return value && typeof value === "object" ? (value as Record<string, number[]>) : {};
  } catch {
    return {};
  }
}

function keepDecks(decks: Record<string, number[]>): void {
  try {
    localStorage.setItem(SAVED_KEY, JSON.stringify(decks));
  } catch {
    /* private window: the deck is not kept, and that is all */
  }
}

// The rules the companion checks too (cards.ts): forty, three of one, one
// of each Exodia piece.
export function deckProblem(ids: readonly number[], byId: ReadonlyMap<number, ArenaCard>): string | null {
  const counts = new Map<number, number>();
  for (const id of ids) {
    const card = byId.get(id);
    if (!card) return `Card ${id} is not one of the game's cards.`;
    const count = (counts.get(id) ?? 0) + 1;
    counts.set(id, count);
    if (count > ARENA_COPIES_MAX) return `${card.name}: at most ${ARENA_COPIES_MAX} copies.`;
    if (count > 1 && /Forbidden One|Exodia/.test(card.name)) return `${card.name}: one copy only.`;
  }
  if (ids.length !== ARENA_DECK_SIZE) return `${ids.length} of ${ARENA_DECK_SIZE} cards.`;
  return null;
}

export function mountArena(root: HTMLElement, mySide: 0 | 1, send: (choice: ArenaChoice) => void): ArenaPanel {
  let cards: ArenaCard[] = [];
  let premade: PremadeDeck[] = [];
  const byId = new Map<number, ArenaCard>();
  let deck: number[] = [];
  let available = false;
  let mine = { ready: false, deckName: "" };

  const status = [element("span", { className: "chip" }), element("span", { className: "chip" })];
  const premadeSelect = element("select", { id: "arena-premade" });
  const playPremade = element("button", { type: "button", id: "arena-play-premade", textContent: "Play this deck" });
  const premadeAbout = element("p", { className: "muted", id: "arena-premade-about" });
  const search = element("input", { id: "arena-search", type: "search", placeholder: "Search cards" });
  const kind = element("select", { id: "arena-kind" });
  for (const [value, label] of [
    ["all", "All cards"],
    ["monster", "Monsters"],
    ["Magic", "Magic"],
    ["Trap", "Traps"],
    ["Equip", "Equips"],
    ["Ritual", "Rituals"],
  ] as const) {
    kind.append(element("option", { value, textContent: label }));
  }
  const results = element("ul", { className: "arena-list", id: "arena-results" });
  const count = element("strong", { id: "arena-count" });
  const list = element("ul", { className: "arena-list", id: "arena-deck" });
  const name = element("input", { id: "arena-name", placeholder: "Deck name", maxLength: 40 });
  const playBuilt = element("button", { type: "button", className: "primary", id: "arena-play", textContent: "Play this deck" });
  const save = element("button", { type: "button", textContent: "Keep in this browser" });
  const clear = element("button", { type: "button", textContent: "Clear" });
  const savedSelect = element("select", { id: "arena-saved" });
  const load = element("button", { type: "button", textContent: "Open" });
  const code = element("input", { id: "arena-code", placeholder: "Deck code: forty card numbers" });
  const copy = element("button", { type: "button", textContent: "Copy code" });
  const paste = element("button", { type: "button", textContent: "Use code" });
  const takeBack = element("button", { type: "button", id: "arena-take-back", textContent: "Take my deck back", hidden: true });
  // The name the duel shows: the host types theirs; the guest's is the one
  // they joined with.
  const player = element("input", { id: "arena-player", placeholder: "Your name", maxLength: 24, value: "Host" });
  const note = element("p", { className: "hint", id: "arena-error" });

  root.replaceChildren(
    element("h2", { textContent: "Duel Arena" }),
    element("p", {
      className: "muted",
      textContent: `Choose a deck: any card of the game, up to ${ARENA_COPIES_MAX} copies. No save is needed. When both players are ready, the game goes to the duel by itself (with MEMORIES_ARENA=1) or the host picks 2P DUEL; the host starts it from the life points screen.`,
    }),
    element("div", { className: "row" }, ...status, takeBack),
    ...(mySide === 0 ? [element("div", { className: "row" }, element("label", {}, "Your name in the duel ", player))] : []),
    element("div", { className: "row" }, element("label", {}, "Premade ", premadeSelect), playPremade),
    premadeAbout,
    element(
      "details",
      { className: "arena-builder" },
      element("summary", { textContent: "Build your own" }),
      element("div", { className: "row" }, search, kind),
      element(
        "div",
        { className: "arena-columns" },
        element("div", {}, element("p", { className: "muted", textContent: "Cards (click to add)" }), results),
        element("div", {}, element("p", { className: "muted" }, "Your deck: ", count), list),
      ),
      element("div", { className: "row" }, name, playBuilt, save, clear),
      element("div", { className: "row" }, element("label", {}, "Kept decks ", savedSelect), load),
      element("div", { className: "row" }, code, copy, paste),
    ),
    note,
  );

  const describe = (card: ArenaCard) =>
    card.monster ? `${card.type} · ${card.attack}/${card.defense} · Lv ${card.level}` : card.type;

  function showDeck(): void {
    const counts = new Map<number, number>();
    for (const id of deck) counts.set(id, (counts.get(id) ?? 0) + 1);
    const rows = [...counts].sort((a, b) => (byId.get(b[0])?.attack ?? 0) - (byId.get(a[0])?.attack ?? 0));
    list.replaceChildren(
      ...rows.map(([id, copies]) => {
        const card = byId.get(id)!;
        const remove = element("button", { type: "button", textContent: "−", title: `Take one ${card.name} out` });
        remove.addEventListener("click", () => {
          deck.splice(deck.lastIndexOf(id), 1);
          showDeck();
        });
        return element("li", {}, remove, element("span", { textContent: `${copies}× ${card.name}` }), element("small", { textContent: describe(card) }));
      }),
    );
    const problem = deckProblem(deck, byId);
    count.textContent = `${deck.length}/${ARENA_DECK_SIZE}`;
    playBuilt.disabled = !available || !!problem;
    playBuilt.title = problem ?? "";
    code.value = deck.length ? deckCode(deck) : "";
  }

  function showResults(): void {
    const words = search.value.trim().toLowerCase();
    const wanted = kind.value;
    const found = cards.filter(
      (card) =>
        (!words || card.name.toLowerCase().includes(words) || card.type.toLowerCase() === words) &&
        (wanted === "all" || (wanted === "monster" ? card.monster : card.type === wanted)),
    );
    results.replaceChildren(
      ...found.slice(0, RESULTS_SHOWN).map((card) => {
        const add = element("button", { type: "button", textContent: "+", title: `Add ${card.name}` });
        add.addEventListener("click", () => {
          const copies = deck.filter((id) => id === card.id).length;
          if (deck.length >= ARENA_DECK_SIZE) return error(`The deck already has ${ARENA_DECK_SIZE} cards.`);
          if (copies >= ARENA_COPIES_MAX) return error(`${card.name}: at most ${ARENA_COPIES_MAX} copies.`);
          error("");
          deck.push(card.id);
          showDeck();
        });
        return element("li", {}, add, element("span", { textContent: card.name }), element("small", { textContent: describe(card) }));
      }),
    );
    if (found.length > RESULTS_SHOWN) {
      results.append(element("li", { className: "muted", textContent: `${found.length - RESULTS_SHOWN} more: narrow the search.` }));
    }
  }

  function showSaved(): void {
    const decks = savedDecks();
    savedSelect.replaceChildren(...Object.keys(decks).sort().map((key) => element("option", { value: key, textContent: key })));
    load.disabled = !savedSelect.options.length;
  }

  function showStatus(sides: ArenaStatus["sides"]): void {
    sides.forEach((side, i) => {
      const who = i === mySide ? `You (player ${i + 1})` : `Player ${i + 1}`;
      status[i]!.textContent = side.ready ? `${who}: ${side.deckName}` : `${who}: choosing`;
      status[i]!.dataset.state = side.ready ? "on" : "wait";
    });
  }

  function error(message: string): void {
    note.textContent = message;
  }

  function play(deckName: string, ids: number[]): void {
    const problem = deckProblem(ids, byId);
    if (problem) return error(problem);
    error("");
    send({ type: "arena-deck", name: deckName, cards: ids, player: player.value });
  }

  function showAbout(): void {
    premadeAbout.textContent = premade[Number(premadeSelect.value)]?.description ?? "";
  }
  premadeSelect.addEventListener("change", showAbout);

  playPremade.addEventListener("click", () => {
    const chosen = premade[Number(premadeSelect.value)];
    if (chosen) play(chosen.name, chosen.cards);
  });
  playBuilt.addEventListener("click", () => play(name.value.trim() || "My deck", deck));
  takeBack.addEventListener("click", () => send({ type: "arena-deck", name: "", cards: null }));
  search.addEventListener("input", showResults);
  kind.addEventListener("change", showResults);
  clear.addEventListener("click", () => {
    deck = [];
    showDeck();
  });
  save.addEventListener("click", () => {
    const key = name.value.trim() || "My deck";
    keepDecks({ ...savedDecks(), [key]: [...deck] });
    showSaved();
    savedSelect.value = key;
  });
  load.addEventListener("click", () => {
    const kept = savedDecks()[savedSelect.value];
    if (!kept) return;
    deck = kept.filter((id) => byId.has(id)).slice(0, ARENA_DECK_SIZE);
    name.value = savedSelect.value;
    showDeck();
  });
  copy.addEventListener("click", () => void navigator.clipboard?.writeText(code.value).catch(() => undefined));
  paste.addEventListener("click", () => {
    const ids = parseDeckCode(code.value);
    const problem = ids.length > ARENA_DECK_SIZE ? `${ids.length} cards: a deck is ${ARENA_DECK_SIZE}.` : null;
    if (problem) return error(problem);
    deck = ids.filter((id) => byId.has(id));
    error(deck.length === ids.length ? "" : "Some numbers are not cards of the game and were left out.");
    showDeck();
  });

  void fetch("/api/arena")
    .then((response) => response.json() as Promise<{ cards: ArenaCard[]; decks: PremadeDeck[] }>)
    .then((data) => {
      cards = data.cards;
      premade = data.decks;
      for (const card of cards) byId.set(card.id, card);
      premadeSelect.replaceChildren(
        ...premade.map((entry, i) => element("option", { value: String(i), textContent: entry.name })),
      );
      showAbout();
      playPremade.disabled = !available || !premade.length;
      showResults();
      showDeck();
      showSaved();
    })
    .catch(() => error("The card list could not be loaded."));

  showStatus([
    { ready: false, deckName: "" },
    { ready: false, deckName: "" },
  ]);

  return {
    update(message) {
      available = message.available;
      mine = message.sides[mySide];
      showStatus(message.sides);
      takeBack.hidden = !mine.ready;
      playPremade.disabled = !available || !premade.length;
      showDeck();
      if (!available) error("Duel Arena needs the game running with this branch (MEMORIES_REMOTE_PLAY=1).");
      else if (note.textContent?.startsWith("Duel Arena needs")) error("");
    },
    error,
  };
}
