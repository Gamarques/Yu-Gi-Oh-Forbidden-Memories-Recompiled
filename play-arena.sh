#!/bin/sh
# Duel Arena (notes/duel-arena.md): the game for 1v1 2P DUELs with decks
# chosen on the remote play pages, no save needed. Once both players have a
# deck, the game goes to the duel by itself. Start the companion as well:
#   (cd tools/remote-play && npm start -- --tunnel)
MEMORIES_REMOTE_PLAY=1 MEMORIES_ARENA=1 MEMORIES_MOD_DUEL_ARENA=1 exec "$(dirname -- "$0")/play.sh" "$@"
