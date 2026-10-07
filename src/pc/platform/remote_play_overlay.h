#ifndef MEMORIES_PC_REMOTE_PLAY_OVERLAY_H
#define MEMORIES_PC_REMOTE_PLAY_OVERLAY_H
#include "pc/platform/menu.h"
/* The remote player's camera in the window (remote_play_overlay.c), drawn
 * with the HUD (hud.c); the bounds it drew, or zeros. */
void RemotePlayOverlay_Draw(MenuCanvas *canvas, int *x, int *y, int *w, int *h);
unsigned RemotePlayOverlay_Signature(void);
#endif
