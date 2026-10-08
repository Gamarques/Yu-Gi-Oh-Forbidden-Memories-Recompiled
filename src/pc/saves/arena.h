#ifndef MEMORIES_PC_ARENA_H
#define MEMORIES_PC_ARENA_H
/* Duel Arena (notes/duel-arena.md): a 2P DUEL fought with decks chosen for
 * it, any card allowed, with no save at all.
 *
 * When the 2P DUEL asks a side with an arena deck for a save
 * (SAVE_MENU_LOAD_PAIR), the save menu does not open and reads no file: it
 * hands the game a state built here, all zeros but for what a 2P DUEL reads
 * of a save -- the forty cards, the player's name, and a duelist code of its
 * own for each side (the game refuses two saves of one duelist). A 2P DUEL
 * writes nothing back, so nothing is ever saved.
 *
 * With MEMORIES_ARENA=1 the game also walks itself into the duel once both
 * sides have a deck: past PUSH START BUTTON, onto 2P DUEL, past the dialog's
 * "press X", to the life points screen, where the host starts the duel.
 * After it the title comes back and, with both decks still there, the next
 * duel follows; taking a deck back stops it.
 *
 * The decks come from the remote play companion (REMOTE_PLAY_ARENA_DECK,
 * remote_play.h) or from the file MEMORIES_ARENA_DECKS names, one line per
 * side: "1: 1,1,1,20,...", then "2: ...", forty card ids each. */
#include <stdint.h>

#define ARENA_DECK_SIZE 40
/* The disc's cards: an arena deck holds retail ids only. */
#define ARENA_CARD_MAX 722
/* What a 2P DUEL reads of a save state (save_data.h, SaveDataState). */
#define ARENA_STATE_SIZE 0x680
#define ARENA_STATE_DECK_OFFSET 0x000
#define ARENA_STATE_CODE_OFFSET 0x334
#define ARENA_STATE_NAME_OFFSET 0x40C
#define ARENA_NAME_CHARS 6 /* Shift JIS, two bytes a character */
/* Each side's duelist code: "ARN1" and "ARN2", never the same. */
#define ARENA_CODE_BASE 0x314E5241u

enum { ARENA_FROM_FILE = 1, ARENA_FROM_COMPANION = 2 };

/* Set side 0 or 1's deck, or clear it with ids NULL. Returns 0 when the
 * deck is refused: not forty ids from 1 to ARENA_CARD_MAX. */
int Arena_SetDeck(int side, const uint16_t *ids, int source);
/* The name the side's duelist shows: letters and digits, the first six,
 * in the game's full-width characters; NULL or none for "PLAYER1"/"PLAYER2"
 * cut to six. */
void Arena_SetName(int side, const char *name);
/* Clear the decks the companion set (it went away); the file's stay. */
void Arena_ClearFrom(int source);
/* Whether `side` plays an arena deck. */
int Arena_Active(int side);
/* MEMORIES_ARENA=1 and both sides have a deck: walk into the 2P DUEL. */
int Arena_Autostart(void);
/* The save state a 2P DUEL loads for `side` (ARENA_STATE_SIZE bytes). */
void Arena_BuildState(int side, unsigned char *state);
/* Forget everything, the file and the names included (tests). */
void Arena_Reset(void);
#endif
