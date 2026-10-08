/* Duel Arena: the decks a 2P DUEL is fought with. See arena.h. */
#include "arena.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static uint16_t decks[2][ARENA_DECK_SIZE];
static int sources[2]; /* 0: no deck */
static char names[2][ARENA_NAME_CHARS + 1];
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

/* Letters (upper case) and digits only: the characters every name the
 * game shows is made of. */
void Arena_SetName(int side, const char *name)
{
    int kept = 0;
    if (side < 0 || side > 1) return;
    for (; name && *name && kept < ARENA_NAME_CHARS; name++) {
        char c = *name;
        if (c >= 'a' && c <= 'z') c = (char)(c - 'a' + 'A');
        if ((c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')) names[side][kept++] = c;
    }
    names[side][kept] = '\0';
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

int Arena_Autostart(void)
{
    const char *on = getenv("MEMORIES_ARENA");
    return on && *on && *on != '0' && Arena_Active(0) && Arena_Active(1);
}

/* One character in Shift JIS's full-width forms, as the game keeps names:
 * A-Z from 0x8260, 0-9 from 0x824F; anything else a full-width space. */
static void put_sjis(unsigned char *at, char c)
{
    unsigned code = c >= 'A' && c <= 'Z' ? 0x8260u + (unsigned)(c - 'A')
                    : c >= '0' && c <= '9' ? 0x824Fu + (unsigned)(c - '0')
                                           : 0x8140u;
    at[0] = (unsigned char)(code >> 8);
    at[1] = (unsigned char)code;
}

void Arena_BuildState(int side, unsigned char *state)
{
    static const char *const fallback[2] = {"PLAYR1", "PLAYR2"};
    const char *name;
    uint32_t code;
    int i;
    if (!state || side < 0 || side > 1) return;
    memset(state, 0, ARENA_STATE_SIZE);
    /* The deck: forty little-endian halfwords at the start of the state. */
    for (i = 0; i < ARENA_DECK_SIZE; i++) {
        state[ARENA_STATE_DECK_OFFSET + i * 2] = (unsigned char)decks[side][i];
        state[ARENA_STATE_DECK_OFFSET + i * 2 + 1] = (unsigned char)(decks[side][i] >> 8);
    }
    code = ARENA_CODE_BASE + ((uint32_t)side << 24);
    for (i = 0; i < 4; i++) state[ARENA_STATE_CODE_OFFSET + i] = (unsigned char)(code >> (8 * i));
    name = names[side][0] ? names[side] : fallback[side];
    for (i = 0; i < ARENA_NAME_CHARS; i++) {
        put_sjis(state + ARENA_STATE_NAME_OFFSET + i * 2, i < (int)strlen(name) ? name[i] : ' ');
    }
    fprintf(stderr, "memories-pc: arena: player %d plays the arena deck as %s\n", side + 1, name);
}

void Arena_Reset(void)
{
    sources[0] = sources[1] = 0;
    names[0][0] = names[1][0] = '\0';
    file_read = 0;
}
