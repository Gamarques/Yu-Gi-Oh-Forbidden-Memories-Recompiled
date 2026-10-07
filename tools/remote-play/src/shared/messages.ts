// The pad a guest holds: 1 is player 2, which the game reads only in its
// two-player duels and trades; 0 is player 1, alongside the host's own keys,
// which reaches every screen of the game.
export type GamePort = 0 | 1;

// JSON messages on the two WebSockets. Binary messages on the host socket
// carry the game's own payloads behind a one-byte kind (StreamKind).

// The WebRTC description and candidates, passed through untouched.
export interface SignalData {
  description?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit | null;
}

// --- the host page (private, 127.0.0.1 only) ---
export type ServerToHost =
  | {
      type: "config";
      invites: { label: string; url: string }[];
      iceServers: RTCIceServer[];
      tunnel: "off" | "starting" | "ready" | "failed";
      guestPort: GamePort;
    }
  | { type: "game"; connected: boolean; protocol?: number; audioRate?: number }
  | { type: "guest-joined"; name: string }
  | { type: "guest-left" }
  | { type: "relay"; on: boolean }
  | { type: "signal"; data: SignalData }
  | { type: "guest-pad"; bits: number }
  | { type: "guest-port"; port: GamePort };

export type HostToServer =
  | { type: "signal"; data: SignalData }
  | { type: "pad"; bits: number } // from the data channel, for the guest's port
  | { type: "rate"; divisor: number }
  | { type: "guest-port"; port: GamePort } // which pad the guest holds
  | { type: "kick" };

export const enum StreamKind {
  Video = 2, // u16 width, u16 height, u32 frame, width*height RGB555
  Audio = 3, // s16 stereo frames
  RelayFrame = 4, // host -> server -> guest: a JPEG picture
}

// --- the guest page (public, behind the invite link) ---
export type GuestToServer =
  | { type: "join"; token: string; name: string }
  | { type: "signal"; data: SignalData }
  | { type: "pad"; bits: number } // relay mode, or before the data channel opens
  | { type: "relay"; on: boolean };

export type ServerToGuest =
  | { type: "joined"; iceServers: RTCIceServer[]; port: GamePort }
  | { type: "player"; port: GamePort }
  | { type: "rejected"; reason: string }
  | { type: "signal"; data: SignalData }
  | { type: "host-left" }
  | { type: "kicked" };

export const GUEST_NAME_MAX = 24;
