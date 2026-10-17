// RDP PS/2 Set 1 Scancode Mapping for ironrdp-wasm
export const SCANCODE_MAP = {
  'Escape': 0x01, 'Digit1': 0x02, 'Digit2': 0x03, 'Digit3': 0x04,
  'Digit4': 0x05, 'Digit5': 0x06, 'Digit6': 0x07, 'Digit7': 0x08,
  'Digit8': 0x09, 'Digit9': 0x0A, 'Digit0': 0x0B, 'Minus': 0x0C,
  'Equal': 0x0D, 'Backspace': 0x0E, 'Tab': 0x0F,
  'KeyQ': 0x10, 'KeyW': 0x11, 'KeyE': 0x12, 'KeyR': 0x13,
  'KeyT': 0x14, 'KeyY': 0x15, 'KeyU': 0x16, 'KeyI': 0x17,
  'KeyO': 0x18, 'KeyP': 0x19, 'BracketLeft': 0x1A, 'BracketRight': 0x1B,
  'Enter': 0x1C, 'ControlLeft': 0x1D,
  'KeyA': 0x1E, 'KeyS': 0x1F, 'KeyD': 0x20, 'KeyF': 0x21,
  'KeyG': 0x22, 'KeyH': 0x23, 'KeyJ': 0x24, 'KeyK': 0x25,
  'KeyL': 0x26, 'Semicolon': 0x27, 'Quote': 0x28, 'Backquote': 0x29,
  'ShiftLeft': 0x2A, 'Backslash': 0x2B,
  'KeyZ': 0x2C, 'KeyX': 0x2D, 'KeyC': 0x2E, 'KeyV': 0x2F,
  'KeyB': 0x30, 'KeyN': 0x31, 'KeyM': 0x32, 'Comma': 0x33,
  'Period': 0x34, 'Slash': 0x35, 'ShiftRight': 0x36,
  'NumpadMultiply': 0x37, 'AltLeft': 0x38, 'Space': 0x39,
  'CapsLock': 0x3A,
  'F1': 0x3B, 'F2': 0x3C, 'F3': 0x3D, 'F4': 0x3E,
  'F5': 0x3F, 'F6': 0x40, 'F7': 0x41, 'F8': 0x42,
  'F9': 0x43, 'F10': 0x44,
  'NumLock': 0x45, 'ScrollLock': 0x46,
  'Numpad7': 0x47, 'Numpad8': 0x48, 'Numpad9': 0x49,
  'NumpadSubtract': 0x4A, 'Numpad4': 0x4B, 'Numpad5': 0x4C,
  'Numpad6': 0x4D, 'NumpadAdd': 0x4E, 'Numpad1': 0x4F,
  'Numpad2': 0x50, 'Numpad3': 0x51, 'Numpad0': 0x52,
  'NumpadDecimal': 0x53,
  'F11': 0x57, 'F12': 0x58,
  'NumpadEnter': 0xE01C, 'ControlRight': 0xE01D,
  'NumpadDivide': 0xE035, 'PrintScreen': 0xE037,
  'AltRight': 0xE038, 'Home': 0xE047, 'ArrowUp': 0xE048,
  'PageUp': 0xE049, 'ArrowLeft': 0xE04B, 'ArrowRight': 0xE04D,
  'End': 0xE04F, 'ArrowDown': 0xE050, 'PageDown': 0xE051,
  'Insert': 0xE052, 'Delete': 0xE053,
  'MetaLeft': 0xE05B, 'MetaRight': 0xE05C, 'ContextMenu': 0xE05D,
  'Pause': 0xE11D45
};

