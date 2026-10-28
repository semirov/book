/**
 * One tap, as a browser sends it: `pointerdown` → `pointerup` → `click` (`detail: 1`).
 *
 * The click belongs to the same gesture. A paragraph that opens on both the pointer's release
 * and the click makes one tap two toggles — the block mounts and unmounts in the same gesture,
 * which is the owner's phone defect. Tests must send the whole gesture, not a bare `pointerup`,
 * or they cannot see it.
 */
export function tapAt(target: HTMLElement, x = 4, y = 4): void {
  const at = { bubbles: true, clientX: x, clientY: y };
  target.dispatchEvent(new PointerEvent('pointerdown', { ...at, pointerId: 1, isPrimary: true }));
  target.dispatchEvent(new PointerEvent('pointerup', { ...at, pointerId: 1, isPrimary: true }));
  target.dispatchEvent(new MouseEvent('click', { ...at, detail: 1 }));
}
