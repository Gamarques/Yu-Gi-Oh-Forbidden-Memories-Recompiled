/* The remote player's camera over the opponent's field (remote_play.h): in
 * a duel, during the turn the overlay setting asks for, a framed picture at
 * the top middle of the game's picture, where the far side of the field is.
 * It is drawn in the window's overlay, not into the game's own picture, so
 * the stream the remote player watches never carries their own face. */
#include "remote_play_overlay.h"
#include "remote_play.h"
#include "pc/cards/fusion_helper.h"

#define BORDER_RGB 0xb48cffu

static struct { int x, y, w, h; } shown;

static void put(MenuCanvas *canvas, int x, int y, uint32_t rgb)
{
    if (x < 0 || y < 0 || x >= canvas->width || y >= canvas->height) return;
    canvas->pixels[(size_t)y * (size_t)canvas->stride + (size_t)x] = 0xff000000u | rgb;
}

void RemotePlayOverlay_Draw(MenuCanvas *canvas, int *x, int *y, int *w, int *h)
{
    int vx, vy, vw, vh, field_w, box_w, box_h, box_x, box_y, border, row, column, cw, ch;
    unsigned serial;
    const uint16_t *camera = RemotePlay_Camera(&cw, &ch, &serial);
    *x = *y = *w = *h = 0;
    shown.w = 0;
    if (!camera || !canvas || !canvas->pixels) return;
    FusionHelper_GetViewport(&vx, &vy, &vw, &vh);
    if (vw <= 0 || vh <= 0) return;
    /* Sized against the 4:3 field, so a widescreen window does not stretch it. */
    field_w = vh * 4 / 3 < vw ? vh * 4 / 3 : vw;
    box_w = field_w * 30 / 100;
    box_h = box_w * ch / cw;
    box_x = vx + (vw - box_w) / 2;
    box_y = vy + vh * 9 / 100;
    border = box_w / 80 + 1;
    for (row = -border; row < box_h + border; row++) {
        for (column = -border; column < box_w + border; column++) {
            uint32_t rgb = BORDER_RGB;
            if (row >= 0 && row < box_h && column >= 0 && column < box_w) {
                unsigned pixel = camera[(row * ch / box_h) * cw + column * cw / box_w];
                unsigned r = (pixel & 0x1f) << 3, g = (pixel >> 5 & 0x1f) << 3, b = (pixel >> 10 & 0x1f) << 3;
                rgb = r << 16 | g << 8 | b;
            }
            put(canvas, box_x + column, box_y + row, rgb);
        }
    }
    shown.x = box_x - border;
    shown.y = box_y - border;
    shown.w = box_w + 2 * border;
    shown.h = box_h + 2 * border;
    *x = shown.x; *y = shown.y; *w = shown.w; *h = shown.h;
}

unsigned RemotePlayOverlay_Signature(void)
{
    int w, h, vx, vy, vw, vh;
    unsigned serial;
    if (!RemotePlay_Camera(&w, &h, &serial)) return shown.w ? 1u : 0u;
    FusionHelper_GetViewport(&vx, &vy, &vw, &vh);
    return serial * 2654435761u ^ (unsigned)(vx * 31 + vy * 17 + vw * 7 + vh) ^ 2u;
}