export function setupRdpInputHandlers(canvas, getSession, { DeviceEvent, InputTransaction }) {
  const onKeyDown = (e) => {
    const session = getSession();
    if (!session) return;

    const scancode = SCANCODE_MAP[e.code];
    if (scancode === undefined) return;

    e.preventDefault();
    e.stopPropagation();

    try {
      const event = DeviceEvent.keyPressed(scancode);
      const tx = new InputTransaction();
      tx.addEvent(event);
      session.applyInputs(tx);
    } catch (err) {
      console.warn('[RDP Input] Key press error:', err);
    }
  };

  const onKeyUp = (e) => {
    const session = getSession();
    if (!session) return;

    const scancode = SCANCODE_MAP[e.code];
    if (scancode === undefined) return;

    e.preventDefault();
    e.stopPropagation();

    try {
      const event = DeviceEvent.keyReleased(scancode);
      const tx = new InputTransaction();
      tx.addEvent(event);
      session.applyInputs(tx);
    } catch (err) {
      console.warn('[RDP Input] Key release error:', err);
    }
  };

  const onMouseMove = (e) => {
    const session = getSession();
    if (!session) return;

    try {
      const rect = canvas.getBoundingClientRect();
      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;
      const x = Math.max(0, Math.min(canvas.width - 1, Math.round((e.clientX - rect.left) * scaleX)));
      const y = Math.max(0, Math.min(canvas.height - 1, Math.round((e.clientY - rect.top) * scaleY)));

      const event = DeviceEvent.mouseMove(x, y);
      const tx = new InputTransaction();
      tx.addEvent(event);
      session.applyInputs(tx);
    } catch (_) {}
  };

  const onMouseDown = (e) => {
    const session = getSession();
    if (!session) return;
    canvas.focus();
    e.preventDefault();

    try {
      const event = DeviceEvent.mouseButtonPressed(e.button);
      const tx = new InputTransaction();
      tx.addEvent(event);
      session.applyInputs(tx);
    } catch (err) {
      console.warn('[RDP Input] Mouse down error:', err);
    }
  };

  const onMouseUp = (e) => {
    const session = getSession();
    if (!session) return;
    e.preventDefault();

    try {
      const event = DeviceEvent.mouseButtonReleased(e.button);
      const tx = new InputTransaction();
      tx.addEvent(event);
      session.applyInputs(tx);
    } catch (err) {
      console.warn('[RDP Input] Mouse up error:', err);
    }
  };

  const onWheel = (e) => {
    const session = getSession();
    if (!session) return;
    e.preventDefault();

    try {
      if (e.deltaY !== 0) {
        const amount = e.deltaY > 0 ? -1 : 1;
        const event = DeviceEvent.wheelRotations(true, amount, 1);
        const tx = new InputTransaction();
        tx.addEvent(event);
        session.applyInputs(tx);
      }
      if (e.deltaX !== 0) {
        const amount = e.deltaX > 0 ? -1 : 1;
        const event = DeviceEvent.wheelRotations(false, amount, 1);
        const tx = new InputTransaction();
        tx.addEvent(event);
        session.applyInputs(tx);
      }
    } catch (err) {
      console.warn('[RDP Input] Wheel error:', err);
    }
  };

  const pointers = new Map();
  const mouseButtons = new Set();
  let scrolling = false;
  let scrollRemainder = 0;
  function buttonEvent(button, down) {
    const session = getSession();
    if (!session) return;
    const transaction = new InputTransaction();
    transaction.addEvent(down ? DeviceEvent.mouseButtonPressed(button) : DeviceEvent.mouseButtonReleased(button));
    session.applyInputs(transaction);
  }
  const onPointerDown = event => {
    if (!getSession() || (event.pointerType === 'touch' && canvas.dataset.touchMode === 'pan')) return;
    event.preventDefault();
    canvas.focus({ preventScroll: true });
    try { canvas.setPointerCapture?.(event.pointerId); } catch (_) {}
    if (event.pointerType !== 'touch') {
      onMouseMove(event); onMouseDown(event); mouseButtons.add(event.button); return;
    }
    const point = { x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY, moved: false, pressed: false, longPressed: false, timer: null };
    pointers.set(event.pointerId, point);
    if (pointers.size > 1) {
      scrolling = true;
      for (const pointer of pointers.values()) {
        clearTimeout(pointer.timer);
        if (pointer.pressed) { buttonEvent(0, false); pointer.pressed = false; }
      }
      return;
    }
    onMouseMove(event);
    point.timer = setTimeout(() => {
      if (point.moved || scrolling || !pointers.has(event.pointerId)) return;
      point.longPressed = true;
      buttonEvent(2, true); buttonEvent(2, false);
    }, 500);
  };
  const onPointerMove = event => {
    if (event.pointerType !== 'touch') { onMouseMove(event); return; }
    const point = pointers.get(event.pointerId);
    if (!point) return;
    event.preventDefault();
    const deltaY = event.clientY - point.y;
    point.x = event.clientX; point.y = event.clientY;
    if (scrolling) {
      scrollRemainder += deltaY;
      if (Math.abs(scrollRemainder) >= 16) {
        onWheel({ deltaY: -scrollRemainder, deltaX: 0, preventDefault() {} });
        scrollRemainder = 0;
      }
      return;
    }
    if (point.longPressed) return;
    if (Math.hypot(point.x - point.startX, point.y - point.startY) > 8) {
      clearTimeout(point.timer);
      if (!point.pressed) { buttonEvent(0, true); point.pressed = true; }
      point.moved = true;
      onMouseMove(event);
    }
  };
  const finishPointer = (event, canceled = false) => {
    if (event.pointerType !== 'touch') {
      if (canceled) { for (const button of mouseButtons) buttonEvent(button, false); mouseButtons.clear(); return; }
      if (mouseButtons.delete(event.button)) onMouseUp(event);
      return;
    }
    const point = pointers.get(event.pointerId);
    if (!point) return;
    clearTimeout(point.timer);
    if (point.pressed) buttonEvent(0, false);
    else if (!canceled && !scrolling && !point.longPressed) {
      onMouseMove(event); buttonEvent(0, true); buttonEvent(0, false);
    }
    pointers.delete(event.pointerId);
    if (!pointers.size) { scrolling = false; scrollRemainder = 0; }
  };
  const onPointerUp = event => finishPointer(event);
  const onPointerCancel = event => finishPointer(event, true);
  const releaseInputs = () => {
    for (const point of pointers.values()) { clearTimeout(point.timer); if (point.pressed) buttonEvent(0, false); }
    for (const button of mouseButtons) buttonEvent(button, false);
    pointers.clear(); mouseButtons.clear(); scrolling = false; scrollRemainder = 0;
    getSession()?.releaseAllInputs?.();
  };
  const onContextMenu = event => event.preventDefault();
  const listeners = { keydown: onKeyDown, keyup: onKeyUp, pointerdown: onPointerDown, pointermove: onPointerMove, pointerup: onPointerUp, pointercancel: onPointerCancel, lostpointercapture: onPointerCancel, blur: releaseInputs, contextmenu: onContextMenu };
  for (const [name, listener] of Object.entries(listeners)) canvas.addEventListener(name, listener);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  return () => {
    releaseInputs();
    for (const [name, listener] of Object.entries(listeners)) canvas.removeEventListener(name, listener);
    canvas.removeEventListener('wheel', onWheel);
  };
}

export function sendRdpCtrlAltDel(session, { DeviceEvent, InputTransaction }) {
  if (!session) return;
  try {
    const tx = new InputTransaction();
    // Ctrl + Alt + Del
    tx.addEvent(DeviceEvent.keyPressed(0x1D));   // ControlLeft
    tx.addEvent(DeviceEvent.keyPressed(0x38));   // AltLeft
    tx.addEvent(DeviceEvent.keyPressed(0xE053)); // Delete
    tx.addEvent(DeviceEvent.keyReleased(0xE053));
    tx.addEvent(DeviceEvent.keyReleased(0x38));
    tx.addEvent(DeviceEvent.keyReleased(0x1D));
    session.applyInputs(tx);
  } catch (err) {
    console.warn('[RDP] Failed to send Ctrl+Alt+Del:', err);
  }
}
