// Camera and voice, shared by both pages.
//
// The host's offer always has four media sections, in this order, so both
// sides know each one by its position and nothing has to be renegotiated
// when a camera or microphone is switched on later (replaceTrack):
//   0 the game's picture  host -> guest
//   1 the game's sound    host -> guest
//   2 voice               both ways
//   3 camera              both ways
import type { CameraOverlay, DuelState, MediaState } from "../shared/messages.js";

export const enum Section {
  GameVideo = 0,
  GameAudio = 1,
  Voice = 2,
  Camera = 3,
}

export const CAMERA_BITRATE = 400_000;

// getUserMedia needs a secure page: https (the tunnel), or 127.0.0.1.
export function mediaAvailable(): boolean {
  return window.isSecureContext && !!navigator.mediaDevices?.getUserMedia;
}

export class LocalMedia {
  camera: MediaStreamTrack | null = null;
  mic: MediaStreamTrack | null = null;

  get state(): MediaState {
    return { camera: !!this.camera, mic: !!this.mic };
  }

  async toggleCamera(): Promise<MediaStreamTrack | null> {
    if (this.camera) {
      this.camera.stop();
      this.camera = null;
    } else {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 320 }, height: { ideal: 240 }, frameRate: { ideal: 15, max: 30 } },
      });
      this.camera = stream.getVideoTracks()[0] ?? null;
    }
    return this.camera;
  }

  async toggleMic(): Promise<MediaStreamTrack | null> {
    if (this.mic) {
      this.mic.stop();
      this.mic = null;
    } else {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      this.mic = stream.getAudioTracks()[0] ?? null;
    }
    return this.mic;
  }

  // Put the current tracks on a connection's voice and camera sections.
  async attach(connection: RTCPeerConnection): Promise<void> {
    const sections = connection.getTransceivers();
    await sections[Section.Voice]?.sender.replaceTrack(this.mic);
    await sections[Section.Camera]?.sender.replaceTrack(this.camera);
  }
}

// Which section a received track belongs to.
export function sectionOf(connection: RTCPeerConnection, transceiver: RTCRtpTransceiver): number {
  return connection.getTransceivers().indexOf(transceiver);
}

export async function limitCameraBitrate(connection: RTCPeerConnection): Promise<void> {
  const sender = connection.getTransceivers()[Section.Camera]?.sender;
  if (!sender) return;
  const parameters = sender.getParameters();
  if (!parameters.encodings?.length) parameters.encodings = [{}];
  parameters.encodings[0]!.maxBitrate = CAMERA_BITRATE;
  await sender.setParameters(parameters).catch(() => undefined);
}

// Whether a viewer on `mySide` sees the other side's camera now.
export function cameraShown(overlay: CameraOverlay, duel: DuelState, mySide: number): boolean {
  if (overlay === "never" || !duel.inDuel) return false;
  return overlay === "always" || duel.turn === mySide;
}

export function setButton(button: HTMLButtonElement, on: boolean, what: string): void {
  button.textContent = `${what}: ${on ? "on" : "off"}`;
  button.classList.toggle("on", on);
  button.setAttribute("aria-pressed", String(on));
}
