#ifndef MEMORIES_PC_ARENA_H
#define MEMORIES_PC_ARENA_H
/* Duel Arena (notes/duel-arena.md): a 2P DUEL fought with decks chosen for
 * it rather than the decks in the two saves, any card allowed.
 *
 * A side with an arena deck needs no save of its own. When the 2P DUEL asks
 * that side for a save (SAVE_MENU_LOAD_PAIR), the save menu loads the newest
 * save by itself, without showing, and this module puts the arena deck in
 * place of the save's forty cards. On side 2 it also changes the loaded
 * copy's duelist code, so the same save can stand for both players (the
 * game refuses two saves of one duelist). Only the copy in memory changes:
 * the save file is never written, and a 2P DUEL writes nothing back.
 *
 * The decks come from the remote play companion (REMOTE_PLAY_ARENA_DECK,
 * remote_play.h) or from the file MEMORIES_ARENA_DECKS names, one line per
 * side: "1: 1,1,1,20,...", then "2: ...", forty card ids each. */
#include <stdint.h>

#define ARENA_DECK_SIZE 40
/* The disc's cards: an arena deck holds retail ids only. */
#define ARENA_CARD_MAX 722
/* Where the loaded save state keeps the deck and the duelist code. */
#define ARENA_STATE_DECK_OFFSET 0x000
#define ARENA_STATE_CODE_OFFSET 0x334

enum { ARENA_FROM_FILE = 1, ARENA_FROM_COMPANION = 2 };

/* Set side 0 or 1's deck, or clear it with ids NULL. Returns 0 when the
 * deck is refused: not forty ids from 1 to ARENA_CARD_MAX. */
int Arena_SetDeck(int side, const uint16_t *ids, int source);
/* Clear the decks the companion set (it went away); the file's stay. */
void Arena_ClearFrom(int source);
/* Whether `side` plays an arena deck. */
int Arena_Active(int side);
/* A save state (SAVE_SLOT_STATE_SIZE bytes) just loaded for `side` of a
 * pair: the arena deck in place of its own, and on side 1 another duelist
 * code. Nothing when the side has no arena deck. */
void Arena_ApplyPairLoad(int side, unsigned char *state);
/* Forget everything, the file included (tests). */
void Arena_Reset(void);
#endif
