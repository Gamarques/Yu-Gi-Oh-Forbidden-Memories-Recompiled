# Duel Arena

Duel Arena is the game's own 2P DUEL fought with decks chosen for it: any
of the disc's 722 cards, up to three copies of a card. Each player picks a
premade deck or builds one in the browser, and neither needs a save of their
own. The duel is the retail one, run by the decompiled code: fusions,
equips, rituals and guardian stars are the game's.

It is built on [remote play](remote-play.md): the host plays as player 1 in
the game's window, the friend as player 2 from the guest page.

## Playing

1. Start the game with `play-arena.bat` (Windows) or `./play-arena.sh`
   (Linux). They set `MEMORIES_REMOTE_PLAY=1` (the bridge),
   `MEMORIES_ARENA=1` (the game goes to the duel by itself) and
   `MEMORIES_MOD_DUEL_ARENA=1` (DUEL ARENA first on the title), then run
   `play.bat` / `play.sh`.
2. Start the companion (`tools/remote-play`, `npm start -- --tunnel`) and
   invite the friend as usual.
3. On the host page and the guest page, the **Duel Arena** panel offers the
   premade decks and a deck builder. "Play this deck" sends the deck, and
   both panels show which side is ready. The host types the name the duel
   shows for them; the guest's is the name they joined with.
4. Once both sides have a deck, the game waits two seconds on the title,
   then goes on by itself: past PUSH START BUTTON, onto 2P DUEL, past the
   dialog's Cross. It stops on the life points screen, where the host
   chooses the life points and starts the duel.
