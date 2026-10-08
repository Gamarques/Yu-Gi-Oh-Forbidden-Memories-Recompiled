# Passo a passo: Remote Play e Duel Arena (Yu-Gi-Oh! Forbidden Memories)

Briefing para um agente que vai rodar, testar e depurar o que foi feito na branch
`claude/monster-3d-model-location-ip80w2` do repositório
`Gamarques/Yu-Gi-Oh-Forbidden-Memories-Recompiled`.

## O que existe

O jogo é um **port nativo para PC** do jogo de PS1, recompilado a partir do código
decompilado. Sobre ele, a branch acrescenta três coisas:

1. **Remote play.** O jogo roda no PC do host e um amigo joga como player 2 pelo
   navegador. A imagem e o som vão por WebRTC, e os botões do amigo voltam por
   um data channel.
2. **Câmera e voz.** Cada jogador vê a câmera do outro sobre o campo inimigo
   durante o próprio turno, e os dois conversam por voz.
3. **Duel Arena.** Duelos 1v1 (o 2P DUEL do jogo) com qualquer carta, cada
   jogador com um deck pronto ou montado no navegador. **Nenhum save é usado.**
   Com `MEMORIES_ARENA=1`, o jogo vai sozinho do título até a tela de Life
   Points, assim que os dois jogadores escolhem o deck.

Há três processos, todos no PC do host:

| Processo | Como inicia | Porta |
|---|---|---|
| Jogo (`memories-pc`, C) | `play-arena.bat` ou `play-arena.sh` | `127.0.0.1:47811`, só para o companion |
| Companion (Node.js + TypeScript) | `npm start` em `tools/remote-play` | `127.0.0.1:8700` para a página do host; `8701` para o convidado |
| Página do host (navegador) | abre sozinha em `http://127.0.0.1:8700` | — |

O amigo só acessa a porta 8701, pela rede local (`--lan`) ou pelo túnel
(`--tunnel`).

## Pré-requisitos (Windows)

- O repositório num **caminho curto**, por exemplo `C:\yfm`. Num caminho longo
  como `Downloads\...\...`, o build falha com `WinError 206` (limite de 260
  caracteres do Windows).
- O disco **americano** (SLUS-01411) como **`.bin` de um par BIN/CUE**, com
  setores brutos de 2352 bytes. **`.iso`, `.chd` e `.ecm` não funcionam.** O
  arquivo vai em `C:\yfm\game\`, com qualquer nome terminado em `.bin`.
- **Node.js 20 ou mais novo.**
- Para jogar pela internet: o programa **`cloudflared`** no PATH. O "quick
  tunnel" é gratuito e não precisa de conta.
- O `play.bat` baixa sozinho, na primeira vez, Python, o compilador
  (llvm-mingw) e as bibliotecas para `tmp\`. Isso leva alguns minutos.

## Passo a passo para jogar

```powershell
# 1. O jogo (terminal 1), na raiz do repositório
cd C:\yfm
.\play-arena.bat

# 2. O companion (terminal 2)
cd C:\yfm\tools\remote-play
npm install
npm start -- --tunnel      # pela internet (precisa do cloudflared)
# ou: npm start -- --lan   # só na rede local
```

O `play-arena.bat` define `MEMORIES_REMOTE_PLAY=1`, `MEMORIES_ARENA=1` e
`MEMORIES_MOD_DUEL_ARENA=1`, e depois chama o `play.bat`. No Linux, o
equivalente é `./play-arena.sh`.

3. Na página do host (`http://127.0.0.1:8700`), espere aparecer
   **"Game: connected"** e clique em **Start sharing**.
4. Copie o convite **"Internet (tunnel)"** (`https://....trycloudflare.com/#token`)
   e mande ao amigo. O link `http` da rede local também funciona, mas sem
   câmera, microfone e controle (o navegador exige https para isso).
