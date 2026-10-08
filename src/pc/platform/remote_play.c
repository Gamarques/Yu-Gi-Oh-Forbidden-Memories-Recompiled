/* Remote play bridge (remote_play.h, notes/remote-play.md). Everything but
 * RemotePlay_Audio and the two pad queries runs on the main thread, from
 * Memories_PresentDisplay; the socket is non-blocking, so a slow companion
 * costs the game dropped pictures, never a stall. */
#define _GNU_SOURCE
#include "remote_play.h"
#include "pc/saves/arena.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#ifdef _WIN32
#include <winsock2.h>
#include <ws2tcpip.h>
typedef SOCKET Socket;
#define NO_SOCKET INVALID_SOCKET
#define close_socket closesocket
#define SEND_FLAGS 0
#else
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <sys/socket.h>
#include <unistd.h>
typedef int Socket;
#define NO_SOCKET (-1)
#define close_socket close
/* A companion that went away must not end the game with SIGPIPE. */
#define SEND_FLAGS MSG_NOSIGNAL
#endif

#define HEADER_BYTES 8
#define AUDIO_RATE 44100
/* About three quarters of a second of stereo sound, a power of two. */
#define RING_FRAMES 32768u
#define MAX_RATE 60
/* The largest message the companion sends: a camera picture. */
#define IN_BYTES (HEADER_BYTES + 4 + REMOTE_PLAY_CAMERA_MAX_W * REMOTE_PLAY_CAMERA_MAX_H * 2)
/* A camera picture older than this many game frames (two seconds) is not shown. */
#define CAMERA_STALE_FRAMES 120u

static int enabled = -1, port_number, failed;
static Socket listener = NO_SOCKET, client = NO_SOCKET;
static volatile uint16_t remote_bits[2];
static volatile int remote_present[2];
static int frame_divisor = 2; /* 30 pictures a second */
static unsigned frames_seen;

static unsigned char *out;
static size_t out_length, out_sent, out_capacity;
static unsigned char in[IN_BYTES];
static size_t in_length;

/* The duel as the game last reported it, and as the companion was told. */
static int duel_on, duel_turn, sent_duel = -1;
/* The remote player's camera. */
static uint16_t camera[REMOTE_PLAY_CAMERA_MAX_W * REMOTE_PLAY_CAMERA_MAX_H];
static int camera_w, camera_h, overlay_mode = REMOTE_PLAY_OVERLAY_MY_TURN;
static unsigned camera_serial, camera_frame;

/* Sound: the audio thread writes, the main thread reads. */
static int16_t ring[RING_FRAMES * 2];
static unsigned ring_head, ring_tail;
static int streaming;

int RemotePlay_Enabled(void)
{
    if (enabled < 0) {
        const char *value = getenv("MEMORIES_REMOTE_PLAY");
        long number = value && *value ? strtol(value, NULL, 10) : 0;
        enabled = number > 0 && number < 65536;
        port_number = number > 1 ? (int)number : REMOTE_PLAY_DEFAULT_PORT;
    }
    return enabled;
}

static int would_block(void)
{
#ifdef _WIN32
    int error = WSAGetLastError();
    return error == WSAEWOULDBLOCK || error == WSAEINTR;
#else
    /* The game's 1 kHz timer signal interrupts system calls: try next frame. */
    return errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR;
#endif
}

static int set_non_blocking(Socket socket_handle)
{
#ifdef _WIN32
    u_long on = 1;
    return ioctlsocket(socket_handle, FIONBIO, &on) == 0;
#else
    int flags = fcntl(socket_handle, F_GETFL, 0);
    return flags >= 0 && fcntl(socket_handle, F_SETFL, flags | O_NONBLOCK) == 0;
#endif
}

static int open_listener(void)
{
    struct sockaddr_in address;
    int on = 1;
#ifdef _WIN32
    WSADATA data;
    if (WSAStartup(MAKEWORD(2, 2), &data) != 0) return 0;
#endif
    listener = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (listener == NO_SOCKET) return 0;
    setsockopt(listener, SOL_SOCKET, SO_REUSEADDR, (const char *)&on, sizeof(on));
    memset(&address, 0, sizeof(address));
    address.sin_family = AF_INET;
    address.sin_port = htons((unsigned short)port_number);
    address.sin_addr.s_addr = htonl(INADDR_LOOPBACK); /* never the network */
    if (bind(listener, (struct sockaddr *)&address, sizeof(address)) != 0 || listen(listener, 1) != 0 ||
        !set_non_blocking(listener)) {
        close_socket(listener);
        listener = NO_SOCKET;
        return 0;
    }
    fprintf(stderr, "memories-pc: remote play: waiting for the companion on 127.0.0.1:%d\n", port_number);
    return 1;
}