5. After the duel the title comes back, and with both decks still there the
   next duel follows. To stop, a player takes their deck back ("Take my deck
   back"), and the title stays put.

No save is read, written or needed, not even one on the host's machine. NEW
GAME, CONTINUE and the save slot menu never come into it. Without
`MEMORIES_ARENA` the decks still apply, but the host picks 2P DUEL on the
title by hand.

## How it works

### No save: a state built in memory

The 2P DUEL asks the memory card dialog for one save per side
(`SaveData_UpdateLoadPair`). The port answers with its save slot menu
(`src/pc/saves/save_menu.c`, step `SAVE_MENU_LOAD_PAIR`). When the side has
an arena deck, the menu does not open and reads no file.
`Arena_BuildState` (`src/pc/saves/arena.c`) builds the state the game would
have loaded, and the load reports success.

The state is 0x680 bytes of zeros except what a 2P DUEL reads of a save:

| Offset | Field | Arena |
|---|---|---|
| 0x000 | the deck, forty halfwords | the arena deck; `Duel_ShuffleBothDecks` deals from it |
| 0x334 | duelist code | "ARN1" for player 1, "ARN2" for player 2. The game refuses two saves of one duelist (`SaveData_HasSameDuelistCode`) |
| 0x40C | name, six Shift JIS characters | the player's name in full-width capitals and digits (`Text_SjisToGlyphCodes` reads it for the duel) |

The duel also adds to each side's wins and losses at its end
(`func_800218F0`), in these copies in memory only. A 2P DUEL writes nothing
back (only TRADE does), so nothing is saved.

### Going to the duel by itself

With `MEMORIES_ARENA=1` and a deck on both sides, the port makes the presses
a player would make, on the game's own path, so the game runs no screen out
of turn:

- **The title** (`src/pc/platform/title_menu.c`, `arena_autostart`). After
  two seconds on the title, it presses Start on PUSH START BUTTON. On the
  first menu it puts the cursor on 2P DUEL and presses Cross, once a visit
  to the title, where a player's press would go (`gInput_wPad1Pressed`,
  before the game's menu update).
- **The dialog's Cross.** Before the loads, the 2P DUEL's dialog waits for
  Cross (`SaveData_UpdateLoadPair`, state 1). A `MEMORIES_PC` block there
  takes it as pressed when the arena starts itself. It applies only to a 2P
  DUEL's loads (`D_8009B3C0` is 40 there, 41 for TRADE) and changes nothing
  in the matching build.
- **The life points screen** (`Main_RunTwoPlayerDuelSetup`) is left to the
  host: it is where the duel's life points are chosen.

The port does not jump between main modes. Forcing 2P DUEL setup with
`MEMORIES_MODE_AT` is known to stop the picture (`notes/pc-build.md`); the
presses keep to the way a player takes.

### Where the decks come from

- **The companion**, over the remote play bridge: `REMOTE_PLAY_ARENA_DECK`
  (protocol 3, `remote_play.h`), side, count and forty ids, then the
  player's name, or a count of 0 to clear it. The game clears these decks
  when the companion leaves.
- **A file**, for two players on one machine with no companion:
  `MEMORIES_ARENA_DECKS=path`, one line per side, `1: 1,1,1,20,...` and
  `2: ...`. A line that is not forty ids from 1 to 722 is reported and
  skipped.

### In the companion

`src/server/cards.ts` reads the card list from `notes/card-catalog.csv` and
the premade decks from `tools/remote-play/decks/*.json`, written by card name:

```json
{
    "name": "Magos",
    "description": "O deck do Yugi...",
    "cards": {"Dark Magician": 3, "Dark Elf": 3, "Book of Secret Arts": 3, "...": 1}
}
```

A deck file that names an unknown card or breaks a rule is reported and
left out. `GET /api/arena` gives both pages the cards and the premade decks.
A page sends `{type: "arena-deck", name, cards}` for its own side: the host
page for player 1, the guest page for player 2. The companion checks the
rules again, keeps each side's choice, sends it to the game, and tells both
pages who is ready.

| Rule | Why |
|---|---|
| Forty cards | The game deals from a forty-card deck |
| At most three copies of a card | Build Deck's own limit |
| One of each Exodia piece | Build Deck's own limit |
| Ids 1 to 722 only | The disc's cards; the game itself only checks that each id is nonzero |

The guest's deck counts only while the guest is player 2. When the host makes
them player 1, their deck is taken back, and the companion refuses another
until they are player 2 again. A guest who leaves takes their deck with them.

### The deck builder

`src/web/arena-ui.ts` is the panel both pages mount. It offers:

- the premade decks;
- a search by name or type, with a filter for monsters, magic, traps,
  equips and rituals. Monsters show type, ATK/DEF and level;
- the deck, with its count and the rules checked as cards are added;
- decks kept in the browser (`localStorage`);
- a **deck code**: the forty ids, comma-separated, to copy into a message
  and paste on the other side.

## Tests

- `tests/pc/save_menu_test.c` (`pc_save_menu`): both sides load with no menu
  and no file read. It checks the states byte by byte (deck, "ARN1"/"ARN2",
  the name in full-width Shift JIS, zeros elsewhere) and that the save files
  are unchanged. It also covers refused decks, autostart needing
  `MEMORIES_ARENA` and both decks, the companion's decks cleared with the
  menu back, and the decks file.
- `tests/pc/remote_play_test.c` (`pc_remote_play`): `REMOTE_PLAY_ARENA_DECK`
  sets, refuses and clears decks and carries the player's name, and the
  companion leaving clears the decks.
- `src/test/unit/cards.test.ts`: the CSV, the rules and every premade deck.
- `src/test/unit/game-protocol.test.ts`: the deck message's bytes, the name
  without accents.
- `src/test/unit/companion.test.ts`: the decks and names reach the fake game,
  a bad deck is refused, and player 1, leaving and taking a deck back all
  behave.
- `src/test/e2e.ts`: in two Chromium browsers, the host plays a premade deck,
  and the guest adds a card from the search, then pastes a deck code and
  plays it.

## Not checked yet

The game's own screens could not be run where this was written (no disc).
To check against the real game:

- the title walking itself to 2P DUEL (`arena_autostart`) and the dialog's
  Cross taken;
- the duel dealing the arena decks and showing the names (the name's
  encoding, full-width Shift JIS, is inferred from `Text_SjisToGlyphCodes`);
- nothing in a 2P DUEL needing more of a save than the deck, the code and
  the name;
- the `duel-arena` mod's title menu on the real title screen.
