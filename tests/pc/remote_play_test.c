#define _GNU_SOURCE
#include "pc/platform/remote_play.h"
#include <arpa/inet.h>
#include <assert.h>
#include <netinet/in.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

/* The game half of remote play against a companion played by this test:
 * the greeting, a picture as the GPU keeps it (wrapping, 24-bit movies
 * converted), the sound, pad bits and presence for port 1, the picture
 * rate, and everything let go when the companion leaves. */

static uint16_t vram[1024 * 512];
static unsigned char message[8 + 8 + 1024 * 512 * 2];

static void read_exactly(int socket_handle, unsigned char *into, size_t length)
{
    while (length) {
        ssize_t got = recv(socket_handle, into, length, 0);
        assert(got > 0);
        into += got;
        length -= (size_t)got;
    }
}

static unsigned get16(const unsigned char *at) { return (unsigned)at[0] | (unsigned)at[1] << 8; }
static uint32_t get32(const unsigned char *at) { return get16(at) | (uint32_t)get16(at + 2) << 16; }

/* One message: its type, and its payload in `message` + 8. */
static int next_message(int socket_handle, uint32_t *length)
{
    read_exactly(socket_handle, message, 8);
    *length = get32(message + 4);
    assert(*length <= sizeof(message) - 8);
    read_exactly(socket_handle, message + 8, *length);
    return message[0];
}

static void send_message(int socket_handle, int type, const unsigned char *payload, uint32_t length)
{
    unsigned char header[8] = {0};
    header[0] = (unsigned char)type;
    header[4] = (unsigned char)length;
    assert(send(socket_handle, header, 8, 0) == 8);
    assert(send(socket_handle, payload, length, 0) == (ssize_t)length);
}

static void frame(int x, int y, int w, int h, int rgb24)
{
    RemotePlay_Frame(vram, 1024, x, y, w, h, rgb24);
}

int main(void)
{
    char port_text[16];
    int port = 40000 + (int)(getpid() % 20000), companion, x, y;
    struct sockaddr_in address;
    unsigned char pad[4] = {1, 0, 0x08, 0x40}, presence[2] = {1, 1}, rate[1] = {1};
    int16_t sound[200];
    uint32_t length;
    snprintf(port_text, sizeof(port_text), "%d", port);
    setenv("MEMORIES_REMOTE_PLAY", port_text, 1);
    assert(RemotePlay_Enabled());
    for (y = 0; y < 512; y++)
        for (x = 0; x < 1024; x++) vram[y * 1024 + x] = (uint16_t)(0x8000u | ((unsigned)(x * 7 + y * 13) & 0x7fffu));

    frame(0, 0, 320, 240, 0); /* listens; nobody there yet */
    assert(!RemotePlay_PadConnected(1) && RemotePlay_Pad(1) == 0);
    companion = socket(AF_INET, SOCK_STREAM, 0);
    memset(&address, 0, sizeof(address));
    address.sin_family = AF_INET;
    address.sin_port = htons((unsigned short)port);
    address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    assert(connect(companion, (struct sockaddr *)&address, sizeof(address)) == 0);

    /* Frame 2: the greeting, then a picture (every second frame by default),
     * wrapping across the right edge of VRAM, the mask bit left out. */
    frame(1000, 500, 64, 20, 0);
    assert(next_message(companion, &length) == REMOTE_PLAY_HELLO && length == 8);
    assert(get32(message + 8) == REMOTE_PLAY_PROTOCOL && get32(message + 12) == 44100);
    assert(next_message(companion, &length) == REMOTE_PLAY_VIDEO && length == 8 + 64 * 20 * 2);
    assert(get16(message + 8) == 64 && get16(message + 10) == 20 && get32(message + 12) == 2);
    for (y = 0; y < 20; y++)
        for (x = 0; x < 64; x++) {
            unsigned want = vram[((500 + y) & 511) * 1024 + ((1000 + x) & 1023)] & 0x7fffu;
            assert(get16(message + 16 + (y * 64 + x) * 2) == want);
        }

    /* Frame 3: the sound mixed since, and no picture. */
    for (x = 0; x < 200; x++) sound[x] = (int16_t)(x * 100 - 9000);
    RemotePlay_Audio(sound, 100);
    frame(0, 0, 320, 240, 0);
    assert(next_message(companion, &length) == REMOTE_PLAY_AUDIO && length == 400);
    assert(memcmp(message + 8, sound, 400) == 0);

    /* Pad bits and presence for port 1, then a picture every frame: a
     * 24-bit movie frame comes out as 15-bit pixels. */
    send_message(companion, REMOTE_PLAY_PAD, pad, 4);
    send_message(companion, REMOTE_PLAY_PRESENCE, presence, 2);
    send_message(companion, REMOTE_PLAY_RATE, rate, 1);
    memcpy(vram + 10 * 1024 + 16, "\xff\x80\x08\x10\x20\x30", 6);
    frame(16, 10, 2, 1, 1);
    assert(RemotePlay_Pad(1) == 0x4008 && RemotePlay_PadConnected(1));
    assert(RemotePlay_Pad(0) == 0 && !RemotePlay_PadConnected(0) && !RemotePlay_PadConnected(2));
    assert(next_message(companion, &length) == REMOTE_PLAY_VIDEO && length == 8 + 4);
    assert(get16(message + 16) == (0x1f | 0x10 << 5 | 0x01 << 10));
    assert(get16(message + 18) == (0x02 | 0x04 << 5 | 0x06 << 10));

    /* The companion leaves: the port is let go. */
    close(companion);
    frame(0, 0, 320, 240, 0);
    assert(RemotePlay_Pad(1) == 0 && !RemotePlay_PadConnected(1));
    RemotePlay_Shutdown();
    puts("remote play: ok");
    return 0;
}
