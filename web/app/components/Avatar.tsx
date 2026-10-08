// Avatar: the uploaded image when there is one, otherwise the initial on a
// gradient whose hue comes from the address (stable per person).

import { TICKETD_URL } from "../lib/ticketd";

const hueOfAddr = (addr: string): number => parseInt(addr.slice(2, 8), 16) % 360;

export function Avatar({
  addr,
  name,
  hasAvatar,
  size = 40,
  ring = false,
  bust = 0,
}: {
  addr: string;
  name?: string | null;
  hasAvatar?: boolean;
  size?: number;
  ring?: boolean;
  bust?: number;
}) {
  const h = hueOfAddr(addr);
  const radius = Math.round(size * 0.28);
  const inner = (
    <span
      className="av"
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        fontSize: Math.round(size * 0.4),
        background: `linear-gradient(150deg, oklch(0.72 0.12 ${h}), oklch(0.36 0.08 ${(h + 50) % 360}))`,
      }}
    >
      {hasAvatar ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={`${TICKETD_URL}/profile/avatar/${addr}${bust ? `?t=${bust}` : ""}`} alt="" />
      ) : (
        (name?.trim()[0] ?? addr.slice(2, 3)).toUpperCase()
      )}
    </span>
  );
  if (!ring) return inner;
  return (
    <span className="av-ring" style={{ borderRadius: radius + 4, padding: Math.max(3, Math.round(size / 32)) }}>
      {inner}
    </span>
  );
}

export const shortAddr = (a: string): string => `${a.slice(0, 6)}…${a.slice(-4)}`;