static void put16(unsigned char *at, unsigned value)
{
    at[0] = (unsigned char)value;
    at[1] = (unsigned char)(value >> 8);
}

static void put32(unsigned char *at, uint32_t value)
{
    put16(at, value & 0xffffu);
    put16(at + 2, value >> 16);
}

/* Room for `payload` more bytes after a header of `type`; NULL when memory
 * runs out, and the message is then left out. */
static unsigned char *begin_message(int type, size_t payload)
{
    unsigned char *at;
    if (out_length + HEADER_BYTES + payload > out_capacity) {
        size_t wanted = out_length + HEADER_BYTES + payload;
        unsigned char *grown = realloc(out, wanted);
        if (!grown) return NULL;
        out = grown;
        out_capacity = wanted;
    }
    at = out + out_length;
    memset(at, 0, HEADER_BYTES);
    at[0] = (unsigned char)type;
    put32(at + 4, (uint32_t)payload);
    out_length += HEADER_BYTES + payload;
    return at + HEADER_BYTES;
}

static void drop_client(const char *why)
{
    int port;
    if (client == NO_SOCKET) return;
    close_socket(client);
    client = NO_SOCKET;
    __atomic_store_n(&streaming, 0, __ATOMIC_RELEASE);
    for (port = 0; port < 2; port++) {
        remote_bits[port] = 0;
        remote_present[port] = 0;
    }
    out_length = out_sent = in_length = 0;
    camera_w = camera_h = 0;
    sent_duel = -1;
    Arena_ClearFrom(ARENA_FROM_COMPANION);
    overlay_mode = REMOTE_PLAY_OVERLAY_MY_TURN;
    fprintf(stderr, "memories-pc: remote play: companion left (%s)\n", why);
}

static void accept_client(void)
{
    unsigned char *hello;
    int on = 1, buffer = 4 << 20;
    Socket accepted = accept(listener, NULL, NULL);
    if (accepted == NO_SOCKET) return;
    if (!set_non_blocking(accepted)) {
        close_socket(accepted);
        return;
    }
    setsockopt(accepted, IPPROTO_TCP, TCP_NODELAY, (const char *)&on, sizeof(on));
    /* A whole picture fits, so one usually goes out in one call. */
    setsockopt(accepted, SOL_SOCKET, SO_SNDBUF, (const char *)&buffer, sizeof(buffer));
    client = accepted;
    frame_divisor = 2;
    /* Start the sound from now, not from what was mixed before. */
    __atomic_store_n(&ring_tail, __atomic_load_n(&ring_head, __ATOMIC_ACQUIRE), __ATOMIC_RELEASE);
    __atomic_store_n(&streaming, 1, __ATOMIC_RELEASE);
    if ((hello = begin_message(REMOTE_PLAY_HELLO, 8)) != NULL) {
        put32(hello, REMOTE_PLAY_PROTOCOL);
        put32(hello + 4, AUDIO_RATE);
    }
    fprintf(stderr, "memories-pc: remote play: companion connected\n");
}