5. O amigo abre o link, digita o nome e clica em **Join the game**.
6. No painel **Duel Arena**, nas duas páginas, cada um clica em **Play this
   deck**, com um deck pronto ou montado no construtor. O host também digita o
   nome que aparece no duelo.
7. Com os dois decks prontos, o jogo espera cerca de 2 s no título e segue
   sozinho: aperta Start, escolhe 2P DUEL e confirma a mensagem. Ele **para na
   tela de Life Points**, onde o host escolhe os pontos de vida e começa o duelo.
8. Ao fim do duelo, o jogo volta ao título e o próximo duelo começa sozinho.
   Para parar, um dos jogadores clica em **Take my deck back**.

Teclas do convidado: setas, X (Cross), S (Circle), Z (Square), A (Triangle),
Q/W (L1/R1), E/R (L2/R2), Enter (Start) e Shift (Select). Também funcionam
controle de videogame (só por https) e o controle na tela do celular.

## Testar sem o disco (jogo falso)

```bash
cd tools/remote-play
npm install
npm run fake-game           # terminal 1: imita o jogo, mesmo protocolo e mesma porta
npm start -- --no-open      # terminal 2; depois abra http://127.0.0.1:8700
npm test                    # 20 testes de unidade e integração (contra o jogo falso)
npm run test:e2e            # ponta a ponta em dois Chromium (CHROMIUM=/caminho/do/chrome)
```

Os testes em C usam o CMake do projeto. No Linux eles precisam de
`gcc-multilib`, porque o resto do projeto é 32-bit:

```bash
cmake -S . -B tmp/pc -DBUILD_TESTING=ON
cmake --build tmp/pc --target memories_remote_play_test memories_save_menu_test
cd tmp/pc && ctest -R "pc_remote_play|pc_save_menu" --output-on-failure
```

## Variáveis de ambiente

| Variável | Efeito |
|---|---|
| `MEMORIES_REMOTE_PLAY=1` (ou um número de porta) | Liga a ponte com o companion em `127.0.0.1:47811` |
| `MEMORIES_ARENA=1` | Com os dois decks escolhidos, o título vai sozinho ao 2P DUEL |
| `MEMORIES_MOD_DUEL_ARENA=1` | Liga o mod `duel-arena`: "DUEL ARENA" em primeiro no título, "TRADE" escondido |
| `MEMORIES_ARENA_DECKS=arquivo` | Decks sem o companion, para dois jogadores no mesmo PC. Uma linha por lado: `1: 1,1,1,20,...` e `2: ...`, 40 ids cada |

No PowerShell, uma variável se define assim: `$env:NOME=1; .\play.bat`. A
sintaxe `NOME=1 ./play.sh` só funciona no Linux.

## Linhas esperadas no console do jogo

```
memories-pc: remote play: waiting for the companion on 127.0.0.1:47811
memories-pc: remote play: companion connected
memories-pc: arena: both decks are in: on to 2P DUEL
memories-pc: arena: player 1 plays the arena deck as HOST
memories-pc: arena: player 2 plays the arena deck as JOEY
```

O companion também registra eventos: `game connected (protocol 3, ...)`,
`arena: player N plays "<deck>"`, `the guest (<nome>) joined as player 2`.

## Problemas conhecidos e soluções

