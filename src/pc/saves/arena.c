/* Duel Arena: the decks a 2P DUEL is fought with. See arena.h. */
#include "arena.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* Changes the side-2 copy's duelist code, so it never equals side 1's. */
#define ARENA_CODE_MASK 0x414E5241u /* "ARNA" */

static uint16_t decks[2][ARENA_DECK_SIZE];
static int sources[2]; /* 0: no deck */
static int file_read;

static int valid(const uint16_t *ids)
{
    int i;
    for (i = 0; i < ARENA_DECK_SIZE; i++) {
        if (ids[i] < 1 || ids[i] > ARENA_CARD_MAX) return 0;
    }
    return 1;
}

int Arena_SetDeck(int side, const uint16_t *ids, int source)
{
    if (side < 0 || side > 1) return 0;
    if (!ids) {
        sources[side] = 0;
        return 1;
    }
    if (!valid(ids)) return 0;
    memcpy(decks[side], ids, sizeof(decks[side]));
    sources[side] = source;
    return 1;
}

void Arena_ClearFrom(int source)
{
    int side;
    for (side = 0; side < 2; side++) {
        if (sources[side] == source) sources[side] = 0;
    }
}

/* MEMORIES_ARENA_DECKS: "1: id,id,..." and "2: id,id,...", once. */
static void read_file(void)
{
    const char *path;
    FILE *file;
    char line[1024];
    if (file_read) return;
    file_read = 1;
    path = getenv("MEMORIES_ARENA_DECKS");
    if (!path || !*path) return;
    if (!(file = fopen(path, "r"))) {
        fprintf(stderr, "memories-pc: arena: cannot read %s\n", path);
        return;
    }
    while (fgets(line, sizeof(line), file)) {
        uint16_t ids[ARENA_DECK_SIZE];
        char *at = line, *end;
        long side = strtol(at, &end, 10), id;
        int count = 0;
        if (end == at || *end != ':' || side < 1 || side > 2) continue;
        at = end + 1;
        while (count < ARENA_DECK_SIZE && (id = strtol(at, &end, 10), end != at)) {
            ids[count++] = id > 0 && id <= ARENA_CARD_MAX ? (uint16_t)id : 0;
            at = *end == ',' ? end + 1 : end;
        }
        if (count != ARENA_DECK_SIZE || !Arena_SetDeck((int)side - 1, ids, ARENA_FROM_FILE)) {
            fprintf(stderr, "memories-pc: arena: %s: side %ld is not forty cards from 1 to %d\n", path, side,
                    ARENA_CARD_MAX);
        }
    }
    fclose(file);
}

int Arena_Active(int side)
{
    read_file();
    return (side == 0 || side == 1) && sources[side] != 0;
}

void Arena_ApplyPairLoad(int side, unsigned char *state)
{
    int i;
    if (!state || !Arena_Active(side)) return;
    /* The deck: forty little-endian halfwords at the start of the state. */
    for (i = 0; i < ARENA_DECK_SIZE; i++) {
        state[ARENA_STATE_DECK_OFFSET + i * 2] = (unsigned char)decks[side][i];
        state[ARENA_STATE_DECK_OFFSET + i * 2 + 1] = (unsigned char)(decks[side][i] >> 8);
    }
    if (side == 1) {
        for (i = 0; i < 4; i++) state[ARENA_STATE_CODE_OFFSET + i] ^= (unsigned char)(ARENA_CODE_MASK >> (8 * i));
    }
    fprintf(stderr, "memories-pc: arena: player %d plays the arena deck\n", side + 1);
}

void Arena_Reset(void)
{
    sources[0] = sources[1] = 0;
    file_read = 0;
}