static void handle_message(const unsigned char *message, const unsigned char *payload, uint32_t length)
{
    int port = length >= 1 && payload[0] < 2 ? payload[0] : -1;
    switch (message[0]) {
    case REMOTE_PLAY_PAD:
        if (port >= 0 && length >= 4) remote_bits[port] = (uint16_t)(payload[2] | payload[3] << 8);
        break;
    case REMOTE_PLAY_PRESENCE:
        if (port >= 0 && length >= 2) {
            remote_present[port] = payload[1] != 0;
            if (!payload[1]) remote_bits[port] = 0;
        }
        break;
    case REMOTE_PLAY_RATE:
        if (length >= 1 && payload[0] >= 1 && payload[0] <= MAX_RATE) frame_divisor = payload[0];
        break;
    case REMOTE_PLAY_CAMERA: {
        unsigned w = length >= 4 ? (unsigned)(payload[0] | payload[1] << 8) : 0;
        unsigned h = length >= 4 ? (unsigned)(payload[2] | payload[3] << 8) : 0;
        unsigned i;
        if (w > REMOTE_PLAY_CAMERA_MAX_W || h > REMOTE_PLAY_CAMERA_MAX_H || length < 4 + w * h * 2) break;
        for (i = 0; i < w * h; i++) camera[i] = (uint16_t)((payload[4 + i * 2] | payload[5 + i * 2] << 8) & 0x7fff);
        camera_w = (int)w;
        camera_h = (int)h;
        camera_serial++;
        camera_frame = frames_seen;
        break;
    }
    case REMOTE_PLAY_ARENA_DECK:
        if (port >= 0 && length >= 2 && payload[1] == 0) {
            Arena_SetDeck(port, NULL, ARENA_FROM_COMPANION);
        } else if (port >= 0 && payload[1] == ARENA_DECK_SIZE && length >= 2 + ARENA_DECK_SIZE * 2) {
            uint16_t ids[ARENA_DECK_SIZE];
            int i;
            for (i = 0; i < ARENA_DECK_SIZE; i++) ids[i] = (uint16_t)(payload[2 + i * 2] | payload[3 + i * 2] << 8);
            if (!Arena_SetDeck(port, ids, ARENA_FROM_COMPANION)) {
                fprintf(stderr, "memories-pc: remote play: arena deck for player %d refused\n", port + 1);
            }
        }
        break;
    case REMOTE_PLAY_OVERLAY:
        if (length >= 1 && payload[0] <= REMOTE_PLAY_OVERLAY_ALWAYS) overlay_mode = payload[0];
        break;
    default:
        break; /* a later companion's message: skipped */
    }
}

static void read_messages(void)
{
    for (;;) {
        size_t used = 0;
        int got = recv(client, (char *)in + in_length, (int)(sizeof(in) - in_length), 0);
        if (got == 0) {
            drop_client("closed");
            return;
        }
        if (got < 0) {
            if (!would_block()) drop_client("read error");
            return;
        }
        in_length += (size_t)got;
        while (in_length - used >= HEADER_BYTES) {
            const unsigned char *message = in + used;
            uint32_t length = (uint32_t)message[4] | (uint32_t)message[5] << 8 | (uint32_t)message[6] << 16 |
                              (uint32_t)message[7] << 24;
            if (length > sizeof(in) - HEADER_BYTES) {
                drop_client("message too long");
                return;
            }
            if (in_length - used < HEADER_BYTES + length) break;
            handle_message(message, message + HEADER_BYTES, length);
            used += HEADER_BYTES + length;
        }
        memmove(in, in + used, in_length - used);
        in_length -= used;
    }
}

static void flush_output(void)
{
    while (client != NO_SOCKET && out_sent < out_length) {
        size_t left = out_length - out_sent;
        int sent = send(client, (const char *)out + out_sent, (int)(left > (1u << 30) ? 1u << 30 : left), SEND_FLAGS);
        if (sent < 0) {
            if (!would_block()) drop_client("write error");
            return;
        }
        out_sent += (size_t)sent;
    }
    if (out_sent == out_length) out_length = out_sent = 0;
}

static void queue_audio(void)
{
    unsigned head = __atomic_load_n(&ring_head, __ATOMIC_ACQUIRE);
    unsigned tail = __atomic_load_n(&ring_tail, __ATOMIC_RELAXED);
    unsigned count = head - tail, first, index = tail & (RING_FRAMES - 1);
    unsigned char *payload;
    if (!count || !(payload = begin_message(REMOTE_PLAY_AUDIO, (size_t)count * 4))) return;
    first = count < RING_FRAMES - index ? count : RING_FRAMES - index;
    memcpy(payload, ring + index * 2, (size_t)first * 4);
    memcpy(payload + (size_t)first * 4, ring, (size_t)(count - first) * 4);
    __atomic_store_n(&ring_tail, tail + count, __ATOMIC_RELEASE);
}

