// Duel Arena (notes/duel-arena.md): the cards a deck may hold, the rules a
// deck must keep, and the premade decks. The catalog is the disc's 722
// cards as notes/card-catalog.csv lists them (names and numbers, no art).
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { ARENA_CARD_MAX, ARENA_COPIES_MAX, ARENA_DECK_SIZE, type ArenaCard, type PremadeDeck } from "../shared/arena.js";

const NOT_MONSTERS = new Set(["Magic", "Trap", "Equip", "Ritual"]);

// One CSV line: commas separate, double quotes hold commas ("30,000-Year
// White Turtle"), and a doubled quote is a quote.
export function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ",") {
      fields.push(field);
      field = "";
    } else {
      field += c;
    }
  }
  fields.push(field);
  return fields;
}

export function parseCatalog(text: string): ArenaCard[] {
  const [header, ...lines] = text.split(/\r?\n/).filter((line) => line.trim());
  const columns = splitCsvLine(header ?? "");
  const at = (name: string) => {
    const index = columns.indexOf(name);
    if (index < 0) throw new Error(`card catalog: no "${name}" column`);
    return index;
  };
  const id = at("id"), name = at("name"), type = at("type"), attribute = at("attribute"), level = at("level");
  const star1 = at("guardian_star_1"), star2 = at("guardian_star_2"), attack = at("attack"), defense = at("defense");
  return lines
    .map((line) => splitCsvLine(line))
    .map((f) => ({
      id: Number(f[id]),
      name: f[name] ?? "",
      type: f[type] ?? "",
      attribute: f[attribute] ?? "",
      level: Number(f[level]) || 0,
      stars: [f[star1] ?? "", f[star2] ?? ""].filter(Boolean),
      attack: Number(f[attack]) || 0,
      defense: Number(f[defense]) || 0,
      monster: !NOT_MONSTERS.has(f[type] ?? ""),
    }))
    .filter((card) => Number.isInteger(card.id) && card.id >= 1 && card.id <= ARENA_CARD_MAX);
}

// The Build Deck rules the arena keeps: forty known cards, at most three of
// one, and each piece of Exodia once.
export function deckProblem(ids: unknown, byId: ReadonlyMap<number, ArenaCard>): string | null {
  if (!Array.isArray(ids) || ids.length !== ARENA_DECK_SIZE) return `A deck is ${ARENA_DECK_SIZE} cards.`;
  const counts = new Map<number, number>();
  for (const id of ids) {
    const card = Number.isInteger(id) ? byId.get(id as number) : undefined;
    if (!card) return `Card ${String(id)} is not one of the game's cards.`;
    const count = (counts.get(card.id) ?? 0) + 1;
    counts.set(card.id, count);
    if (count > ARENA_COPIES_MAX) return `${card.name}: at most ${ARENA_COPIES_MAX} copies.`;
    if (count > 1 && /Forbidden One|Exodia/.test(card.name)) return `${card.name}: one copy only.`;
  }
  return null;
}

// A premade deck file: {"name", "description", "cards": {"Card name": copies}}.
export function resolveDeck(
  file: { name?: unknown; description?: unknown; cards?: unknown },
  byName: ReadonlyMap<string, ArenaCard>,
  byId: ReadonlyMap<number, ArenaCard>,
): PremadeDeck {
  if (typeof file.name !== "string" || !file.name) throw new Error("no name");
  if (!file.cards || typeof file.cards !== "object") throw new Error("no cards");
  const ids: number[] = [];
  for (const [name, copies] of Object.entries(file.cards as Record<string, unknown>)) {
    const card = byName.get(name.toLowerCase());
    if (!card) throw new Error(`no card named "${name}"`);
    if (!Number.isInteger(copies) || (copies as number) < 1) throw new Error(`${name}: copies must be a whole number`);
    for (let i = 0; i < (copies as number); i++) ids.push(card.id);
  }
  const problem = deckProblem(ids, byId);
  if (problem) throw new Error(problem);
  return { name: file.name, description: typeof file.description === "string" ? file.description : "", cards: ids };
}

export interface Arena {
  cards: ArenaCard[];
  byId: Map<number, ArenaCard>;
  decks: PremadeDeck[];
}

export async function loadArena(catalogPath: string, decksDir: string, log: (line: string) => void): Promise<Arena> {
  const cards = parseCatalog(await readFile(catalogPath, "utf8"));
  const byId = new Map(cards.map((card) => [card.id, card]));
  const byName = new Map(cards.map((card) => [card.name.toLowerCase(), card]));
  const decks: PremadeDeck[] = [];
  let names: string[] = [];
  try {
    names = (await readdir(decksDir)).filter((name) => name.endsWith(".json")).sort();
  } catch {
    log(`arena: no premade decks (${decksDir} cannot be read)`);
  }
  for (const name of names) {
    try {
      decks.push(resolveDeck(JSON.parse(await readFile(path.join(decksDir, name), "utf8")), byName, byId));
    } catch (error) {
      log(`arena: ${name} left out: ${(error as Error).message}`);
    }
  }
  return { cards, byId, decks };
}
