@echo off
rem Duel Arena (notes/duel-arena.md): the game for 1v1 2P DUELs with decks
rem chosen on the remote play pages, no save needed. Once both players have
rem a deck, the game goes to the duel by itself. Start the companion as well:
rem   cd tools\remote-play ^&^& npm start -- --tunnel
set MEMORIES_REMOTE_PLAY=1
set MEMORIES_ARENA=1
set MEMORIES_MOD_DUEL_ARENA=1
call "%~dp0play.bat" %*
