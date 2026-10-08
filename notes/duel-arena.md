# Duel Arena

Duel Arena is the game's own 2P DUEL fought with decks chosen for it: any
of the disc's 722 cards, up to three copies of a card. Each player picks a
premade deck or builds one in the browser, and neither needs a save of their
own. The duel is the retail one, run by the decompiled code: fusions,
equips, rituals and guardian stars are the game's.

It is built on [remote play](remote-play.md): the host plays as player 1 in
the game's window, the friend as player 2 from the guest page.

## Playing

1. Start the game with the bridge on and the `duel-arena` mod for the title:
   `MEMORIES_REMOTE_PLAY=1` and `MEMORIES_MOD_DUEL_ARENA=1`, or tick it in
   **Game > Mods**. Without the mod everything still works; the title just
   keeps the game's own order, with 2P DUEL third.
2. Start the companion (`tools/remote-play`, `npm start`) and invite the
   friend as usual.
3. On the host page and the guest page, the **Duel Arena** panel offers the
   premade decks and a deck builder. "Play this deck" sends the deck. Both
   panels show which side is ready.
4. In the game, choose **DUEL ARENA** (2P DUEL). No save is asked for: each
   side with an arena deck loads one by itself.

The host still needs one save on the machine, of any game in any state. The
arena borrows it for both sides and changes nothing in it.

## How it works

### In the game

The 2P DUEL asks the memory card dialog for one save per side
(`SaveData_UpdateLoadPair`). The port answers with its save slot menu
(`src/pc/saves/save_menu.c`, step `SAVE_MENU_LOAD_PAIR`). The deck the duel
deals from is the first 40 card ids of each loaded state
(`SaveData_UpdateDuelLoad` reads them from `D_801D1200` and the second
side's copy 0x1000 further on).

`src/pc/saves/arena.c` keeps a deck per side. When a side has one:

- the save menu does not open for it. It loads the save in use, or else the
  newest save, as if the player had picked it;
- `Arena_ApplyPairLoad` writes the arena deck over the forty ids of the
  loaded copy;
- on side 2 it also changes the copy's duelist code (offset 0x334). The game
  refuses two saves of one duelist (`SaveData_HasSameDuelistCode`), and this
  lets one save stand for both. The port's own rule that player 2 cannot
  pick player 1's slot is lifted for an arena player 2.

Only the copies in memory change. A 2P DUEL writes nothing back (only TRADE
does), so the save file stays as it was.

### Where the decks come from

- **The companion**, over the remote play bridge: `REMOTE_PLAY_ARENA_DECK`
  (protocol 3, `remote_play.h`), side, count and forty ids, or a count of 0
  to clear it. The game clears these decks when the companion leaves.
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
  from the save in use, decks replaced, player 2's code changed, the files
  unchanged. It also checks refused decks, the companion's decks cleared
  with the menu back, and the decks file.
- `tests/pc/remote_play_test.c` (`pc_remote_play`): `REMOTE_PLAY_ARENA_DECK`
  sets, refuses and clears decks, and the companion leaving clears them.
- `src/test/unit/cards.test.ts`: the CSV, the rules and every premade deck.
- `src/test/unit/companion.test.ts`: the decks reach the fake game, a bad one
  is refused, and player 1, leaving and taking a deck back all behave.
- `src/test/e2e.ts`: in two Chromium browsers, the host plays a premade deck,
  and the guest adds a card from the search, then pastes a deck code and
  plays it.

## Not checked yet

- Against the real game: that the duel deals the arena decks, and that
  nothing in a 2P DUEL reads the duelist code past the load (the code is
  changed only in the side-2 copy).
- The `duel-arena` mod's title menu on the real title screen.