static void queue_picture(const uint16_t *vram, int stride, int x, int y, int w, int h, int rgb24)
{
    unsigned char *payload;
    int row, column;
    if (w <= 0 || h <= 0 || w > 1024 || h > 512) return;
    if (!(payload = begin_message(REMOTE_PLAY_VIDEO, 8 + (size_t)w * (size_t)h * 2))) return;
    put16(payload, (unsigned)w);
    put16(payload + 2, (unsigned)h);
    put32(payload + 4, frames_seen);
    payload += 8;
    for (row = 0; row < h; row++) {
        const uint16_t *line = vram + (size_t)((y + row) & 511) * (size_t)stride;
        for (column = 0; column < w; column++, payload += 2) {
            unsigned pixel;
            if (rgb24) {
                /* Three bytes a pixel from the area's first halfword (a movie). */
                const unsigned char *rgb = (const unsigned char *)(line + (x & 1023)) + column * 3;
                pixel = (unsigned)(rgb[0] >> 3) | (unsigned)(rgb[1] >> 3) << 5 | (unsigned)(rgb[2] >> 3) << 10;
            } else {
                pixel = line[(x + column) & 1023] & 0x7fffu;
            }
            put16(payload, pixel);
        }
    }
}

void RemotePlay_Frame(const uint16_t *vram, int stride, int x, int y, int w, int h, int rgb24)
{
    if (!RemotePlay_Enabled() || failed) return;
    if (listener == NO_SOCKET && !open_listener()) {
        failed = 1;
        fprintf(stderr, "memories-pc: remote play: cannot listen on 127.0.0.1:%d\n", port_number);
        return;
    }
    frames_seen++;
    if (client == NO_SOCKET) accept_client();
    if (client == NO_SOCKET) return;
    read_messages();
    flush_output();
    /* Still sending the last picture: this one is dropped, the sound waits. */
    if (client == NO_SOCKET || out_length) return;
    if (duel_on * 2 + duel_turn != sent_duel) {
        unsigned char *duel = begin_message(REMOTE_PLAY_DUEL, 2);
        if (duel) {
            duel[0] = (unsigned char)duel_on;
            duel[1] = (unsigned char)duel_turn;
            sent_duel = duel_on * 2 + duel_turn;
        }
    }
    queue_audio();
    if (vram && frames_seen % (unsigned)frame_divisor == 0) queue_picture(vram, stride, x, y, w, h, rgb24);
    flush_output();
}

void RemotePlay_Audio(const int16_t *frames, size_t count)
{
    unsigned head, tail, room, index, first;
    if (!enabled || !__atomic_load_n(&streaming, __ATOMIC_ACQUIRE)) return;
    head = __atomic_load_n(&ring_head, __ATOMIC_RELAXED);
    tail = __atomic_load_n(&ring_tail, __ATOMIC_ACQUIRE);
    room = RING_FRAMES - (head - tail);
    if (count > room) count = room; /* the companion fell behind: the rest is lost */
    index = head & (RING_FRAMES - 1);
    first = (unsigned)count < RING_FRAMES - index ? (unsigned)count : RING_FRAMES - index;
    memcpy(ring + index * 2, frames, (size_t)first * 4);
    memcpy(ring, frames + first * 2, (count - first) * 4);
    __atomic_store_n(&ring_head, head + (unsigned)count, __ATOMIC_RELEASE);
}

void RemotePlay_SetDuel(int in_duel, int turn)
{
    duel_on = in_duel != 0;
    duel_turn = in_duel && turn ? 1 : 0;
}

const uint16_t *RemotePlay_Camera(int *width, int *height, unsigned *serial)
{
    int shown = client != NO_SOCKET && camera_w > 0 && camera_h > 0 && duel_on &&
                frames_seen - camera_frame <= CAMERA_STALE_FRAMES &&
                (overlay_mode == REMOTE_PLAY_OVERLAY_ALWAYS || (overlay_mode == REMOTE_PLAY_OVERLAY_MY_TURN && duel_turn == 0));
    if (!shown) return NULL;
    *width = camera_w;
    *height = camera_h;
    *serial = camera_serial;
    return camera;
}

uint16_t RemotePlay_Pad(int port)
{
    return port == 0 || port == 1 ? remote_bits[port] : 0;
}

int RemotePlay_PadConnected(int port)
{
    return (port == 0 || port == 1) && remote_present[port];
}

void RemotePlay_Shutdown(void)
{
    drop_client("shutdown");
    if (listener != NO_SOCKET) close_socket(listener);
    listener = NO_SOCKET;
    free(out);
    out = NULL;
    out_capacity = 0;
    enabled = -1;
    failed = 0;
    frames_seen = 0;
    duel_on = duel_turn = 0;
}
