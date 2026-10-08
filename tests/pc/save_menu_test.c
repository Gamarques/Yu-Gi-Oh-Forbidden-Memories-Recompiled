#define _POSIX_C_SOURCE 200809L
#include "pc/saves/save_menu.h"
#include "pc/saves/arena.h"
#include "pc/guest/state.h"
#include "pc/platform/settings.h"
#include "pc/compat/posix.h"
#include "scratch.h"
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define NAME "BASLUS-01411-YUGIOH"

/* Exercise the menu's real file I/O and input state machine without a window. */
int Settings_Get(SettingId id) { (void)id; return 0; } /* View > Japanese buttons off: the hints only */
int Menu_Scale(void) { return 1; }
int Menu_Height(void) { return 24; }
int Menu_TextWidthScaled(const char *text, int scale) { return (int)strlen(text) * 6 * scale; }
void Menu_DrawTextScaled(MenuCanvas *canvas, int x, int y, const char *text, uint32_t colour, int scale)
{
    (void)canvas; (void)x; (void)y; (void)text; (void)colour; (void)scale;
}

struct MemoriesState { int loading; unsigned char chunk[4096]; size_t size; };
int Memories_StateChunk(MemoriesState *state, const char *tag, const MemoriesStateField *fields, size_t count)
{
    assert(!strcmp(tag, "save-menu") && count == 1 && fields[0].size <= sizeof(state->chunk));
    if (state->loading) {
        assert(state->size == fields[0].size);
        memcpy(fields[0].data, state->chunk, state->size);
    } else {
        state->size = fields[0].size;
        memcpy(state->chunk, fields[0].data, state->size);
    }
    return state->loading;
}

static int sound(unsigned char *state) { return state[SAVE_SLOT_STATE_SIZE - 1] == 0x5A; }
static int poll(unsigned pressed, int channel)
{
    int effect;
    return SaveMenu_Poll(pressed, channel, &effect, sound);
}
static void begin(int step, unsigned char *buffer, unsigned char *second, int size, int channel)
{
    assert(SaveMenu_Begin(step, buffer, second, size, NAME, sound));
    assert(SaveMenu_Active());
    assert(!poll(0, channel));
}
static void make_image(unsigned char *image, int code)
{
    unsigned char *state = image + SAVE_SLOT_HEADER_SIZE;
    memset(image, 0, SAVE_SLOT_FILE_SIZE);
    image[0] = 'S'; image[1] = 'C';
    state[0x334] = (unsigned char)code;
    state[0x50] = 4;
    state[0x5E0] = 99;
    state[SAVE_SLOT_STATE_SIZE - 1] = 0x5A;
    memcpy(image + SAVE_SLOT_DUPLICATE_OFFSET, state, SAVE_SLOT_STATE_SIZE);
}
static void read_image(int slot, unsigned char *image)
{
    char path[1024];
    FILE *file;
    assert(!SaveSlots_Path(slot, path, sizeof(path)));
    file = fopen(path, "rb");
    assert(file);
    assert(fread(image, 1, SAVE_SLOT_FILE_SIZE, file) == SAVE_SLOT_FILE_SIZE);
    assert(!fclose(file));
}