| Sintoma | Causa e solução |
|---|---|
| `WinError 206 ... filename too long` no build | Caminho longo: mova o repositório para `C:\yfm` e apague `tmp\` |
| "Game: waiting" não muda | O jogo não foi iniciado com `MEMORIES_REMOTE_PLAY=1`. Use `play-arena.bat` e confira a primeira linha esperada no console |
| Os botões do amigo não fazem nada | O jogo só lê o controle 2 nos modos de dois jogadores. No título e no modo história, troque "Your friend plays as" para Player 1 |
| Câmera ou microfone indisponíveis para o amigo | O link é `http`. Use o link do túnel (`https`) |
| `"cloudflared" was not found` | Instale o cloudflared ou use `--lan` |
| O Firewall do Windows pergunta sobre o Node | Permita em rede privada (necessário com `--lan`) |
| O título não segue sozinho | Os dois decks precisam estar prontos (veja os indicadores no painel), e o jogo precisa ter sido aberto com `MEMORIES_ARENA=1` |
| Erro de link com `ws2_32`, `winsock` ou `remote_play` no `play.bat` | O build Windows dessa parte nunca foi compilado. O link ganhou `-lws2_32` em `tools/pc/build_game32.py`. Mande a mensagem de erro inteira |
| Eco do jogo na voz | O microfone do host capta o som do jogo pelas caixas de som. Use fone de ouvido |

## O que ainda falta validar no jogo real

Isso só pôde ser testado com o jogo falso e com testes automatizados: aqui não
havia disco e o build 32-bit não rodou.

- [ ] O build Windows compila com `remote_play.c` (Winsock) e `arena.c`.
- [ ] O título segue sozinho até a tela de Life Points (`arena_autostart` em
      `src/pc/platform/title_menu.c`) e a mensagem do 2P DUEL é confirmada
      sozinha (bloco `MEMORIES_PC` em `src/game/save_data_transfer_runtime.c`).
- [ ] O duelo usa os decks do Arena (os 40 ids no início do estado,
      `Duel_ShuffleBothDecks`).
- [ ] Os nomes aparecem certos. Eles são gravados em Shift JIS de largura
      total na posição 0x40C; a codificação foi deduzida do
      `Text_SjisToGlyphCodes`.
- [ ] O 2P DUEL roda com um estado zerado além de deck, código de duelista
      (0x334) e nome.
- [ ] A câmera do amigo aparece na janela do jogo, no seu turno, sobre o
      campo inimigo (`src/pc/platform/remote_play_overlay.c`).
- [ ] O menu do título com o mod `duel-arena` aparece certo.

Ao reportar um problema, inclua a saída dos dois terminais (jogo e companion),
o passo em que parou e, se houver, o arquivo `crash-*.txt` ou `hang-*.txt` de
`tmp\pc`.

## Mapa do código

| Área | Arquivos |
|---|---|
| Ponte do jogo (protocolo, socket, câmera, duelo) | `src/pc/platform/remote_play.c` e `.h` (o protocolo está documentado no `.h`), `remote_play_overlay.c` |
| Integração no jogo | `src/pc/sdk/libgpu.c` (quadros, duelo), `libetc.c` (controle), `libspu.c` (áudio), `src/pc/debug/hud.c` (câmera) |
| Duel Arena no jogo | `src/pc/saves/arena.c` e `.h`, `src/pc/saves/save_menu.c`, `src/pc/platform/title_menu.c`, `src/game/save_data_transfer_runtime.c` (bloco `MEMORIES_PC`) |
| Companion | `tools/remote-play/src/server/` (`companion.ts`, `game-link.ts`, `game-protocol.ts`, `cards.ts`, `tunnel.ts`, `fake-game.ts`) |
| Páginas | `tools/remote-play/src/web/` (`host.ts`, `guest.ts`, `media.ts`, `arena-ui.ts`), `public/` |
| Decks prontos | `tools/remote-play/decks/*.json` (cartas pelo nome; o catálogo é `notes/card-catalog.csv`) |
| Mod do título | `mods/duel-arena/mod.json` |
| Testes | `tests/pc/remote_play_test.c`, `tests/pc/save_menu_test.c`, `tools/remote-play/src/test/` |
| Documentação | `notes/remote-play.md`, `notes/duel-arena.md`, `tools/remote-play/README.md` |

Regras do repositório que o agente deve seguir:

- Não alterar o comportamento do build que reproduz o executável original
  byte a byte (`make match`). Código só do PC fica em `src/pc/` ou dentro de
  `#ifdef MEMORIES_PC`.
- Não commitar dados do jogo: `.bin`, arquivos extraídos do disco ou imagens
  das cartas.
- Rodar `npm test`, `npm run test:e2e` e os testes CTest antes de qualquer push.
