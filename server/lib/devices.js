// Which devices participants may use, e.g. ["computer"] or ["computer", "tablet"].

export const DEVICES = {
  computer: "a computer (desktop or laptop)",
  tablet: "a tablet",
  phone: "a phone",
};

/** The allowed devices (computers only when unset). */
export function devicesOf(given) {
  const devices = given ?? ["computer"];
  if (!Array.isArray(devices) || devices.length === 0 || devices.some((d) => !(d in DEVICES))) {
    throw new Error(`deviceCheck({ devices }): devices must be a list of "computer", "tablet" and "phone", e.g. ["computer"].`);
  }
  return devices;
}

/** "a computer (desktop or laptop) or a tablet" */
export function describeDevices(devices) {
  const names = devices.map((d) => DEVICES[d]);
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} or ${names.at(-1)}` : names[0];
}

/** What kind of device this browser is on: "computer", "tablet" or "phone". */
export function deviceType(nav = globalThis.navigator) {
  const ua = nav?.userAgent ?? "";
  // iPads report themselves as Macs, but Macs have no touch screen.
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && nav.maxTouchPoints > 1)) return "tablet";
  if (/iPhone|iPod|Windows Phone/.test(ua) || (/Android/.test(ua) && /Mobile/.test(ua))) return "phone";
  if (/Android|Tablet/.test(ua)) return "tablet";
  if (nav?.userAgentData?.mobile) return "phone";
  return "computer";
}