int main(void)
{
    static unsigned char image[SAVE_SLOT_FILE_SIZE], before[SAVE_SLOT_FILE_SIZE];
    static unsigned char left[SAVE_SLOT_STATE_SIZE], right[SAVE_SLOT_STATE_SIZE];
    MemoriesState snapshot = {0};
    SaveSlotInfo slots[SAVE_SLOT_COUNT];
    char directory[SCRATCH_MAX], path[1024];
    int i;
    assert(scratch_dir(directory, sizeof(directory), "memories-save-menu"));
    assert(!setenv("MEMORIES_USER_DIR", directory, 1));
    /* Keep a developer's configured legacy cards out of this test. */
    snprintf(path, sizeof(path), "%s/missing.mcd", directory);
    assert(!setenv("MEMORIES_MEMCARD1", path, 1));
    assert(!setenv("MEMORIES_MEMCARD2", path, 1));

    begin(SAVE_MENU_LOAD, left, NULL, sizeof(left), 0);
    assert(poll(SAVE_MENU_PAD_CONFIRM, 0) == 2); /* no saves */
    assert(!SaveMenu_Active());

    /* Save an empty slot, then cancel an existing-slot overwrite. */
    make_image(image, 1);
    begin(SAVE_MENU_SAVE, image + SAVE_SLOT_HEADER_SIZE, NULL, 2 * SAVE_SLOT_STATE_SIZE, 0);
    assert(!poll(SAVE_MENU_PAD_CONFIRM, 0));
    assert(poll(SAVE_MENU_PAD_CONFIRM, 0) == 1);
    read_image(0, before);
    /* The game's bytes, then the port's token in the padding. */
    assert(!memcmp(image, before, SAVE_SLOT_TAG_OFFSET) && SaveSlots_Token(0));
    begin(SAVE_MENU_SAVE, image + SAVE_SLOT_HEADER_SIZE, NULL, 2 * SAVE_SLOT_STATE_SIZE, 0);
    assert(!poll(SAVE_MENU_PAD_CONFIRM, 0));
    assert(!poll(SAVE_MENU_PAD_CANCEL, 0));
    assert(poll(SAVE_MENU_PAD_CANCEL, 0) == 3);
    read_image(0, image);
    assert(!memcmp(image, before, sizeof(image)));

    /* Another duelist's save defaults to Cancel. */
    make_image(image, 2);
    begin(SAVE_MENU_SAVE, image + SAVE_SLOT_HEADER_SIZE, NULL, 2 * SAVE_SLOT_STATE_SIZE, 0);
    assert(!poll(SAVE_MENU_PAD_CONFIRM, 0));
    assert(!poll(SAVE_MENU_PAD_CONFIRM, 0));
    read_image(0, image);
    assert(!memcmp(image, before, sizeof(image)));
    assert(poll(SAVE_MENU_PAD_CANCEL, 0) == 3);

    /* A restored menu must get its callback from the current caller. Begin
     * with NULL simulates a new process's uninitialized native callback;
     * restoring the menu chunk, as the loader does, does not restore it. */
    begin(SAVE_MENU_LOAD, left, NULL, sizeof(left), 0);
    SaveMenu_State(&snapshot);
    assert(SaveMenu_Begin(SAVE_MENU_LOAD, left, NULL, sizeof(left), NAME, NULL));
    snapshot.loading = 1;
    SaveMenu_State(&snapshot);
    assert(poll(SAVE_MENU_PAD_CONFIRM, 0) == 1);
    assert(left[0x334] == 1);

    /* Player 2 cannot load Player 1's slot. */
    make_image(image, 2);
    assert(!SaveSlots_WriteFile(1, image, sizeof(image)));
    begin(SAVE_MENU_LOAD_PAIR, left, NULL, sizeof(left), 0);
    assert(poll(SAVE_MENU_PAD_CONFIRM, 0) == 1);
    begin(SAVE_MENU_LOAD_PAIR, right, NULL, sizeof(right), 0x10);
    assert(!poll(SAVE_MENU_PAD_UP, 0x10));
    assert(!poll(SAVE_MENU_PAD_CONFIRM, 0x10));
    assert(SaveMenu_Active());
    assert(!poll(SAVE_MENU_PAD_DOWN, 0x10));
    assert(poll(SAVE_MENU_PAD_CONFIRM, 0x10) == 1);
    assert(left[0x334] == 1 && right[0x334] == 2);
    left[0x50] = 3; right[0x50] = 5;

    /* A changed second destination must reject the trade before writing
     * Player 1's save, even though Player 1 still matches. */
    make_image(image, 3);
    assert(!SaveSlots_WriteFile(1, image, sizeof(image)));
    assert(SaveMenu_Begin(SAVE_MENU_WRITE_PAIR, left, right, 0x400, NAME, sound));
    assert(poll(0, 0) == 2);
    read_image(0, image);
    assert(!memcmp(image, before, sizeof(image)));

    /* Trade into a recovered slot: preserve the valid copy's progress and
     * replace both copies, so later backup recovery cannot undo the trade. */
    make_image(image, 2);
    image[SAVE_SLOT_HEADER_SIZE + 0x5E0] = 0;
    image[SAVE_SLOT_HEADER_SIZE + SAVE_SLOT_STATE_SIZE - 1] = 0;
    assert(!SaveSlots_WriteFile(1, image, sizeof(image)));
    assert(SaveMenu_Begin(SAVE_MENU_WRITE_PAIR, left, right, 0x400, NAME, sound));
    assert(poll(0, 0) == 1);
    for (i = 0; i < 2; i++) {
        read_image(i, image);
        assert(image[0] == 'S' && image[1] == 'C');
        assert(image[SAVE_SLOT_HEADER_SIZE + 0x50] == (i ? 5 : 3));
        assert(image[SAVE_SLOT_HEADER_SIZE + 0x5E0] == 99);
        assert(!memcmp(image + SAVE_SLOT_HEADER_SIZE, image + SAVE_SLOT_DUPLICATE_OFFSET, SAVE_SLOT_STATE_SIZE));
        image[SAVE_SLOT_HEADER_SIZE + SAVE_SLOT_STATE_SIZE - 1] = 0;
        assert(!SaveSlots_WriteFile(i, image, sizeof(image)));
    }
    SaveSlots_Scan(slots, sound);
    assert(slots[0].from_duplicate && slots[1].from_duplicate);
    assert(!SaveSlots_ReadState(0, left, sound) && left[0x50] == 3);
    assert(!SaveSlots_ReadState(1, right, sound) && right[0x50] == 5);

    /* Saving the game in play over its own slot defaults to Overwrite and
     * draws a new token; over an earlier point of it, to Cancel. */
    {
        unsigned token = SaveSlots_Token(0);
        make_image(image, 1);
        image[SAVE_SLOT_HEADER_SIZE + 0x404] = 7;
        assert(!SaveSlots_WriteFile(0, image, sizeof(image)));
        image[SAVE_SLOT_HEADER_SIZE + 0x404] = 8;   /* the next save of that game */
        token = SaveSlots_Token(0);
        /* The cursor starts on the slot in use, slot 1. */
        begin(SAVE_MENU_SAVE, image + SAVE_SLOT_HEADER_SIZE, NULL, 2 * SAVE_SLOT_STATE_SIZE, 0);
        assert(SaveMenu_CurrentSlot() == 0);
        assert(!poll(SAVE_MENU_PAD_CONFIRM, 0));   /* the question */
        assert(!poll(SAVE_MENU_PAD_CONFIRM, 0));   /* Overwrite: saved, message shown */
        read_image(0, image);
        assert(image[SAVE_SLOT_HEADER_SIZE + 0x404] == 8 && SaveSlots_Token(0) != token);
        image[SAVE_SLOT_HEADER_SIZE + 0x404] = 6;   /* an older point than slot 1 holds */
        begin(SAVE_MENU_SAVE, image + SAVE_SLOT_HEADER_SIZE, NULL, 2 * SAVE_SLOT_STATE_SIZE, 0);
        assert(!poll(SAVE_MENU_PAD_CONFIRM, 0));
        assert(!poll(SAVE_MENU_PAD_CONFIRM, 0));   /* Cancel is chosen */
        read_image(0, before);
        assert(before[SAVE_SLOT_HEADER_SIZE + 0x404] == 8);
        assert(poll(SAVE_MENU_PAD_CANCEL, 0) == 3);
    }

    /* A save state from before a slot was written must not save over it
     * without asking. */
    {
        int empty = 2;
        make_image(image, 1);
        begin(SAVE_MENU_SAVE, image + SAVE_SLOT_HEADER_SIZE, NULL, 2 * SAVE_SLOT_STATE_SIZE, 0);
        assert(!poll(SAVE_MENU_PAD_DOWN, 0) && !poll(SAVE_MENU_PAD_DOWN, 0));
        snapshot.loading = 0;
        SaveMenu_State(&snapshot);                 /* slot 3 shows Empty */
        make_image(before, 4);
        assert(!SaveSlots_WriteFile(empty, before, sizeof(before)));
        snapshot.loading = 1;
        SaveMenu_State(&snapshot);
        assert(!poll(SAVE_MENU_PAD_CONFIRM, 0));   /* asks */
        assert(!poll(SAVE_MENU_PAD_CONFIRM, 0));   /* another duelist's: Cancel */
        read_image(empty, image);
        assert(image[SAVE_SLOT_HEADER_SIZE + 0x334] == 4);
        assert(poll(SAVE_MENU_PAD_CANCEL, 0) == 3);
        snapshot.loading = 0;
    }

    /* Restoring an Overwrite prompt cannot authorize replacing a save
     * written after that prompt was captured, even for the same duelist. */
    {
        make_image(image, 1);
        image[SAVE_SLOT_HEADER_SIZE + 0x404] = 7;
        assert(!SaveSlots_WriteFile(0, image, sizeof(image)));
        image[SAVE_SLOT_HEADER_SIZE + 0x404] = 8;
        begin(SAVE_MENU_SAVE, image + SAVE_SLOT_HEADER_SIZE, NULL, 2 * SAVE_SLOT_STATE_SIZE, 0);
        assert(!poll(SAVE_MENU_PAD_CONFIRM, 0));   /* Overwrite is selected */
        SaveMenu_State(&snapshot);
        make_image(before, 1);
        before[SAVE_SLOT_HEADER_SIZE + 0x404] = 9;
        assert(!SaveSlots_WriteFile(0, before, sizeof(before)));
        read_image(0, before);
        snapshot.loading = 1;
        SaveMenu_State(&snapshot);
        assert(!poll(SAVE_MENU_PAD_CONFIRM, 0));   /* ask again using disk */
        assert(!poll(SAVE_MENU_PAD_CONFIRM, 0));   /* newer save: Cancel */
        read_image(0, image);
        assert(!memcmp(image, before, sizeof(image)));
        assert(poll(SAVE_MENU_PAD_CANCEL, 0) == 3);
        snapshot.loading = 0;
    }

#ifndef _WIN32
    /* A trade whose second write fails puts player 1's save back. */
    {
        char partial[1100];
        assert(!SaveSlots_Path(2, path, sizeof(path)));
        assert(!remove(path));
        make_image(image, 1);
        assert(!SaveSlots_WriteFile(0, image, sizeof(image)));
        make_image(image, 2);
        assert(!SaveSlots_WriteFile(1, image, sizeof(image)));
        begin(SAVE_MENU_LOAD_PAIR, left, NULL, sizeof(left), 0);
        while (SaveMenu_Active()) {
            if (poll(SAVE_MENU_PAD_CONFIRM, 0)) break;
        }
        begin(SAVE_MENU_LOAD_PAIR, right, NULL, sizeof(right), 0x10);
        assert(poll(SAVE_MENU_PAD_CONFIRM, 0x10) == 1);   /* the only other save */
        assert(left[0x334] == 1 && right[0x334] == 2);
        left[0x50] = 9; right[0x50] = 9;
        assert(!SaveSlots_Path(1, path, sizeof(path)));
        snprintf(partial, sizeof(partial), "%s.partial", path);
        assert(!symlink("/dev/full", partial));
        assert(SaveMenu_Begin(SAVE_MENU_WRITE_PAIR, left, right, 0x400, NAME, sound));
        assert(poll(0, 0) == 2);
        remove(partial);
        assert(!SaveSlots_ReadState(0, left, sound) && left[0x50] == 4);
        assert(!SaveSlots_ReadState(1, right, sound) && right[0x50] == 4);
    }
#endif

    /* Duel Arena: with a deck for each side, no menu opens and no file is
     * read or written: each side gets a state of its own, all zeros but the
     * deck, the name and a duelist code that differs between the sides. */
    {
        static unsigned char arena_left[SAVE_SLOT_STATE_SIZE], arena_right[SAVE_SLOT_STATE_SIZE];
        static unsigned char file_before[SAVE_SLOT_FILE_SIZE], file_after[SAVE_SLOT_FILE_SIZE];
        static const unsigned char yugi[12] = {0x82, 0x78, 0x82, 0x74, 0x82, 0x66, 0x82, 0x68, 0x82, 0x51, 0x81, 0x40};
        uint16_t one[ARENA_DECK_SIZE], two[ARENA_DECK_SIZE];
        FILE *decks;
        int zero;
        for (i = 0; i < ARENA_DECK_SIZE; i++) {
            one[i] = (uint16_t)(1 + i);
            two[i] = (uint16_t)(700 + i % 20);
        }
        read_image(0, file_before);
        memset(arena_left, 0xEE, sizeof(arena_left));
        assert(Arena_SetDeck(0, one, ARENA_FROM_COMPANION) && Arena_SetDeck(1, two, ARENA_FROM_COMPANION));
        Arena_SetName(0, "yugi-2!");
        assert(SaveMenu_Begin(SAVE_MENU_LOAD_PAIR, arena_left, NULL, sizeof(arena_left), NAME, sound));
        assert(poll(0, 0) == 1 && !SaveMenu_Active());
        assert(SaveMenu_Begin(SAVE_MENU_LOAD_PAIR, arena_right, NULL, sizeof(arena_right), NAME, sound));
        assert(poll(0, 0x10) == 1 && !SaveMenu_Active());
        assert(SaveMenu_PairSlot(0) == -1 && SaveMenu_PairSlot(1) == -1);
        for (i = 0; i < ARENA_DECK_SIZE; i++) {
            assert((arena_left[i * 2] | arena_left[i * 2 + 1] << 8) == one[i]);
            assert((arena_right[i * 2] | arena_right[i * 2 + 1] << 8) == two[i]);
        }
        assert(!memcmp(arena_left + ARENA_STATE_CODE_OFFSET, "ARN1", 4));
        assert(!memcmp(arena_right + ARENA_STATE_CODE_OFFSET, "ARN2", 4));
        /* YUGI2 in full-width Shift JIS, a full-width space after. */
        assert(!memcmp(arena_left + ARENA_STATE_NAME_OFFSET, yugi, sizeof(yugi)));
        assert(arena_right[ARENA_STATE_NAME_OFFSET] == 0x82 && arena_right[ARENA_STATE_NAME_OFFSET + 1] == 0x6F); /* P */
        for (zero = 1, i = 80; i < SAVE_SLOT_STATE_SIZE; i++) {
            if (i >= ARENA_STATE_CODE_OFFSET && i < ARENA_STATE_CODE_OFFSET + 4) continue;
            if (i >= ARENA_STATE_NAME_OFFSET && i < ARENA_STATE_NAME_OFFSET + 2 * ARENA_NAME_CHARS) continue;
            zero &= arena_left[i] == 0;
        }
        assert(zero);
        read_image(0, file_after);
        assert(!memcmp(file_before, file_after, sizeof(file_after)));

        /* Not forty retail cards: refused, the old deck stays. */
        two[3] = 0;
        assert(!Arena_SetDeck(1, two, ARENA_FROM_COMPANION) && Arena_Active(1));
        two[3] = ARENA_CARD_MAX + 1;
        assert(!Arena_SetDeck(1, two, ARENA_FROM_COMPANION));
        /* Autostart needs MEMORIES_ARENA and both decks. */
        assert(!Arena_Autostart());
        assert(!setenv("MEMORIES_ARENA", "1", 1));
        assert(Arena_Autostart());
        assert(Arena_SetDeck(0, NULL, ARENA_FROM_COMPANION) && !Arena_Autostart());
        assert(!unsetenv("MEMORIES_ARENA"));
        /* The companion leaving clears its decks: the menu asks again. */
        Arena_ClearFrom(ARENA_FROM_COMPANION);
        assert(!Arena_Active(0) && !Arena_Active(1));
        begin(SAVE_MENU_LOAD_PAIR, arena_left, NULL, sizeof(arena_left), 0);
        assert(SaveMenu_Active());
        assert(poll(SAVE_MENU_PAD_CANCEL, 0) == 3);

        /* The decks from a file: a bad line is skipped. */
        snprintf(path, sizeof(path), "%s/arena.txt", directory);
        assert((decks = fopen(path, "w")) != NULL);
        fputs("1: 1,2,3\n2: ", decks);
        for (i = 0; i < ARENA_DECK_SIZE; i++) fprintf(decks, "%s%d", i ? "," : "", 10 + i);
        fputs("\n", decks);
        assert(!fclose(decks));
        Arena_Reset();
        assert(!setenv("MEMORIES_ARENA_DECKS", path, 1));
        assert(!Arena_Active(0) && Arena_Active(1));
        assert(SaveMenu_Begin(SAVE_MENU_LOAD_PAIR, arena_right, NULL, sizeof(arena_right), NAME, sound));
        assert(poll(0, 0x10) == 1);
        assert((arena_right[78] | arena_right[79] << 8) == 49);
        Arena_ClearFrom(ARENA_FROM_COMPANION);
        assert(Arena_Active(1)); /* the file's stay */
        assert(!unsetenv("MEMORIES_ARENA_DECKS"));
        remove(path);
        Arena_Reset();
    }

    for (i = 0; i < SAVE_SLOT_COUNT; i++) {
        assert(!SaveSlots_Path(i, path, sizeof(path)));
        remove(path);
    }
    snprintf(path, sizeof(path), "%s/saves/.cards-imported", directory);
    remove(path);
    snprintf(path, sizeof(path), "%s/saves", directory);
    assert(!rmdir(path));
    assert(!rmdir(directory));
    puts("save menu: ok");
    return 0;
}
