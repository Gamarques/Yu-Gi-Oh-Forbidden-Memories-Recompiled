#ifndef MEMORIES_PC_REMOTE_PLAY_H
#define MEMORIES_PC_REMOTE_PLAY_H
/* Remote play bridge (notes/remote-play.md): with MEMORIES_REMOTE_PLAY set,
 * the game listens on 127.0.0.1 for one local companion program
 * (tools/remote-play), sends it every shown picture at the console's own
 * resolution and the mixed sound, and takes pad bits from it for either
 * port. The companion does the web part -- the browser pages, WebRTC, the
 * invite link -- so the game itself never faces the network: the socket is
 * bound to the loopback address only.
 *
 * MEMORIES_REMOTE_PLAY=1 listens on the default port (47811); any other
 * number is the port. Unset, nothing here opens anything and every query
 * answers zero.
 *
 * Wire format, little-endian, one message after another in both directions:
 * an 8-byte header {u8 type, u8 0, u16 0, u32 payload length}, then the
 * payload.
 *   game -> companion
 *     REMOTE_PLAY_HELLO  u32 protocol version, u32 audio rate (44100)
 *     REMOTE_PLAY_VIDEO  u16 width, u16 height, u32 frame number, then
 *                        width x height 15-bit pixels as the GPU keeps them
 *                        (red in bits 0-4, green 5-9, blue 10-14)
 *     REMOTE_PLAY_AUDIO  signed 16-bit stereo frames
 *   companion -> game
 *     REMOTE_PLAY_PAD       u8 port (0 or 1), u8 0, u16 PS1 pad bits
 *                           (active high, as Platform_Pad)
 *     REMOTE_PLAY_PRESENCE  u8 port, u8 1 when a remote player holds it;
 *                           a held port 1 counts as a connected pad, so the
 *                           game offers its two-player duels and trades
 *     REMOTE_PLAY_RATE      u8 n: a picture every n game frames (1-60) */
#include <stddef.h>
#include <stdint.h>

#define REMOTE_PLAY_DEFAULT_PORT 47811
#define REMOTE_PLAY_PROTOCOL 1
enum {
    REMOTE_PLAY_HELLO = 1,
    REMOTE_PLAY_VIDEO = 2,
    REMOTE_PLAY_AUDIO = 3,
    REMOTE_PLAY_PAD = 16,
    REMOTE_PLAY_PRESENCE = 17,
    REMOTE_PLAY_RATE = 18
};

/* Whether MEMORIES_REMOTE_PLAY asks for the bridge. */
int RemotePlay_Enabled(void);
/* Main thread, once per presented game frame: accept the companion, read
 * what it sent, and send it the display area of VRAM (`stride` halfwords a
 * row, coordinates wrapping as the GPU's do; `rgb24` for a 24-bit movie
 * frame) and the sound mixed since. Never blocks: a picture that would not
 * fit in the socket is dropped. */
void RemotePlay_Frame(const uint16_t *vram, int stride, int x, int y, int w, int h, int rgb24);
/* The audio thread, after each mix. */
void RemotePlay_Audio(const int16_t *frames, size_t count);
/* The remote player's pad bits and whether one holds the port.
 * Async-signal-safe: they only read words RemotePlay_Frame writes. */
uint16_t RemotePlay_Pad(int port);
int RemotePlay_PadConnected(int port);
/* Close the sockets (tests; the game just exits). */
void RemotePlay_Shutdown(void);
#endif
