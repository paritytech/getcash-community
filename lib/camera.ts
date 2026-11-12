// The camera, for scanning a QR code in the page. Inside the host the host grants it first: its
// webview opens the camera only for a product that holds the permission. Outside it the browser
// asks on its own.
import { requestDevicePermission } from "@parity/product-sdk-host";
import { isHosted } from "./host-account";

/** Why the camera did not open: the user or the host refused it, or there is none to open. */
export type CameraFailure = "denied" | "unavailable";

export class CameraError extends Error {
  constructor(
    readonly kind: CameraFailure,
    message: string,
  ) {
    super(message);
    this.name = "CameraError";
  }
}

/** The back camera's stream, the one a code is pointed at. Throws a CameraError. */
export async function openCamera(): Promise<MediaStream> {
  if (isHosted()) {
    const granted = await requestDevicePermission("Camera");
    if (!granted.ok) throw new CameraError("unavailable", "the host could not be asked");
    if (!granted.value) throw new CameraError("denied", "the host did not grant the camera");
  }
  if (navigator.mediaDevices?.getUserMedia === undefined) {
    throw new CameraError("unavailable", "this webview has no camera API");
  }
  try {
    return await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" } },
      audio: false,
    });
  } catch (error: unknown) {
    const name = error instanceof DOMException ? error.name : "";
    const denied = name === "NotAllowedError" || name === "SecurityError";
    throw new CameraError(denied ? "denied" : "unavailable", String(error));
  }
}
