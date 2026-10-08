// Duel Arena types and rules, shared by the companion and both pages.
export const ARENA_DECK_SIZE = 40;
export const ARENA_COPIES_MAX = 3;
export const ARENA_CARD_MAX = 722; // the disc's cards (src/pc/saves/arena.h)

export interface ArenaCard {
  id: number;
  name: string;
  type: string; // Dragon, Spellcaster ... or Magic, Trap, Equip, Ritual
  attribute: string;
  level: number;
  stars: string[]; // guardian stars
  attack: number;
  defense: number;
  monster: boolean;
}

export interface PremadeDeck {
  name: string;
  description: string;
  cards: number[]; // forty ids
}

// What each side has chosen, as both pages see it.
export interface ArenaSide {
  ready: boolean;
  deckName: string;
}

// A deck as text people can copy and paste: the forty ids, comma-separated.
export function deckCode(ids: readonly number[]): string {
  return ids.join(",");
}

export function parseDeckCode(code: string): number[] {
  return code
    .split(/[\s,;]+/)
    .filter(Boolean)
    .map((part) => Number(part));
}
